'use strict';
// What happens to everybody ELSE when one person answers a meeting.
//
// This used to live inside the MCP tool handlers, which was fine while a tool
// call was the only way to answer one. It is not any more: the dashboard lets
// a person say yes, no, or "I'm out" with a tap, and that must produce exactly
// the same rows — the same fan-out, the same superseding of questions that are
// now wrong, the same shared calendar event — or the two faces of the system
// would slowly tell different people different things about the same meeting.
//
// So the domain function decides what CHANGED (domain/meetings.js) and this
// decides who has to hear about it. Neither knows which face it was called
// from, which is the point.
//
// One asymmetry is deliberate and worth naming: the person who ACTED gets no
// outbox row. In a chat turn they are already mid-conversation and the tool
// result is their notification, so instead they get a `hint` — a sentence for
// their own agent. On the dashboard nobody is mid-turn and the hint is simply
// unused. It is returned either way rather than decided here, because "was
// there an agent listening" is not a question this module can answer.
const calendar = require('./calendar');
const meetings = require('./meetings');
const optionMoment = require('./meeting-option-moment');
const { enqueue } = require('../outbox/enqueue');
const meetingTime = require('./meeting-time');
const { isoWithOffset } = require('./meeting-option-moment');

function actorName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.phone;
}

// Anything anybody hears about a coordination also carries what came OFF its
// table since they last heard from us (owner, 2026-09-09: a removal never gets
// a message of its own — "פשוט פעם הבאה שהם שואלים על הנושא או מקבלים עדכון על
// הנושא"). It is computed per recipient, at enqueue, because "since they last
// heard" is a different moment for each of them; `meetingId` on the payload is
// what says this row is about a coordination at all.
async function withRemovals(client, payload, userId) {
  if (!payload || payload.meetingId === undefined || payload.meetingId === null) return payload;
  const removedOptions = await meetings.options.unheardRemovals(client, payload.meetingId, userId);
  return removedOptions.length ? { ...payload, removedOptions } : payload;
}

// A question about a coordination that has NOT GONE OUT YET is the question
// that is going to be asked, so a new one folds into it instead of queueing
// behind it. Kapish's four rows — the room's invite plus three times added
// while the night held them — all released the moment he wrote in the room,
// and he read four messages in sixty-two seconds, each re-asking the same
// thing (`incidents.md`, "Four messages in sixty-two seconds"). Same rule
// the owner already gave for a time taken OFF the table: it never gets a
// message of its own, it rides the next thing that person hears.
//
// The OLDEST row survives, which is what keeps the framing right: an invite
// is the first thing somebody hears about a coordination ("the group is
// arranging X") and a bare slot row is not. `tableChanged` is what tells its
// delivery that the row is now about the TABLE rather than about the one slot
// its payload names — the times themselves are never copied in here, because
// the table can move again before this goes out and `get_meeting_status` is
// the only thing that knows what it holds at the moment of sending.
//
// One list, two jobs: these are the rows that WAIT (PACE_MS, below) and the
// rows a later one folds INTO. They have to be the same set — a kind that
// waits but cannot be folded into is a second message sitting beside the one
// the pacing just created, which is the thing being fixed.
const FOLDABLE_KINDS = ['meeting_invite', 'meeting_slot_proposed', 'meeting_rejoined'];

// `FOR UPDATE SKIP LOCKED`, because "not gone out yet" is not what `sent_at`
// says — it is what the worker holds. The worker locks a row for the whole of
// its delivery (payload read, model turn, send, stamp), and a row it holds has
// already been READ. On 2026-09-20 a fold landed on Yuval's invite mid-turn:
// this SELECT saw `sent_at IS NULL`, the UPDATE waited on the worker's lock,
// then wrote `tableChanged` onto a message that had already gone out — and the
// time it was carrying reached nobody. A row somebody else holds is skipped
// here and the addition gets its own row, as it would have had the fold not
// existed. The UPDATE re-asks `sent_at IS NULL` for the same reason.
async function foldIntoPendingQuestion(client, userId, meetingId) {
  const { rows } = await client.query(
    `SELECT id, payload FROM outbox
      WHERE sent_at IS NULL AND user_id = $1 AND kind = ANY($3)
        AND (payload->>'meetingId')::bigint = $2
      ORDER BY id
      FOR UPDATE SKIP LOCKED`,
    [userId, meetingId, FOLDABLE_KINDS]
  );
  if (!rows.length) return false;
  const keep = rows[0];
  // Recomputed rather than carried over: a removal that happened since this
  // row was written rides the next thing they hear, and this row IS it now.
  const payload = await withRemovals(client, { ...keep.payload, tableChanged: true }, userId);
  const upd = await client.query(
    `UPDATE outbox SET payload = $2 WHERE id = $1 AND sent_at IS NULL`,
    [keep.id, JSON.stringify(payload)]);
  if (upd.rowCount === 0) return false;
  // Anything that already piled up behind it (rows written before this fold
  // existed) is one message too many by the same argument.
  const extras = rows.slice(1).map((r) => r.id);
  if (extras.length) {
    await client.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = 'superseded' WHERE id = ANY($1)`,
      [extras]
    );
  }
  return true;
}

// A time said IN the room, by the person whose own private invite has not gone
// out yet (2026-09-23). That invite still says "the user has not said when
// suits THEM" — which stopped being true the moment their time went on the
// table in front of everyone. So it is told, on the row itself: an UPDATE of a
// row nothing has sent, exactly like the fold above, and a row already in the
// worker's hands (`FOR UPDATE SKIP LOCKED`) is left alone rather than rewritten
// under a send that may already have happened.
async function noteNamedInRoom(client, userId, meetingId) {
  const { rowCount } = await client.query(
    `UPDATE outbox SET payload = payload || '{"namedInRoom": true}'::jsonb
      WHERE id IN (
        SELECT id FROM outbox
         WHERE sent_at IS NULL AND user_id = $1 AND kind = 'meeting_invite'
           AND (payload->>'meetingId')::bigint = $2
         FOR UPDATE SKIP LOCKED)`,
    [userId, meetingId]);
  return rowCount > 0;
}

// A slot question for somebody whose invite never REACHED them is the invite,
// asked late. The gate dropped Kapish's (`quiet`, 2026-09-20), and the first
// thing he then read about the coordination was a bare "two times on the
// table" — not which room was arranging what, nor who asked. Same baseline the
// removals use (`options.unheardRemovals`): what counts is what was DELIVERED,
// and a row the gate dropped delivered nothing. Only a DROPPED invite qualifies
// — `sent_at` stamped with a `hold_reason` — because one still pending is the
// fold's (above), and one in flight is about to reach them on its own.
async function unheardInvite(client, userId, meetingId) {
  const { rows } = await client.query(
    `SELECT payload, sent_at, hold_reason FROM outbox
      WHERE user_id = $1 AND kind = 'meeting_invite'
        AND (payload->>'meetingId')::bigint = $2
      ORDER BY id DESC`,
    [userId, meetingId]
  );
  if (!rows.length || !rows.every((r) => r.sent_at && r.hold_reason)) return null;
  // The framing and nothing else: removals are recomputed at enqueue, and the
  // stamp is the caller's to put on.
  const p = rows[0].payload || {};
  const framing = { meetingId: p.meetingId, title: p.title, byName: p.byName };
  if (p.groupSubject) framing.groupSubject = p.groupSubject;
  if (p.askedItYourself) framing.askedItYourself = true;
  return framing;
}

// ── The negotiation moves faster than a person wants to be told about ───────
//
// The fold above is the whole answer to "several things happened, say them
// once", and on 2026-09-22 it almost never got to run. Miron opened a padel
// coordination at 16:11 and read five messages by 16:25 — the invite, a time
// somebody added, two people declining Wednesday a minute apart, and another
// time added. Every one of those rows was `urgent`, so each went out inside a
// minute, and by the time the next event arrived there was nothing left
// unsent to fold into. Kapish's four rows only ever folded because the NIGHT
// held them (`incidents.md`, "Four messages in sixty-two seconds"); nothing
// does that during the day.
//
// So a negotiation row waits until a quarter of an hour has passed since
// anything about THAT coordination actually reached THAT person, and the fold
// does the rest: everything that happens meanwhile lands in the one waiting
// row, which goes out carrying the table as it stands at the moment of
// sending. Measured on the box before the number was chosen — 46 of the 68
// consecutive coordination messages ever delivered landed inside fifteen
// minutes of the one before, 31 inside five; half an hour would have caught
// two more and is that much longer for a live question to sit.
//
// `release_after` rather than a gate hold: the row is not held, it is
// SCHEDULED, and it has never been looked at. The worker's picker already
// honours the column, so this needs nothing new anywhere else.
const PACE_MS = 15 * 60_000;

// Only what is still being negotiated waits — `FOLDABLE_KINDS`, above. A
// RESULT (it is closed, it is off, nobody matched, it expired) is the one
// message the person is actually waiting for, and holding that to save them a
// notification spends their patience on exactly the wrong thing.

// The baseline is what REACHED them (`sent_at` with no `hold_reason`), the
// same one the removals and the late invite already use: a row the gate
// dropped told them nothing, so it buys no quiet.
async function paceAfter(client, userId, meetingId) {
  const { rows } = await client.query(
    `SELECT max(sent_at) AS last FROM outbox
      WHERE user_id = $1 AND kind LIKE 'meeting%'
        AND sent_at IS NOT NULL AND hold_reason IS NULL
        AND (payload->>'meetingId')::bigint = $2`,
    [userId, meetingId]);
  const last = rows[0] && rows[0].last;
  if (!last) return null;
  const at = new Date(new Date(last).getTime() + PACE_MS);
  return at > new Date() ? at : null;
}

async function fanout(client, userIds, kind, payload, { urgency = 'urgent', key } = {}) {
  const aboutMeeting = FOLDABLE_KINDS.includes(kind) && payload
    && payload.meetingId !== undefined && payload.meetingId !== null;
  for (const uid of userIds) {
    if (aboutMeeting && await foldIntoPendingQuestion(client, uid, payload.meetingId)) continue;
    const releaseAfter = aboutMeeting ? await paceAfter(client, uid, payload.meetingId) : null;
    const framing = aboutMeeting ? await unheardInvite(client, uid, payload.meetingId) : null;
    if (framing) {
      await enqueue(client, {
        userId: uid, kind: 'meeting_invite', urgency, releaseAfter,
        payload: await withRemovals(client, { ...framing, tableChanged: true }, uid),
        idempotencyKey: key ? `${key}:${uid}:asinvite` : undefined,
      });
      continue;
    }
    await enqueue(client, {
      userId: uid, kind, payload: await withRemovals(client, payload, uid), urgency, releaseAfter,
      idempotencyKey: key ? `${key}:${uid}` : undefined,
    });
  }
}

// A queued, not-yet-delivered ask about a meeting state that no longer exists
// is a wrong question on its way to being asked: when three proposals crossed
// within eight seconds in a live meeting, each participant then received the
// whole parade — "does Saturday work?", "does Sunday 10:30 work?" — minutes
// after every one of those slots was already dead. A newer proposal (or the
// meeting closing) makes the queued rows moot, so they are cancelled the same
// way the dashboard cancels a message: UPDATE with a hold_reason, never
// DELETE, so the row still tells the story and nothing re-creates it.
async function supersedeQueuedMeetingRows(client, meetingId, kinds) {
  await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'superseded'
      WHERE sent_at IS NULL AND kind = ANY($2)
        AND (payload->>'meetingId')::bigint = $1`,
    [meetingId, kinds]
  );
}

async function activeParticipantsExcept(client, meetingId, exceptUserId) {
  const { rows } = await client.query(
    `SELECT user_id FROM meeting_participants
     WHERE meeting_id = $1 AND state <> 'opted_out' AND user_id <> $2`,
    [meetingId, exceptUserId]
  );
  return rows.map((r) => Number(r.user_id));
}

function calendarRoleFor(roles, userId) {
  if (!roles.shared) return roles.connectedIds.includes(Number(userId)) ? 'solo' : 'none';
  if (roles.organiserId === Number(userId)) return 'organiser';
  return roles.connectedIds.includes(Number(userId)) ? 'invitee' : 'none';
}

// A confirmed meeting becomes ONE shared calendar event when two or more
// participants have a calendar connected: the organiser's agent creates it and
// Google invites the rest. Each person's payload carries only their own role,
// so nobody's agent is told who else is connected.
//
// The confirming user is handled separately on purpose: they get no outbox row
// (they are mid-turn, and the tool result is their notification), so without a
// hint on that result the one person guaranteed to be present would be the one
// person never told to put it on their calendar. Observed live on meeting 1 —
// the accepter held the only connected calendar and was never prompted.
async function meetingCalendarFanout(client, meetingId, recipients, basePayload, key, extraFor = null) {
  const roles = await calendar.meetingCalendarRoles(client, meetingId);
  for (const uid of recipients) {
    await enqueue(client, {
      userId: uid, kind: 'meeting_confirmed', urgency: 'urgent',
      payload: await withRemovals(client, {
        ...basePayload, calendarRole: calendarRoleFor(roles, uid),
        ...(extraFor ? extraFor(uid) : {}),
      }, uid),
      idempotencyKey: `${key}:${uid}`,
    });
  }
  return roles;
}

// What a cancelled CONFIRMED meeting asks of each person's calendar, by their
// role. 'auto': the shared event is already gone and Google mails invitees a
// cancellation — nothing to do. 'self': an event may sit on their own
// calendar (a solo event they created, or a shared one the server failed to
// remove) — their agent should offer to take it off. 'none': no calendar.
function cancelCalendarCleanup(roles, removed, userId) {
  if (!roles) return 'none';
  const role = calendarRoleFor(roles, userId);
  if (role === 'none') return 'none';
  if ((role === 'organiser' || role === 'invitee') && removed) return 'auto';
  return 'self';
}

const CANCEL_CLEANUP_HINTS = {
  auto: 'The shared calendar event was already removed; Google mails the invitees a cancellation, so the calendars are handled.',
  self: 'If this meeting was added to the user\'s calendar, offer to remove it: find it with my_calendar_events and call delete_calendar_event (needs read_write; with view-only access, just tell them to remove it themselves).',
  none: '',
};

// What the person leaving a confirmed meeting is told about their calendar
// (calendar.removeMeetingAttendee's answer). Taken off → say so, that is the
// owner's line. No shared event of theirs → their own copy, if any, is still
// theirs to offer to delete. Anything that did not work is said as it is, and
// deleting the shared event is never offered: it would take it off everyone.
function withdrawCalendarHint(cal) {
  if (cal.removed) {
    return 'It has also been taken off their Google calendar — tell them that, in the same breath. Nobody else\'s calendar changed.';
  }
  if (['no_event', 'not_connected', 'not_on_event'].includes(cal.reason)) {
    return 'If they put it on their own calendar themselves, offer to take it off: find it with my_calendar_events and call delete_calendar_event.';
  }
  if (cal.reason === 'no_successor') {
    return 'It is still on their Google calendar: they host that event and nobody else in the meeting has a calendar that can, and deleting it would take it off everyone\'s. Say so plainly; do NOT offer to delete it.';
  }
  return 'Taking it off their Google calendar did not work just now — tell them it may still show there, and that they can decline it from the calendar itself. Do NOT delete the event: it is everyone\'s.';
}

// What to tell the confirming user's own agent, in their own turn.
function calendarHintFor(role, meetingId, { allDay = false, start = null } = {}) {
  const hint = calendarHintForRole(role, meetingId, start);
  return allDay && (role === 'organiser' || role === 'solo') ? `${hint}${calendar.ALL_DAY_EVENT}` : hint;
}

// `start` is the confirmed instant already written in the actor's own offset,
// or null when it cannot be known exactly (a daypart, a whole day) — then, and
// only then, the model reads it off the words.
function calendarHintForRole(role, meetingId, start = null) {
  const when = start
    ? `Start at exactly ${start} (already in the user's offset — never recompute it from the words) and work out the end from the confirmed slot`
    : 'Work out the real start and end from the confirmed slot (full ISO-8601 WITH the user\'s UTC offset)';
  switch (role) {
    case 'organiser':
      return `Everyone is agreed. ${when} and call create_shared_meeting_event meeting_id=${meetingId} — one shared event; the other participants get a Google invitation automatically. Tell the user you added it and that the others were invited. Their email addresses are visible to each other on the invitation, which is how calendar invitations work — mention it in passing, do not ask permission.`;
    case 'invitee':
      return 'Someone else is hosting the calendar event — tell the user an invitation will arrive in their Google Calendar shortly. Do not create an event yourself.';
    case 'solo':
      return `${when} and call create_calendar_event to add it to their own calendar, then mention that you did.`;
    default:
      return 'They have no calendar connected — offer once to connect it so meetings land there automatically, and drop it if they are not interested.';
  }
}

// What the person who just completed the agreement is told. They are the one
// human guaranteed to be present at this instant, and the one most likely to
// read a silence as a failure — so their agent hears that the silence is the
// feature, and what it is holding back.
function settlingHint(slot) {
  return `That was the last yes${slot ? ` — everyone is agreed on <<<${slot}>>>` : ''}. The meeting is not `
    + 'settled yet: it settles about a minute from now, and anybody who changes their answer inside that '
    + 'minute takes it back. Say it is agreed and will be confirmed in a moment; do not touch the calendar '
    + 'yet and do not call anything else — everyone, this user included, is told when it actually settles.';
}

// Every active participant, nobody excepted.
async function activeParticipants(client, meetingId) {
  const { rows } = await client.query(
    `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND state <> 'opted_out'`,
    [meetingId]
  );
  return rows.map((r) => Number(r.user_id));
}

// The meeting is over, told once, to everybody. Reached from exactly the two
// places that can end a negotiation: the sweep at the end of a grace (no
// actor, everyone gets a row) and the initiator settling by hand (their own
// turn carries the hint instead of a row).
//
// `withoutYes` is the difference the messages care about. A confirmation that
// says "everybody agreed" to somebody who never answered is a small lie told
// at the worst moment, so the people who were settled OVER are told that they
// were, and told they can still say they cannot make it.
// `actor` is somebody sitting in their own private turn: they get no outbox
// row (the tool result is their notification) and the calendar hint instead.
// A coordination settled in a GROUP has no such person — the acting member is
// mid-turn in the ROOM, where a calendar instruction would be useless — so
// that path passes `byName`/`groupSubject` and no actor, and everybody
// including the person who said it hears about it privately.
async function afterSettled(client, meetingId, res, { actor = null, byName = null, groupSubject = null, viaPage = false } = {}) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  // Every queued question about this meeting is now a wrong question.
  await supersedeQueuedMeetingRows(client, meetingId,
    ['meeting_slot_proposed', 'meeting_invite']);
  const everyone = await activeParticipants(client, meetingId);
  const recipients = actor ? everyone.filter((id) => id !== Number(actor.id)) : everyone;
  const withoutYes = new Set((res.data.withoutYes || []).map(Number));
  const settledBy = actor ? actorName(actor) : byName;
  const confirmedSlot = res.data.slot || brief.confirmed_slot;
  const moment = await slotMoment(client, meetingId, confirmedSlot);
  const asked = askedAboutTime(brief, everyone, actor);
  const roles = await meetingCalendarFanout(client, meetingId, recipients, {
    meetingId: Number(meetingId), title: brief.title || 'meeting',
    slot: confirmedSlot,
    // The instant itself, so nobody's agent re-derives the hour from the words
    // in THEIR offset — which put a meeting at the proposer's wall clock on the
    // calendar of anybody abroad (`meetingCalendarStep`).
    ...moment,
    ...(brief.location ? { location: brief.location } : {}),
    ...(brief.confirmed_all_day ? { allDay: true } : {}),
    ...(settledBy ? { byName: settledBy, forced: true } : {}),
    ...(groupSubject ? { groupSubject } : {}),
  }, `mconf:${meetingId}`, (uid) => ({
    ...(withoutYes.has(Number(uid)) ? { settledWithoutYou: true } : {}),
    ...(Number(uid) === asked ? { askExactTime: true } : {}),
  }));
  if (actor) {
    const exact = moment.startsAtUtc && actor.timezone
      && meetingTime.convertible({ startsAt: moment.startsAtUtc, slot: confirmedSlot, allDay: moment.allDay, daypart: moment.daypart })
      ? isoWithOffset(new Date(moment.startsAtUtc), actor.timezone) : null;
    res.data.hint = calendarHintFor(calendarRoleFor(roles, actor.id), Number(meetingId),
      { allDay: Boolean(brief.confirmed_all_day), start: exact });
    if (asked === Number(actor.id)) {
      if (viaPage) {
        // Settled from the page: there is no turn for a hint to land in, so
        // the one question goes out as a message of its own.
        await enqueue(client, {
          userId: asked, kind: 'meeting_exact_time_ask', urgency: 'urgent',
          payload: { meetingId: Number(meetingId), title: brief.title || 'meeting', slot: res.data.slot || brief.confirmed_slot },
          idempotencyKey: `mexact:${meetingId}:${asked}`,
        });
      } else {
        res.data.hint += ` ${optionMoment.exactTimeAsk(Number(meetingId))}`;
      }
    }
  }
  return res;
}

// What a slot text IS, for a reader on another clock (owner, 2026-09-25,
// פנתרה): the instant behind it, whether it names a clock at all, and whose
// clock the words were written on. The payload carries it so the private
// prompt can say the reader's own hour beside the proposer's words
// (`channels/openclaw.js`, `yourTimeClause`) — that builder has no database.
// Empty when the option cannot be found, which reads as "say nothing".
async function slotMoment(client, meetingId, slotText) {
  if (!slotText) return {};
  const { rows } = await client.query(
    `SELECT o.starts_at, o.all_day, o.daypart, u.timezone AS author_tz
       FROM meeting_options o LEFT JOIN users u ON u.id = o.added_by
      WHERE o.meeting_id = $1 AND o.slot_text = $2
      ORDER BY o.id DESC LIMIT 1`, [meetingId, slotText]);
  const r = rows[0];
  if (!r) return {};
  return {
    ...(r.starts_at ? { startsAtUtc: new Date(r.starts_at).toISOString() } : {}),
    ...(r.author_tz ? { authorTz: r.author_tz } : {}),
    ...(r.all_day ? { allDay: true } : {}),
    ...(r.daypart ? { daypart: r.daypart } : {}),
  };
}

// Who is asked whether they want an exact time, when a coordination settles
// on a whole day or a part of one (owner, 2026-09-24). ONE person, so two
// people cannot answer it two ways: whoever settled it by hand, and when
// agreement settled it, whoever opened it. A room's coordination asks nobody
// privately — the room is asked, on its "סגור" line (group-voice).
function askedAboutTime(brief, everyone, actor) {
  if (!meetings.timeIsOpen({ status: 'confirmed', ...brief }) || brief.group_id) return null;
  const pick = actor ? Number(actor.id) : Number(brief.initiator_id);
  if (everyone.includes(pick)) return pick;
  return everyone.length ? Math.min(...everyone) : null;
}

// Somebody gave a settled meeting its exact hour (meetings.setExactTime).
// The shared calendar event is moved as its organiser — the same door
// groupMeetings.setPlace uses — and everybody else hears it privately, with
// their own calendar role, since a solo event is theirs to move. `fromRoom`:
// said in the room, so the room has heard it and its line is stamped now.
async function afterTimeSet(client, actor, res, { fromRoom = false, opts = {} } = {}) {
  if (!res.ok) return res;
  const { meetingId } = res.data;
  const brief = await meetingBrief(client, meetingId);
  const { rows: [m] } = await client.query(
    'SELECT calendar_event_id, calendar_organiser_id FROM meetings WHERE id = $1', [meetingId]);
  let calendarUpdated = false;
  if (m && m.calendar_event_id && m.calendar_organiser_id) {
    // An hour, because the settled day said nothing about how long; the
    // organiser can stretch it on their own calendar.
    const end = new Date(new Date(res.data.startsAt).getTime() + 3600_000);
    const upd = await calendar.updateEvent(client, Number(m.calendar_organiser_id), {
      eventId: m.calendar_event_id, start: res.data.startsAt,
      end: isoLike(res.data.startsAt, end), clearDate: true,
    }, opts).catch(() => ({ ok: false }));
    calendarUpdated = Boolean(upd && upd.ok);
  }
  if (fromRoom) {
    await client.query('UPDATE meetings SET group_time_at = now() WHERE id = $1', [meetingId]);
  }
  // The question is answered, whoever answered it.
  await supersedeQueuedMeetingRows(client, meetingId, ['meeting_exact_time_ask']);
  const roles = await calendar.meetingCalendarRoles(client, meetingId);
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  for (const uid of others) {
    await enqueue(client, {
      userId: uid, kind: 'meeting_time_set', urgency: 'urgent',
      payload: await withRemovals(client, {
        meetingId: Number(meetingId), title: brief.title || 'meeting',
        slot: res.data.slot, was: res.data.was, byName: actorName(actor),
        calendarRole: calendarRoleFor(roles, uid), calendarUpdated,
        ...(brief.group_subject ? { groupSubject: brief.group_subject } : {}),
      }, uid),
      idempotencyKey: `mtime:${meetingId}:${uid}`,
    });
  }
  res.data.calendarUpdated = calendarUpdated;
  return res;
}

// The end of an event in the same offset the start was written in, so the
// calendar reads it as the person's own hour.
function isoLike(startIso, end) {
  const off = /([+-]\d{2}:\d{2}|Z)$/.exec(String(startIso));
  if (!off || off[1] === 'Z') return end.toISOString();
  const sign = off[1][0] === '-' ? -1 : 1;
  const [h, mi] = off[1].slice(1).split(':').map(Number);
  const local = new Date(end.getTime() + sign * (h * 60 + mi) * 60_000);
  return `${local.toISOString().slice(0, 19)}${off[1]}`;
}

async function meetingBrief(client, meetingId) {
  // The room's name rides along for a coordination a room started, so a
  // proposal about it can be counted like a game invite is
  // (`channels/openclaw.js`, ROOM_COUNT).
  const { rows } = await client.query(
    `SELECT m.title, m.initiator_id, m.proposed_slot, m.confirmed_slot, m.location, g.subject AS group_subject,
            m.group_id, m.confirmed_all_day, m.confirmed_daypart
       FROM meetings m LEFT JOIN chat_groups g ON g.id = m.group_id WHERE m.id = $1`, [meetingId]
  );
  return rows[0] || {};
}

// ---------------------------------------------------------------------------
// The two composites. Each takes the result of the domain call that already
// happened and does everything that follows from it.

// After meetings.respondToSlot succeeded. `res` is that result, mutated with a
// `hint` for the actor's own agent when there is one to give.
// `accept` is still passed by all four callers and is deliberately not read:
// a yes and a no now produce the same fan-out — whatever the ANSWER did to the
// table, told to the people the table is still a question for — and a
// parameter kept in the signature says that reading it again is a decision,
// not an oversight.
async function afterSlotResponse(client, actor, meetingId, res, _opts = {}) {
  const brief = await meetingBrief(client, meetingId);
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  if (res.data.meetingStatus === 'settling') {
    // Their yes was the last one. NOBODY is told yet — that is the entire
    // point of the grace: the announcement is what cannot be taken back, so
    // it waits with everything else until options.settleDue makes it.
    res.data.hint = settlingHint(res.data.slot);
  } else if (res.data.proposedSlot) {
    // decline carried a counter → everyone else hears the NEW option. The asks
    // about the others are not cancelled: since options, those are still on
    // the table. A counter at a FULL table never reaches here — the domain
    // refuses it and the refusal names the five, because the question then is
    // which one it replaces and only a person can answer that.
    await fanout(client, others, 'meeting_slot_proposed', {
      meetingId: Number(meetingId), title: brief.title || 'meeting',
      slot: res.data.proposedSlot, startsAt: res.data.startsAt, byName: actorName(actor),
      ...(await slotMoment(client, meetingId, res.data.proposedSlot)),
      reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
    });
  }
  // A plain decline used to be a message of its own to whoever opened the
  // coordination, and it is not one any more (owner, 2026-09-22: "אין צורך
  // שמי שפתח את התיאום יקבל הודעות מיוחדות"). Two of Miron's five messages
  // that afternoon were this — יובל and שחרון turning down the same Wednesday,
  // sixty-three seconds apart, one message each. Opening a coordination is not
  // a subscription to every answer in it: the table he is shown already says
  // how many people are on each time, and he hears it the next time the
  // coordination has something to ask him. Nothing is lost that the person
  // could act on, and the one thing that IS his alone — that it died, that
  // nobody matched, that it expired — still reaches him on its own.
  return res;
}

// After meetings.optOut succeeded.
// The others were told this person was out. Not telling them they are back
// would leave everyone holding a tally that is quietly wrong — and the tally
// is the entire content of this screen.
async function afterRejoin(client, actor, meetingId, res) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  await fanout(client, others, 'meeting_rejoined', {
    meetingId: Number(meetingId), title: brief.title || 'meeting',
    byName: actorName(actor),
  }, { key: `mrejoin:${meetingId}:${actor.id}` });
  res.data.hint = 'They are back in and have not answered yet — the others were told.';
  return res;
}

async function afterOptOut(client, actor, meetingId, res) {
  const brief = await meetingBrief(client, meetingId);
  const others = await activeParticipantsExcept(client, meetingId, actor.id);

  // "I can't come" from a confirmed meeting: everyone still going hears it,
  // framed as the meeting continuing — one exit is not a cancellation.
  if (res.data.withdrew) {
    await fanout(client, others, 'meeting_withdrawn', {
      meetingId: Number(meetingId), title: brief.title || 'meeting',
      byName: actorName(actor), slot: brief.confirmed_slot,
    }, { key: `mwithdraw:${meetingId}:${actor.id}` });
    // Off THEIR calendar, and only theirs (owner, 2026-09-24) — never the
    // event, never anybody else's copy (calendar.removeMeetingAttendee).
    const cal = (await calendar.removeMeetingAttendee(client, meetingId, actor.id)).data;
    res.data.calendar = cal;
    res.data.hint = `The meeting is still on for the others — say so. ${withdrawCalendarHint(cal)}`;
    return res;
  }

  // Their exit left fewer than two people, so the confirmed meeting is off for
  // everyone — same cleanup as an initiator cancellation.
  if (res.data.cascadeCancelled) {
    await supersedeQueuedMeetingRows(client, meetingId, ['meeting_slot_proposed', 'meeting_invite']);
    const roles = await calendar.meetingCalendarRoles(client, meetingId);
    const removal = await calendar.removeMeetingEvent(client, meetingId);
    for (const uid of others) {
      await enqueue(client, {
        userId: uid, kind: 'meeting_cancelled', urgency: 'urgent',
        payload: {
          meetingId: Number(meetingId), title: brief.title || 'meeting',
          byName: actorName(actor), wasConfirmed: true, slot: brief.confirmed_slot,
          calendarCleanup: cancelCalendarCleanup(roles, removal.data.removed, uid),
        },
        idempotencyKey: `mcanc:${meetingId}:${uid}`,
      });
    }
    res.data.hint = `The meeting is cancelled for everyone — with you out, not enough people remain. ${removal.data.removed
      ? CANCEL_CLEANUP_HINTS.auto
      : CANCEL_CLEANUP_HINTS.self}`;
    return res;
  }

  // Negotiation-phase exit — except that a meeting which just closed
  // (no_match) or confirmed has no live questions left.
  if (res.data.meetingStatus !== 'negotiating') {
    await supersedeQueuedMeetingRows(client, meetingId,
      res.data.meetingStatus === 'no_match'
        ? ['meeting_slot_proposed', 'meeting_invite'] : ['meeting_slot_proposed']);
  }
  // Somebody stepping OUT of one that carries on is an update like any other
  // and not a message of its own (owner, 2026-09-22; see the decline in
  // `afterSlotResponse`). Nor, since 2026-09-23, is `no_match` — the
  // coordination ending with nobody to match: nobody manages one, so there is
  // no single person it belongs to, and whoever is left reads it in their
  // next digest (digest.closedMeetings) rather than as an interruption.
  if (res.data.meetingStatus === 'settling') {
    // Their exit left the rest agreed. Same silence as any other arming: the
    // people left are about to be told once, a minute from now.
    res.data.hint = 'Their leaving left everyone else agreed on one time, so the meeting settles on its own '
      + 'shortly and all of them are told then. Nothing more for this user to do.';
  }
  return res;
}

// After meetings.options.add (or proposeSlot) succeeded. An option on the
// table is a question for everyone else.
async function afterOptionAdded(client, actor, meetingId, res) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  const o = res.data.option || { slotText: res.data.proposedSlot, startsAt: res.data.startsAt, id: res.data.optionId };
  const base = { meetingId: Number(meetingId), title: brief.title || 'meeting', slot: o.slotText, startsAt: res.data.startsAt || o.startsAt, optionId: o.id, byName: actorName(actor),
    ...(brief.group_subject ? { groupSubject: brief.group_subject } : {}) };
  if (res.data.duplicate) {
    res.data.hint = 'That moment was already on the table — their yes to it was recorded instead of a second copy.';
    return res;
  }
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  await fanout(client, others, 'meeting_slot_proposed', {
    ...base, ...(await slotMoment(client, meetingId, o.slotText)),
    reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
  }, { key: `mopt:${meetingId}:${o.id}` });
  return res;
}

// After meetings.options.remove. It tells nobody — that is the owner's rule
// (2026-09-09), and the reason is that the commonest removal is somebody taking
// back a time they typed a minute ago. What a removal DOES produce is a fact
// that travels: `withRemovals` puts it on the next thing each person hears
// about this coordination, and `getStatus` has it for anyone who asks.
//
// What is not optional is the queued "does this work for you?" about that exact
// option, which is now a question about a time nobody can answer — superseded
// on the same rule as any dead proposal.
async function afterOptionRemoved(client, actor, meetingId, res) {
  if (!res.ok) return res;
  await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'superseded'
      WHERE sent_at IS NULL AND kind = 'meeting_slot_proposed'
        AND (payload->>'meetingId')::bigint = $1 AND (payload->>'optionId')::bigint = $2`,
    [meetingId, res.data.optionId]);
  // Removing the first of two unanimous options leaves the second one holding
  // everyone's yes, so this path can arm the grace like any answer can.
  if (res.data.meetingStatus === 'settling') res.data.hint = settlingHint(res.data.settlingSlot);
  return res;
}

// After meetings.startMeeting succeeded: every invited person hears about it.
async function afterStart(client, actor, res, participantIds, title) {
  if (!res.ok) return res;
  await fanout(client, participantIds, 'meeting_invite', {
    meetingId: Number(res.data.meeting.id), title: title || res.data.meeting.title || 'meeting', byName: actorName(actor),
  }, { key: `minvite:${res.data.meeting.id}` });
  return res;
}

// A rename or a place said after the shared event exists: the calendar copy
// follows it (best-effort, as the organiser, server-side), so the event does
// not keep the stale words for ever. One copy for the chat and the room —
// `res` is the ok result of `meetings.setTitle` / `meetings.setPlace`, which
// carry the event and its organiser, and `fields` is what the event takes
// (`{ title }` or `{ location }`). Never fails the write it follows.
async function patchSharedEvent(client, res, fields, opts = {}) {
  if (!res || !res.ok || !res.data.calendarEventId || !res.data.calendarOrganiserId) {
    if (res && res.ok) res.data.calendarUpdated = false;
    return res;
  }
  const patched = await calendar.updateEvent(client, res.data.calendarOrganiserId,
    { eventId: res.data.calendarEventId, ...fields }, opts).catch(() => null);
  res.data.calendarUpdated = Boolean(patched && patched.ok);
  return res;
}

// The opener calling a coordination off, for everyone — and everything that
// has to go with it. Lived inside the cancel_meeting tool until the personal
// page needed the same door (a two-person coordination deleted from the list,
// 2026-09-23); one copy, so the page and the chat cannot tell people different
// things about the same cancellation.
async function cancelAndTell(client, actor, meetingId) {
  const brief = await meetingBrief(client, meetingId);
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  const res = await meetings.cancelMeeting(client, actor.id, meetingId);
  if (!res.ok) return res;
  // Nothing about this meeting should still be on its way to anyone.
  await supersedeQueuedMeetingRows(client, meetingId, ['meeting_slot_proposed', 'meeting_invite']);
  // A confirmed meeting is on calendars; take the shared event off first
  // (best-effort, server-side) so most people have nothing left to do.
  let roles = null, removed = false;
  if (res.data.wasConfirmed) {
    roles = await calendar.meetingCalendarRoles(client, meetingId);
    removed = (await calendar.removeMeetingEvent(client, meetingId)).data.removed;
  }
  for (const uid of others) {
    await enqueue(client, {
      userId: uid, kind: 'meeting_cancelled', urgency: 'urgent',
      payload: {
        meetingId: Number(meetingId), title: brief.title || 'meeting',
        byName: actorName(actor), wasConfirmed: Boolean(res.data.wasConfirmed),
        slot: brief.confirmed_slot || undefined,
        calendarCleanup: cancelCalendarCleanup(roles, removed, uid),
      },
      idempotencyKey: `mcanc:${meetingId}:${uid}`,
    });
  }
  const hint = CANCEL_CLEANUP_HINTS[cancelCalendarCleanup(roles, removed, actor.id)];
  if (hint) res.data.hint = hint;
  return res;
}

module.exports = {
  afterTimeSet,
  afterSettled, cancelAndTell, patchSharedEvent,
  afterStart, afterOptionAdded, afterOptionRemoved, noteNamedInRoom,
  afterSlotResponse, afterOptOut, afterRejoin,
  actorName, fanout, supersedeQueuedMeetingRows, activeParticipantsExcept,
  meetingCalendarFanout, calendarRoleFor, cancelCalendarCleanup, calendarHintFor,
  meetingBrief, slotMoment, CANCEL_CLEANUP_HINTS,
};
