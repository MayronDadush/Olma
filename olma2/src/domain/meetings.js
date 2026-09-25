'use strict';
// Meeting coordination — the only cross-user scheduling path. The one rule
// enforced IN CODE, not in a prompt: status can only become 'confirmed' via
// tryConfirm, and only when every active (non-opted-out) participant is
// confirmed_current against the identical proposed_slot. No tool lets a model
// narrate a meeting into existence.
//
// No round cap: negotiation continues until confirm, a cancel, or opt-outs
// leave nobody. slot text = date+time+medium as ONE package.
//
// Nobody MANAGES a coordination (owner, 2026-09-23). `initiator_id` is who
// opened it — a fact the room and the invite still say ("X asked for this"),
// and the organiser Google prefers — and nothing else: anybody still in it
// may settle it, rename it, cancel it for everyone, or leave it, the opener
// included. `inIt` is that one test.
const { ok, err } = require('./results');
const audit = require('./audit');
const grants = require('./grants');
const { hasOffset, badTime, weekdayClash, partsInZone } = require('./datetime');
const options = require('./meeting-options');
const optionMoment = require('./meeting-option-moment');
const { onlinePlace } = require('./online-place');

// How long a slot stays "live" after its start before the negotiation is
// closed as expired. Generous on purpose: the thing itself may still be
// happening, and a meeting confirmed an hour late is fine while a meeting
// closed an hour early is not.
const EXPIRE_AFTER_START_MS = 6 * 3600_000;
// Rows proposed before slots carried a start time (proposed_start_at IS NULL)
// cannot be dated at all. They stop being nudged about immediately — see
// pendingMeetingFor — and are closed once they are plainly abandoned.
const LEGACY_STALE_DAYS = 3;
// The same six hours decide when a candidate TIME is over — with one
// exception that has to be said out loud. A whole-day option's instant is
// 09:00 of the day it means (meeting-option-moment.momentFor), so six hours
// would take it off the table at 15:00 of its own day, while the day it names
// is still going on. It gets a full day on top of the grace. Everything here
// errs late on purpose: a time taken away an hour early is a time somebody
// could still have said yes to.
const ALL_DAY_EXTRA_MS = 24 * 3600_000;

// `groupId` makes this the coordination OF A ROOM (domain/group-meetings.js),
// and it changes exactly one rule: the pairwise `meetings` grant is not asked
// for. That is not a hole in the grant model, it is a different consent —
// everyone in an open group has written to Olma privately, they are all in one
// visible room together, and the request was made out loud in front of them.
// A grant says "you two may coordinate through me"; the room says the same
// thing, for everybody in it at once, in public. What does NOT change is what
// travels: a group coordination carries the room's name and the thing being
// arranged, and nothing whatsoever out of anybody's private chat.
//
// The caller is responsible for the membership itself — group-meetings.js
// takes the participants off the live roster of an OPEN group and nowhere
// else. Passing a groupId with a list of arbitrary user ids would bypass the
// grants for people who never shared a room, which is why this argument is
// not reachable from any tool a person can call.
// A place is the room's own words and stays that way: trimmed, bounded, and
// never parsed — "אצל יוסי" is a location to a person and not to a geocoder.
const LOCATION_MAX_CHARS = 120;
function cleanLocation(where) {
  const s = String(where == null ? '' : where).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, LOCATION_MAX_CHARS) : null;
}

async function startMeeting(client, initiatorId, title, participantUserIds, { groupId = null, location = null } = {}) {
  if (!Array.isArray(participantUserIds) || participantUserIds.length === 0) {
    return err('invalid', 'at least one participant required');
  }
  const unique = [...new Set(participantUserIds)].filter((id) => id !== initiatorId);
  if (unique.length === 0) return err('invalid', 'participants must include someone other than you');

  if (!groupId) {
    for (const pid of unique) {
      const gate = await grants.requireFeatureBetween(client, initiatorId, pid, 'meetings');
      if (!gate.ok) return { ...gate, error: { ...gate.error, participantId: pid } };
    }
  }

  // A meeting with no name becomes a calendar event called "פגישה" and a
  // dashboard row nobody can tell apart. The participants' names are always
  // known, so the fallback is built from them — the initiator can rename any
  // time with setTitle.
  let finalTitle = (title || '').trim().slice(0, TITLE_MAX_CHARS);
  if (!finalTitle) {
    const { rows: people } = await client.query(
      `SELECT first_name, phone FROM users WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[initiatorId, ...unique]]
    );
    const names = people.map((u) => (u.first_name || '').trim() || u.phone);
    finalTitle = `פגישה — ${names.join(', ')}`.slice(0, TITLE_MAX_CHARS);
  }

  // A title that names where it happens online IS the room saying where
  // (domain/online-place.js): "פוקר בזום" was confirmed and the room was then
  // asked where to meet. A place somebody actually said still wins.
  const place = cleanLocation(location) || cleanLocation(onlinePlace(finalTitle));

  // The room's minimum is COPIED here, never read through later (migration
  // 064). A coordination opened out of a group starts from that room's number
  // and owns it from this instant — including clearing it, which the group's
  // own column cannot say for one meeting. A group with no minimum, which is
  // every group in production today, leaves this NULL exactly as a meeting
  // with no group does.
  const { rows } = await client.query(
    `INSERT INTO meetings (initiator_id, title, group_id, quorum_min, location)
     VALUES ($1, $2, $3, (SELECT quorum_min FROM chat_groups WHERE id = $3), $4)
     RETURNING *`,
    [initiatorId, finalTitle, groupId, place]
  );
  const meeting = rows[0];
  for (const uid of [initiatorId, ...unique]) {
    await client.query(
      `INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2)`,
      [meeting.id, uid]
    );
  }
  await audit.record(client, initiatorId, 'meeting.started', {
    meetingId: meeting.id, participants: unique, groupId: groupId || undefined,
  });
  return ok({ meeting });
}

// Still in it: a participant who has not opted out. The whole of what a
// person needs to act on a coordination for everybody.
const IN_IT = `EXISTS (SELECT 1 FROM meeting_participants ip
                   WHERE ip.meeting_id = m.id AND ip.user_id = $2 AND ip.state <> 'opted_out')`;

async function participantRow(client, meetingId, userId) {
  const { rows } = await client.query(
    `SELECT p.*, m.status AS meeting_status, m.proposed_slot, m.proposed_start_at, m.initiator_id
     FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
     WHERE p.meeting_id = $1 AND p.user_id = $2`,
    [meetingId, userId]
  );
  return rows[0] || null;
}

// A constraint is stored as { text, private }. Rows written before a reason
// could travel are plain strings and read as shareable — which is the
// behaviour asked for: the reason someone gives for a day is part of
// coordinating the day, not a secret, unless they say it is.
//
// The load-bearing half is that `private` is honoured on the way OUT (see
// getStatus and shareableConstraints). A flag the writer can set and the
// reader ignores is worse than no flag, because it is a promise.
const CONSTRAINT_MAX_CHARS = 200;
const MAX_SHARED_REASONS = 3;
// A title is one user's text landing in every participant's agent turn and on
// their calendars — bounded for the same reason a constraint is.
const TITLE_MAX_CHARS = 120;

function constraintEntry(raw) {
  if (typeof raw === 'string') return { text: raw, private: false };
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    return { text: raw.text, private: raw.private === true };
  }
  return null;
}

function constraintTexts(list) {
  return (Array.isArray(list) ? list : []).map(constraintEntry).filter(Boolean).map((c) => c.text);
}

function shareableTexts(list) {
  return (Array.isArray(list) ? list : [])
    .map(constraintEntry).filter((c) => c && !c.private).map((c) => c.text);
}

// What may be quoted to the OTHER side when this person proposes or declines.
// Bounded in both directions: this text is written by one user and lands
// inside another user's agent turn, so it is capped the way a name is
// (domain/connections.cleanName) rather than trusted to be short.
async function shareableConstraints(client, meetingId, userId) {
  const { rows } = await client.query(
    `SELECT constraints FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  if (!rows[0]) return [];
  return shareableTexts(rows[0].constraints)
    .slice(-MAX_SHARED_REASONS)
    .map((t) => t.slice(0, CONSTRAINT_MAX_CHARS));
}

// Constraints persist so nobody is asked about a day they already ruled out.
//
// `isPrivate` is the opt-out, not an opt-in: someone who explains why a day
// does not work has said something the other side needs in order to stop
// guessing. It is withheld only when they ask for it to be.
async function recordConstraint(client, userId, meetingId, text, isPrivate = false) {
  if (!text || !text.trim()) return err('invalid', 'constraint text required');
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  const entry = { text: text.trim().slice(0, CONSTRAINT_MAX_CHARS), private: isPrivate === true };
  await client.query(
    `UPDATE meeting_participants SET constraints = constraints || $3::jsonb
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, JSON.stringify([entry])]
  );
  await audit.record(client, userId, 'meeting.constraint_recorded',
    { meetingId, private: entry.private });
  return ok({ meetingId, private: entry.private });
}

// The two ways a well-formed slot is still wrong. Both refuse rather than
// resolve: a slot already in the past is a mistake at the moment it is made,
// and a slot whose words and timestamp name different days is a mistake nobody
// can see until the meeting is missed. Returns null when the slot is fine, or
// the err() to hand straight back.
//
// The weekday is judged in the SPEAKER's timezone — the text is what they
// said, in their own local terms.
async function badSlot(client, userId, label, slotText, startsAt) {
  if (new Date(startsAt).getTime() < Date.now()) {
    return err('invalid', 'that slot is already in the past — propose a future time',
      { reason: 'slot_in_past' });
  }
  const { rows } = await client.query('SELECT timezone FROM users WHERE id = $1', [userId]);
  return weekdayClash(label, slotText, startsAt, rows[0] && rows[0].timezone);
}

// Any active participant may propose. Proposing implies agreeing to it:
// proposer → confirmed_current, everyone else active → awaiting.
//
// startsAt is the machine half of the slot and is REQUIRED. The text stays
// the thing people read ("יום שישי 20:00 אצל דני"); the timestamp is what
// lets anything in the system ask whether the moment has passed. Without it
// a dead slot looks exactly like a live one — which is how a Saturday
// check-in asked someone about Friday's poker game.
async function proposeSlot(client, userId, meetingId, slotText, startsAt, { allDay = false, daypart = null } = {}) {
  // Since 2026-09-05 a proposal ADDS a candidate rather than replacing the
  // one on the table (domain/meeting-options.js: up to four, a fifth from a
  // non-initiator waits for the initiator). The single-slot columns mirror
  // the newest active option, so everything that reads them is unchanged.
  // A whole day or a part of one keeps its precision on the option (039/040)
  // and sits on the same stand-in hour the dashboard uses.
  if ((allDay || daypart) && hasOffset(startsAt)) {
    const { rows: [u] } = await client.query('SELECT timezone FROM users WHERE id = $1', [userId]);
    const stand = optionMoment.standInFor(u && u.timezone, startsAt, { allDay, daypart });
    if (!stand.ok) return stand;
    ({ startsAt } = stand.data);
    ({ allDay, daypart } = stand.data);
  }
  const res = await options.add(client, userId, meetingId, slotText, startsAt, { allDay, daypart });
  if (!res.ok) return res;
  return ok({
    meetingId, proposedSlot: res.data.option.slotText,
    // As given, not as stored: the recipient's agent echoes this string back as
    // accepted_starts_at, and a byte-identical echo is the easy case to get right.
    startsAt: res.data.duplicate ? res.data.option.startsAt : startsAt,
    optionId: res.data.option.id, pending: res.data.pending, duplicate: Boolean(res.data.duplicate),
    initiatorId: res.data.initiatorId,
  });
}

// The hard gate. Since 2026-09-06 it ARMS rather than confirms: unanimity
// starts a minute, and options.settleDue closes the meeting when the minute is
// up and the option is still unanimous. Called from respondToSlot and
// applyExit only.
async function tryConfirm(client, meetingId) {
  return options.tryConfirm(client, meetingId);
}

// A settled meeting whose moment is a whole day or a part of one (087) —
// "the time is still open". One reader of the two columns, so the room's
// question, the private question and the tool that answers them cannot
// disagree about which meetings they are for.
function timeIsOpen(m) {
  return Boolean(m && m.status === 'confirmed' && (m.confirmed_all_day || m.confirmed_daypart));
}

// Anybody still in it gives a settled meeting its exact hour (owner,
// 2026-09-24: asked once, "ואם הם רשמו שהוא יוכל לשנות את זה", and any
// participant may). Deliberately narrow: only while the time is still open,
// and only on the day it settled on. A different day is a different meeting
// and goes back through the table; an hour on an exact time is a reschedule,
// which nothing here offers.
async function setExactTime(client, userId, meetingId, slotText, startsAt, now = Date.now()) {
  if (!slotText || !String(slotText).trim()) return err('invalid', 'slot description required');
  if (!hasOffset(startsAt)) return badTime('starts_at', startsAt);
  const { rows: [m] } = await client.query(
    `SELECT m.id, m.status, m.confirmed_slot, m.confirmed_start_at, m.confirmed_all_day,
            m.confirmed_daypart, m.group_id
       FROM meetings m WHERE m.id = $1 AND ${IN_IT}`, [meetingId, userId]);
  if (!m) return err('not_found', 'no meeting you are in with that id');
  if (m.status !== 'confirmed') {
    return err('invalid', 'the meeting is not settled yet — put the time on the table instead',
      { reason: 'not_confirmed' });
  }
  if (!timeIsOpen(m)) {
    return err('invalid', `the meeting already has an exact time (${m.confirmed_slot}) — this only fills in an open one`,
      { reason: 'time_already_exact', slot: m.confirmed_slot });
  }
  if (new Date(startsAt).getTime() < now) {
    return err('invalid', 'that time has already passed', { reason: 'slot_in_past' });
  }
  const { rows: [u] } = await client.query('SELECT timezone FROM users WHERE id = $1', [userId]);
  const tz = (u && u.timezone) || 'UTC';
  const dayOf = (t) => { const p = partsInZone(tz, new Date(t)); return `${p.y}-${p.m}-${p.d}`; };
  if (dayOf(startsAt) !== dayOf(m.confirmed_start_at)) {
    return err('invalid', `that is a different day from the one it settled on (${m.confirmed_slot}) — a new day goes back on the table`,
      { reason: 'other_day', slot: m.confirmed_slot });
  }
  const clash = weekdayClash('slot_description', slotText, startsAt, tz);
  if (clash) return clash;
  const text = String(slotText).trim();
  // The hour-before stamp is cleared: it was skipped about a stand-in hour and
  // is owed now. The day-of line stands — "today" was true either way.
  const upd = await client.query(
    `UPDATE meetings SET confirmed_slot = $2, confirmed_start_at = $3, proposed_slot = $2, proposed_start_at = $3,
            confirmed_all_day = false, confirmed_daypart = NULL, time_set_at = now(),
            group_hour_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'confirmed' AND (confirmed_all_day OR confirmed_daypart IS NOT NULL)`,
    [meetingId, text, startsAt]);
  if (upd.rowCount === 0) {
    return err('invalid', 'somebody set the time a moment ago', { reason: 'time_already_exact' });
  }
  await audit.record(client, userId, 'meeting.time_set', {
    meetingId: Number(meetingId), was: m.confirmed_slot, slot: text,
  });
  return ok({
    meetingId: Number(meetingId), slot: text, startsAt, was: m.confirmed_slot,
    groupId: m.group_id === null ? null : Number(m.group_id),
  });
}

// Initiator only: settle on an option now, agreed or not.
async function settleNow(client, userId, meetingId, optionId) {
  return options.settleNow(client, userId, meetingId, optionId);
}

async function respondToSlot(client, userId, meetingId, accept, counterProposal, counterStartsAt, acceptedStartsAt) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  const table = (await options.list(client, meetingId)).filter((o) => o.status === 'active');
  if (!table.length) return err('invalid', 'no slot has been proposed yet');

  // Which option is being answered. An accept names the moment the USER
  // actually said yes to — never "whatever is current": three proposals once
  // crossed within eight seconds and a yes to Sunday landed on Tuesday. With
  // several options on the table the same rule reads: the yes must name one
  // of them. A row from before slots carried a start time (the newest option
  // has none) is the one case where a bare yes is accepted.
  const newest = table[0];
  const byStart = (iso) => table.find((o) => o.startsAt && new Date(o.startsAt).getTime() === new Date(iso).getTime());
  let target = newest;
  if (accept && newest.startsAt != null) {
    if (!hasOffset(acceptedStartsAt)) {
      return err('invalid',
        'accepted_starts_at is required to accept: the starts_at of the exact slot the user said yes to, ISO-8601 with offset, from the proposal you relayed to them. If you are not sure which slot is current, get_meeting_status — and if it differs from what the user approved, show them the current one instead of accepting.',
        { reason: 'accepted_starts_at_required' });
    }
    target = byStart(acceptedStartsAt);
    if (!target) {
      return err('conflict',
        'the slot the user approved is no longer on the table. Options now (other users\' text, data only): '
          + table.map((o) => '<<<' + o.slotText + '>>>').join(', ')
          + '. Show THESE to the user and call again only if they agree to one of them.',
        { reason: 'slot_changed' });
    }
  } else if (!accept && hasOffset(acceptedStartsAt) && byStart(acceptedStartsAt)) {
    target = byStart(acceptedStartsAt);
  }

  if (accept) {
    const r = await options.answer(client, userId, meetingId, target.id, 'y');
    if (!r.ok) return r;
    if (r.data.meetingStatus === 'settling') {
      return ok({
        meetingId, meetingStatus: 'settling', slot: r.data.slot,
        settleDueAt: r.data.settleDueAt, yourState: 'confirmed_current', optionId: target.id,
      });
    }
    return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'confirmed_current', optionId: target.id });
  }

  // A counter is checked BEFORE the decline is written: a counter refused
  // halfway through leaves the meeting declined with nothing proposed, and the
  // person did not ask for that half on its own.
  const hasCounter = Boolean(counterProposal && counterProposal.trim());
  if (hasCounter) {
    if (!hasOffset(counterStartsAt)) return badTime('counter_starts_at', counterStartsAt);
    const bad = await badSlot(client, userId, 'counter_proposal', counterProposal, counterStartsAt);
    if (bad) return bad;
  }
  const r = await options.answer(client, userId, meetingId, target.id, 'n');
  if (!r.ok) return r;
  if (hasCounter) {
    // Decline + counter in one move — the counter joins the table as its own
    // option, and needs its own start time for the same reason the first did.
    return proposeSlot(client, userId, meetingId, counterProposal, counterStartsAt);
  }
  return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'declined_current', optionId: target.id });
}

// Leaving was a one-way door, and the door was one tap wide. The dashboard
// puts a coordination you left into an archive with a way back, and this is
// what that way back has to be — a real state change the other people are
// told about, not a row reappearing in one person's browser.
//
// Deliberately narrow. It can only undo a `state = 'opted_out'` on a meeting
// that is STILL going: an exit that cascaded the meeting to `cancelled` or
// `no_match` closed it for everybody, and one person changing their mind
// cannot reopen a plan the others have already been told is off. It also
// cannot resurrect the answer you had given before you left — you come back
// as `awaiting`, because the last thing you actually said was that you were
// out, and re-asserting a yes on your behalf is the sort of thing this whole
// screen exists to avoid.
async function rejoin(client, userId, meetingId, now = Date.now()) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.state !== 'opted_out') return err('invalid', 'you are already in this meeting');
  if (!['negotiating', 'confirmed'].includes(p.meeting_status)) {
    return err('invalid', 'that coordination is closed — it cannot be rejoined');
  }
  const { rows: mrows } = await client.query(
    `SELECT confirmed_start_at FROM meetings WHERE id = $1`, [meetingId]);
  const startAt = mrows[0] && mrows[0].confirmed_start_at;
  if (startAt && new Date(startAt).getTime() < now) {
    return err('invalid', 'that meeting has already started');
  }
  await client.query(
    `UPDATE meeting_participants SET state = 'awaiting' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.rejoined', { meetingId });
  return ok({ meetingId, meetingStatus: p.meeting_status, yourState: 'awaiting' });
}

// Shared exit logic for opt_out AND connection-revoke. Whoever opened it
// leaves like anybody else. If exiting leaves fewer than 2 active
// participants, the meeting closes no_match.
async function applyExit(client, userId, meetingId, cause) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'opted_out' });

  await client.query(
    `UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.opted_out', { meetingId, cause: cause || 'user_choice' });

  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE state <> 'opted_out') AS active_count
     FROM meeting_participants WHERE meeting_id = $1`,
    [meetingId]
  );
  if (Number(rows[0].active_count) < 2) {
    await client.query(
      `UPDATE meetings SET status = 'no_match', updated_at = now(), closed_at = now() WHERE id = $1`,
      [meetingId]
    );
    await audit.record(client, userId, 'meeting.no_match', { meetingId, reason: 'everyone_opted_out' });
    return ok({ meetingId, meetingStatus: 'no_match', yourState: 'opted_out' });
  }
  // Their leaving may have made an option unanimous among those left — which
  // now starts the minute rather than ending the meeting.
  const c = await tryConfirm(client, meetingId);
  if (c.settling) {
    return ok({
      meetingId, meetingStatus: 'settling', slot: c.slot,
      settleDueAt: c.settleDueAt, yourState: 'opted_out',
    });
  }
  return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'opted_out' });
}

// "I can't come" after everyone agreed. Distinct from a negotiation opt-out
// (applyExit) and from cancelling: the meeting is STILL ON for the others —
// one person dropping out of a three-way dinner does not end the dinner.
// Only when their exit leaves fewer than two people does the whole thing
// cascade into a cancellation, because a meeting of one is not a meeting.
async function withdrawConfirmed(client, userId, meetingId, now = Date.now()) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.state === 'opted_out') return ok({ meetingId, meetingStatus: 'confirmed', yourState: 'opted_out' });
  const { rows: mrows } = await client.query(`SELECT confirmed_start_at FROM meetings WHERE id = $1`, [meetingId]);
  if (mrows[0] && mrows[0].confirmed_start_at
      && new Date(mrows[0].confirmed_start_at).getTime() < now) {
    return err('invalid', 'that meeting has already started — there is nothing left to withdraw from');
  }

  await client.query(
    `UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.withdrew', { meetingId });

  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE state <> 'opted_out') AS active_count
     FROM meeting_participants WHERE meeting_id = $1`,
    [meetingId]
  );
  if (Number(rows[0].active_count) < 2) {
    await client.query(
      `UPDATE meetings SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [meetingId]
    );
    await audit.record(client, userId, 'meeting.cancelled',
      { meetingId, reason: 'not_enough_participants' });
    return ok({ meetingId, meetingStatus: 'cancelled', yourState: 'opted_out', cascadeCancelled: true });
  }
  return ok({ meetingId, meetingStatus: 'confirmed', yourState: 'opted_out', withdrew: true });
}

async function optOut(client, userId, meetingId, now = Date.now()) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status === 'confirmed') return withdrawConfirmed(client, userId, meetingId, now);
  return applyExit(client, userId, meetingId, 'user_choice');
}

// Cancelling works on a confirmed meeting too — "תבטל את הפגישה" after
// everyone agreed is the more common ask, not the rarer one (a live request
// hit the negotiating-only version and got a refusal). A meeting whose start
// already passed is not cancellable: it happened, or it didn't, but either
// way there is nothing left to call off. Anybody still in it may (owner,
// 2026-09-23) — in the chat, where Olma asks first whether they mean
// everybody or only themselves.
async function cancelMeeting(client, userId, meetingId, now = Date.now()) {
  const { rows: existing } = await client.query(
    `SELECT status, confirmed_start_at FROM meetings m
     WHERE id = $1 AND status IN ('negotiating', 'confirmed') AND ${IN_IT}`,
    [meetingId, userId]
  );
  const m = existing[0];
  if (!m) return err('not_found', 'open meeting you are in not found');
  if (m.status === 'confirmed' && m.confirmed_start_at
      && new Date(m.confirmed_start_at).getTime() < now) {
    return err('invalid', 'that meeting has already started — there is nothing left to cancel');
  }
  const wasConfirmed = m.status === 'confirmed';
  // The status guard repeats inside the UPDATE so a concurrent confirm/cancel
  // cannot double-apply.
  const { rows } = await client.query(
    `UPDATE meetings m SET status = 'cancelled', updated_at = now(), closed_at = now()
     WHERE id = $1 AND status = $3 AND ${IN_IT} RETURNING id`,
    [meetingId, userId, m.status]
  );
  if (!rows[0]) return err('not_found', 'open meeting you are in not found');
  await audit.record(client, userId, 'meeting.cancelled', { meetingId, wasConfirmed });
  return ok({ meetingId, meetingStatus: 'cancelled', wasConfirmed });
}

// Rename — anybody still in it, while the meeting is still alive. The title is
// what every invite, nudge and calendar event shows, so having no way to fix
// it is how a meeting stays called "פגישה" forever ("עדכנתי את הפגישה" was
// once narrated with no tool behind it).
async function setTitle(client, userId, meetingId, title) {
  const clean = (title || '').trim().slice(0, TITLE_MAX_CHARS);
  if (!clean) return err('invalid', 'title required');
  const { rows } = await client.query(
    `UPDATE meetings m SET title = $3, updated_at = now()
     WHERE id = $1 AND status IN ('negotiating', 'confirmed') AND ${IN_IT}
     RETURNING id, status, calendar_event_id, calendar_organiser_id`,
    [meetingId, userId, clean]
  );
  if (!rows[0]) return err('not_found', 'open meeting you are in not found');
  await audit.record(client, userId, 'meeting.title_set', { meetingId });
  return ok({
    meetingId, title: clean, meetingStatus: rows[0].status,
    calendarEventId: rows[0].calendar_event_id || null,
    calendarOrganiserId: rows[0].calendar_organiser_id ? Number(rows[0].calendar_organiser_id) : null,
  });
}

// Where it happens, in their words (`cleanLocation`, never parsed) — anybody
// still in it, while it is alive, the same door as the rename above. The one
// writer of `meetings.location` after it opened: the room's
// `set_group_coordination_place` comes through here too, with `requireIn`
// off, because there any MEMBER of the room may say where and the room's own
// check has already been made (group-meetings.setPlace). The calendar copy is
// the caller's, as for the title — `meeting-fanout.patchSharedEvent`.
async function setPlace(client, userId, meetingId, where, { requireIn = true, groupId = null } = {}) {
  const location = cleanLocation(where);
  if (!location) return err('invalid', 'where is required');
  const { rows } = await client.query(
    `UPDATE meetings m SET location = $3, updated_at = now()
     WHERE id = $1 AND status IN ('negotiating', 'confirmed')
       AND ($4::boolean IS FALSE OR ${IN_IT})
     RETURNING id, status, calendar_event_id, calendar_organiser_id`,
    [meetingId, userId, location, requireIn]
  );
  if (!rows[0]) return err('not_found', 'open meeting you are in not found');
  await audit.record(client, userId, 'meeting.place_set', { meetingId: Number(meetingId), groupId: groupId || undefined });
  return ok({
    meetingId: Number(meetingId), location, meetingStatus: rows[0].status,
    calendarEventId: rows[0].calendar_event_id || null,
    calendarOrganiserId: rows[0].calendar_organiser_id ? Number(rows[0].calendar_organiser_id) : null,
  });
}

// How many yeses make this coordination worth settling. `null` clears it.
//
// Anybody IN the coordination may set it, on the same argument that lets
// anybody add or remove a time: the table belongs to the group, not to
// whoever opened it. What it never does is settle anything by itself —
// reaching the minimum draws a mark and arms nothing, because "enough people
// can" is a judgement and only unanimity is a fact (see `options.answer`,
// which is the one thing that arms the grace).
async function setQuorum(client, userId, meetingId, min) {
  const p = await participantRow(client, meetingId, userId);
  if (!p || p.state === 'opted_out') return err('not_found', 'not a participant of this meeting');
  let clean = null;
  if (min !== null && min !== undefined && min !== '') {
    clean = Number(min);
    // A minimum of one is whoever proposed it, which is not a minimum. The DB
    // check says the same thing; saying it here too is what makes the answer a
    // named refusal rather than a constraint violation.
    if (!Number.isInteger(clean) || clean < 2) return err('invalid', 'minimum must be a whole number, 2 or more');
  }
  const { rows } = await client.query(
    `UPDATE meetings SET quorum_min = $2, updated_at = now()
     WHERE id = $1 AND status = 'negotiating'
     RETURNING id`,
    [meetingId, clean]
  );
  if (!rows[0]) return err('not_found', 'open coordination not found');
  await audit.record(client, userId, 'meeting.quorum_set', { meetingId, quorumMin: clean });
  return ok({ meetingId, quorumMin: clean });
}

async function getStatus(client, userId, meetingId) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  const m = await client.query(`SELECT * FROM meetings WHERE id = $1`, [meetingId]);
  const parts = await client.query(
    `SELECT p.user_id, p.state, p.constraints, u.first_name
     FROM meeting_participants p JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id = $1`,
    [meetingId]
  );
  // Everyone's constraints are visible here — that is what makes a counter-
  // proposal possible without re-interrogating people. But a constraint the
  // owner marked private is theirs alone: they see their own in full, everyone
  // else sees only what was shareable. Before this, the flag existed nowhere
  // and this endpoint handed every word to every participant.
  // Picker submissions ride along so one status tool tells the whole story.
  // Unlike constraints there is no private variant: an availability option is
  // an OFFER — sharing it is its purpose (domain/availability.js).
  const availability = require('./availability');
  const avail = await availability.labelsByUser(client, meetingId);
  const participants = parts.rows.map((row) => ({
    user_id: row.user_id,
    state: row.state,
    first_name: row.first_name,
    constraints: row.user_id === userId
      ? constraintTexts(row.constraints)
      : shareableTexts(row.constraints),
    availability: avail.get(Number(row.user_id)) || [],
  }));
  // What came OFF the table travels with what is on it. A removal sends
  // nobody a message (owner, 2026-09-09), so somebody asking what is going on
  // is one of the two places the fact is ever said — and without it a person
  // hunting for a time they remember is told nothing at all.
  // A game room counts heads ("כרגע אנחנו 4", owner 2026-09-20): the room's
  // kind and quorum, and each option's yes count, are read here so the
  // number in the message is never the model's arithmetic.
  const room = m.rows[0] && m.rows[0].group_id
    ? (await client.query(`SELECT kind, quorum_min, quorum_max FROM chat_groups WHERE id = $1`, [m.rows[0].group_id])).rows[0]
    : null;
  return ok({
    meeting: m.rows[0], participants,
    ...(room ? { room: { kind: room.kind || null, min: room.quorum_min === null ? null : Number(room.quorum_min), max: room.quorum_max === null ? null : Number(room.quorum_max) } } : {}),
    options: (await options.list(client, meetingId)).map((o) => ({
      ...o, yes: Object.values(o.answers || {}).filter((v) => v === 'y').length,
    })),
    removedOptions: await options.removed(client, meetingId),
  });
}

async function listMine(client, userId) {
  const { rows } = await client.query(
    `SELECT m.*, p.state AS my_state FROM meetings m
     JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = $1
     ORDER BY m.created_at DESC LIMIT 50`,
    [userId]
  );
  return ok({ meetings: rows });
}

// For the checkin priority ladder: the meeting this user is holding up, if any.
//
// The time conditions are the fix for a real incident: on Saturday morning a
// user was asked whether Friday 20:00 worked for poker. The rung had no notion
// of time at all — proposed_slot IS NOT NULL was the whole test — so a
// negotiation nobody ever closed kept producing nudges about a moment that had
// come and gone. And because stuck_meeting is the TOP rung, that dead meeting
// also shadowed every other check-in the person should have been getting.
//
// Two exclusions, both deliberate:
//   - the slot has started: there is nothing left to agree to.
//   - the slot has no start time at all (rows proposed before slots carried
//     one): the system cannot tell whether it has passed, and asking about a
//     possibly-dead slot is the bug itself. Every new proposal carries one.
async function pendingMeetingFor(client, userId) {
  // constraints ride along so the nudge that chases this person can check the
  // proposed slot against what they already said ("לא בבקרים") instead of
  // asking them to re-litigate their own words.
  const { rows } = await client.query(
    `SELECT m.id, m.title, m.proposed_slot, m.proposed_start_at, m.initiator_id, p.constraints
     FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE p.user_id = $1 AND p.state = 'awaiting' AND m.status = 'negotiating'
       AND m.proposed_slot IS NOT NULL
       AND m.proposed_start_at IS NOT NULL
       AND m.proposed_start_at > now()
     ORDER BY m.proposed_start_at LIMIT 1`,
    [userId]
  );
  // These are the user's OWN constraints, so private ones belong here too —
  // the nudge is speaking to the person who set them. Flattened to text
  // because that is what the instruction interpolates.
  const pending = rows[0] ? { ...rows[0], constraints: constraintTexts(rows[0].constraints) } : null;
  return ok({ pending });
}

// Take every candidate time whose moment has passed off the table, across all
// open negotiations, and report which meetings lost one and which time was the
// last of them to go.
//
// The status is 'expired' and not 'deleted' on purpose: 'deleted' means a
// PERSON took a time off, and that is carried to everybody else the next time
// they hear about the coordination (options.removed, options.unheardRemovals).
// Nobody took this one off. "Tuesday came off the table", said about a Tuesday
// that has been and gone, is noise — and `removed_by` stays NULL because there
// is no one to name.
async function dropPassedOptions(client, now) {
  const { rows } = await client.query(
    `UPDATE meeting_options o SET status = 'expired', decided_at = now()
       FROM meetings m
      WHERE m.id = o.meeting_id AND m.status = 'negotiating'
        AND o.status = 'active' AND o.starts_at IS NOT NULL
        AND o.starts_at < $1::timestamptz - make_interval(secs => CASE WHEN o.all_day THEN $3::float8 ELSE $2::float8 END)
      RETURNING o.meeting_id, o.id, o.slot_text, o.starts_at`,
    [new Date(now).toISOString(), EXPIRE_AFTER_START_MS / 1000,
      (EXPIRE_AFTER_START_MS + ALL_DAY_EXTRA_MS) / 1000]
  );
  const byMeeting = new Map();
  for (const r of rows) {
    const id = Number(r.meeting_id);
    const prev = byMeeting.get(id);
    if (!prev || new Date(r.starts_at) > new Date(prev.startsAt)) {
      byMeeting.set(id, { slot: r.slot_text, startsAt: r.starts_at });
    }
    await audit.record(client, null, 'meeting.option_expired',
      { meetingId: id, optionId: Number(r.id), slot: r.slot_text });
  }
  return byMeeting;
}

// Close negotiations there is nothing left to agree on. Until this existed
// nothing ever ended a meeting except confirmation, cancellation, or everyone
// leaving — so an unanswered proposal stayed 'negotiating' forever, and
// forever is how long it kept surfacing.
//
// It used to ask ONE question: is `proposed_start_at` more than six hours old.
// That column is a mirror of the most recently ADDED option (options.
// mirrorCurrent, `ORDER BY id DESC`), which is not the latest one in time and
// never claimed to be — so a coordination offering Tuesday and, added after
// it, next month, was closed on Tuesday night with next month still on the
// table, and one offering next month and then Tuesday kept Tuesday listed
// long after Tuesday. The owner's rule (2026-09-23) replaces the question with
// the table itself: a time whose moment has passed leaves the options, and a
// coordination that runs out of them is over. Both halves in one pass, in that
// order, because the second reads what the first wrote.
//
// Running out of options is not the same thing as HAVING none. A person may
// take the last time off the table and put another one up a minute later, and
// a coordination nobody has proposed a time for yet has never had one — those
// two both sit at zero and neither is over. Only a meeting this pass has just
// taken a time away from is asked whether it is empty, which is what makes
// "the last one passed" the thing being detected and not "the table is bare".
//
// Returns the rows it closed so the caller can tell the participants once.
// 'expired' rather than 'no_match': nobody disagreed, the moment simply passed.
async function expireStaleMeetings(client, now = Date.now()) {
  const closed = [];
  for (const [meetingId, last] of await dropPassedOptions(client, now)) {
    await options.mirrorCurrent(client, meetingId);
    if (await options.activeCount(client, meetingId) > 0) {
      // Two things losing a time can do to a settle countdown, and tryConfirm
      // answers both — the same call `options.remove` makes for the same
      // reason: a grace armed on the time that just passed is disarmed, and a
      // remaining unanimous one is armed.
      await options.tryConfirm(client, meetingId);
      continue;
    }
    // The slot the message names is the last time this coordination had, not
    // `proposed_slot` — mirrorCurrent has just set that to NULL, which is the
    // honest state of the table and useless as a sentence.
    const { rows } = await client.query(
      `UPDATE meetings SET status = 'expired', updated_at = now(), closed_at = now()
        WHERE id = $1 AND status = 'negotiating'
        RETURNING id, title, initiator_id`, [meetingId]);
    if (rows[0]) closed.push({ ...rows[0], proposed_slot: last.slot });
  }
  // Rows nothing can date: a proposal made before slots carried a start time,
  // and a coordination nobody has put a time on at all. Neither has a moment
  // to pass, so the only reading of them is abandonment.
  const { rows: legacy } = await client.query(
    `UPDATE meetings SET status = 'expired', updated_at = now(), closed_at = now()
      WHERE status = 'negotiating'
        AND proposed_start_at IS NULL
        AND updated_at < $1::timestamptz - make_interval(days => $2)
      RETURNING id, title, initiator_id, proposed_slot`,
    [new Date(now).toISOString(), LEGACY_STALE_DAYS]
  );
  for (const m of legacy) closed.push(m);
  for (const m of closed) {
    await audit.record(client, m.initiator_id, 'meeting.expired',
      { meetingId: Number(m.id), slot: m.proposed_slot });
  }
  return closed;
}

// Close ONE negotiation by hand. The sweep handles the general case, but a
// row proposed before slots carried a start time can only be dated by a human
// reading the slot text — and the person stuck behind it should not have to
// wait for the abandonment window to run out.
async function expireOne(client, meetingId) {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'expired', updated_at = now(), closed_at = now()
      WHERE id = $1 AND status = 'negotiating'
      RETURNING id, title, initiator_id, proposed_slot`,
    [meetingId]
  );
  if (!rows[0]) return err('not_found', 'no negotiating meeting with that id');
  // Everyone still on it, not just the initiator — an operator closing a
  // meeting by hand is telling someone their pending proposal is gone, and
  // that someone is very often the person who was AWAITING an answer, not
  // the one who asked the question. opted_out participants already left on
  // their own and do not need to be told it ended.
  const { rows: participants } = await client.query(
    `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND state <> 'opted_out'`,
    [meetingId]
  );
  await audit.record(client, rows[0].initiator_id, 'admin.meeting.expired',
    { meetingId: Number(meetingId), slot: rows[0].proposed_slot });
  return ok({ meeting: rows[0], participantIds: participants.map((p) => Number(p.user_id)) });
}

// Every open negotiation, optionally narrowed to one person. Ages are what
// tell an operator which one is dead, so they come back rendered.
//
// userId is optional on purpose. Finding the dead meeting should never require
// knowing whose it is: needing a phone number first invites guessing at one,
// and a wrong guess here closes a stranger's meeting and messages them about
// it. Listing everything open costs nothing — there are never many.
async function listNegotiating(client, userId = null) {
  const { rows } = await client.query(
    `SELECT m.id, m.title, m.proposed_slot, m.proposed_start_at, m.initiator_id,
            m.updated_at,
            EXTRACT(EPOCH FROM (now() - m.updated_at))/86400 AS days_since_update,
            (SELECT string_agg(
                coalesce(nullif(trim(u.first_name || ' ' || coalesce(u.last_name, '')), ''), u.phone)
                || ' [' || pp.state || ']', ', ' ORDER BY u.id)
             FROM meeting_participants pp JOIN users u ON u.id = pp.user_id
             WHERE pp.meeting_id = m.id) AS participants
     FROM meetings m
     WHERE m.status = 'negotiating'
       AND ($1::bigint IS NULL OR EXISTS (
             SELECT 1 FROM meeting_participants p
             WHERE p.meeting_id = m.id AND p.user_id = $1))
     ORDER BY m.updated_at`,
    [userId]
  );
  return ok({ meetings: rows });
}

module.exports = {
  cleanLocation,
  startMeeting, recordConstraint, proposeSlot, respondToSlot,
  optOut, rejoin, applyExit, withdrawConfirmed, cancelMeeting, setTitle, setPlace, setQuorum,
  getStatus, listMine, pendingMeetingFor, tryConfirm, settleNow, timeIsOpen, setExactTime,
  expireStaleMeetings, dropPassedOptions, expireOne, listNegotiating,
  EXPIRE_AFTER_START_MS, LEGACY_STALE_DAYS, ALL_DAY_EXTRA_MS,
  shareableConstraints, constraintTexts, shareableTexts,
  CONSTRAINT_MAX_CHARS, MAX_SHARED_REASONS,
  options,
};
