'use strict';
// The coordination a ROOM is running.
//
// This is the seam between the two halves of group mode. The room asks for
// something ("@עולמה תארגני לנו פאדל השבוע"), and from that moment the actual
// negotiation happens where it always has: privately, with each person, on the
// meeting tools their own agent already has. Nothing new is invented for the
// asking — a group coordination IS a meeting (domain/meetings.js,
// meeting-options.js), with `group_id` set and every member of the room in it.
//
// Two decisions of the owner's are encoded here and are worth reading before
// changing anything (2026-09-07):
//
//   1. The coordination belongs to the GROUP, not to the person who tagged
//      her. They are its `initiator_id` — somebody has to be able to settle it
//      — but every sentence anybody is sent names the room. "בקבוצה 'פאדל
//      חמישי' מתאמים משחק", not "דני מארגן משחק".
//   2. The room hears little and hears it rarely; the asking, the times and
//      the reasons all happen in private. So this module gives the room
//      exactly two things: how to start one, and where it stands.
//
// What crosses from private into the room, and what does not:
//   crosses      — that a member said yes or no to an option on the table, and
//                  who has not answered at all. That is the coordination
//                  itself; a room that cannot see it cannot coordinate.
//   never crosses — the REASON anybody gave. `meeting_participants.constraints`
//                  is prose written in a private chat ("בצילומים, מסיים
//                  מאוחר"); it is shared with the other PARTICIPANTS of a
//                  meeting one at a time, which is not the same act as reading
//                  it out to a room. Nothing here selects that column.
const { ok, err } = require('./results');
const audit = require('./audit');
const meetings = require('./meetings');
const calendar = require('./calendar');
const options = require('./meeting-options');
const fanout = require('./meeting-fanout');
const groups = require('./groups');
const pause = require('./pause');
const { mentionToken } = require('./proactive-text');

// What the room calls a member. The display name the group itself shows comes
// first, because that is the name the other people in the room use; their
// private first name is the fallback, and the phone is what is left when
// WhatsApp gave us neither (it is visible to everybody in the room anyway,
// which is why it is safe as a label here and nowhere else).
function memberLabel(row) {
  return row.display_name || row.first_name || row.phone;
}

// Members who can actually be in a coordination: a live roster row that
// resolves to a user who has written to her. In an OPEN group that is
// everybody — so this must be the GATE's question, asked by calling the gate,
// and for nine days it was a second copy of it that had drifted.
//
// The copy asked `last_inbound_at` alone. `groups.isConnected` asks
// `last_inbound_at OR opening_sent_at`, because two voices can hear somebody's
// first message and only their own agent stamps the first column — the fix
// that closed "היא שבורה" in the gate, and never reached here. A member who
// met the intake GREETER (every organic joiner does) opened the room and was
// then left out of the room's own coordination: never asked when they are
// free, never counted, and in a room of two the caller below answers "there is
// nobody else in this group to coordinate with" to a room with people in it
// (`incidents.md`, "The room coordinated without the person who opened it").
async function coordinatingMembers(client, groupId) {
  const rows = await groups.listMembers(client, groupId);
  return rows.filter((m) => groups.isConnected(m));
}

// The room's live coordination, if it has one. Only ever the newest: a room
// negotiating two things at once has no way to say which one it means, and
// `startCoordination` refuses to create the second.
async function currentMeeting(client, groupId, { includeClosed = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM meetings
      WHERE group_id = $1 ${includeClosed ? '' : "AND status = 'negotiating'"}
      ORDER BY id DESC LIMIT 1`, [groupId]);
  return rows[0] || null;
}

// Start one. `actingUser` is the member whose tag started this turn, chosen by
// the server (groups.actingMember) — never by the model.
async function startCoordination(client, group, actingUser, title, { where = null } = {}) {
  if (!group || group.state !== 'open') return err('forbidden', 'this group is not open');
  // Null acting member is a real state, not an error to paper over: the
  // gateway filed no sender for this turn, or the sender is not a user. Olma
  // has no one to hold the coordination, and guessing a member would hand one
  // person's name to a decision they never made.
  if (!actingUser) {
    return err('invalid', 'I cannot tell who asked for this — ask them to say it again in the group');
  }
  const everyone = await coordinatingMembers(client, group.id);
  if (!everyone.some((m) => Number(m.user_id) === Number(actingUser.id))) {
    return err('forbidden', 'that person is not a member of this group');
  }
  // A paused member whose pause already spent its one coordination message is
  // not counted in (owner, 2026-09-13; domain/pause.js). They either did not
  // answer it for a day or asked to stay paused, and either way a coordination
  // they never hear of must not sit in everybody's digest as waiting on them —
  // which is what the room did to Kapish. Scoped to who is SWEPT IN: whether
  // somebody is a member at all (settle, the check above) is not a question
  // their pause gets a say in.
  const members = everyone.filter((m) =>
    Number(m.user_id) === Number(actingUser.id) || !pause.roomInviteSpent(m));
  const others = members.map((m) => Number(m.user_id)).filter((id) => id !== Number(actingUser.id));
  if (!others.length) {
    return err('invalid', 'there is nobody else in this group to coordinate with');
  }

  const running = await currentMeeting(client, group.id);
  if (running) {
    // Not an error. The room asked her to arrange something and there is
    // already something being arranged — the answer is that one, not a second
    // table of times nobody can tell apart.
    return ok({ meeting: running, created: false, participants: members.length });
  }

  const finalTitle = (title || '').trim() || group.subject || 'תיאום';
  const started = await meetings.startMeeting(client, actingUser.id, finalTitle, others, { groupId: group.id, location: where });
  if (!started.ok) return started;
  const meeting = started.data.meeting;

  // The private fan-out. It carries the ROOM's name and the thing being
  // arranged, and nothing else about the group: not who else is in it, not who
  // asked, beyond the name the room already shows everyone.
  // Same kind, same idempotency shape and the same reader as a person-to-
  // person invite (channels/openclaw.js) — `groupSubject` is what makes that
  // reader say the room's name instead of a person's.
  const invitePayload = {
    meetingId: Number(meeting.id), title: finalTitle,
    byName: memberLabel(members.find((m) => Number(m.user_id) === Number(actingUser.id)) || {}),
    groupSubject: group.subject || null,
  };
  await fanout.fanout(client, others, 'meeting_invite', invitePayload,
    { key: `minvite:${meeting.id}` });

  // ── And the person who ASKED is asked too ──────────────────────────────────
  // `startMeeting` puts every participant in at `awaiting`, the initiator
  // included, and in a person-to-person coordination that is right: they are
  // in the conversation where they just said it, so their own times come back
  // in the same breath. A ROOM is the other case. מירון tagged her with
  // "תתאמי לנו פגישה שבוע הקרוב" and said nothing about when suits HIM —
  // there was no private turn in which he could have — so meeting 33 sat
  // `awaiting` on a man nobody was ever going to ask, and could not have
  // settled at any point (2026-09-19, `incidents.md`, "The coordination waited
  // on the man who started it"). Worse than stuck: מאיה's next digest told her
  // "מירון עדיין לא קבע איתך מועד — תיאום הפגישה תלוי בו", naming him as the
  // holdup for a question that was never put to him.
  //
  // Its own row and its own sentence, not a fourth name on the fan-out: what
  // reaches everybody else is "<name> asked for it there, in front of
  // everyone", and reading that about yourself is how a tool tells you it has
  // lost track of who you are. `askedItYourself` is the whole difference and
  // `channels/openclaw.js` is where it is spent.
  await fanout.fanout(client, [Number(actingUser.id)], 'meeting_invite',
    { ...invitePayload, askedItYourself: true }, { key: `minvite:${meeting.id}` });

  await audit.record(client, actingUser.id, 'group.coordination_started', {
    groupId: group.id, meetingId: Number(meeting.id), participants: members.length,
  });
  // The one question, asked once ever, and folded into the line she was going
  // to say anyway. It is asked HERE rather than at registration for two
  // reasons: this is the first moment the answer changes anything, and the
  // room is demonstrably listening — somebody just spoke to her. It is asked
  // in the room rather than privately because the answer is a fact ABOUT the
  // room that everyone in it can correct, and because we do not reliably know
  // who added her to it.
  const askKind = !groups.validKind(group.kind) && !group.kind_asked_at;
  if (askKind) await groups.noteKindAsked(client, group.id);
  return ok({ meeting, created: true, participants: members.length, askKind });
}

// Where it stands, in the room's terms. Answers only — never a reason.
async function coordinationStatus(client, group) {
  return statusOf(client, group, await currentMeeting(client, group.id, { includeClosed: true }));
}

// The same, for a meeting the caller already has. The sweep needs this one:
// it works from a list of coordinations that owe the room a sentence, and
// "the room's newest" is not the same meeting once a room has started its
// next one.
async function statusOf(client, group, meeting) {
  if (!meeting) return { coordination: null };
  const members = await groups.listMembers(client, group.id);
  const labelByUser = new Map(members.filter((m) => m.user_id).map((m) => [Number(m.user_id), memberLabel(m)]));
  const phoneByUser = new Map(members.filter((m) => m.user_id).map((m) => [Number(m.user_id), m.phone]));
  // `tag` is how a person is ADDRESSED in the room, and it is here so the model
  // never has to build one: the owner's rule (2026-09-20) is that in the room
  // people are tagged and not named — a tag pings, a name does not, and it is
  // also the name each viewer has saved for that number rather than the one we
  // hold. The label stays for the rooms and the people we have no phone for.
  // Who this coordination has actually REACHED. A row the gate dropped or is
  // still holding reached nobody, and the same shape answers this question for
  // a removal (`meeting-options.unheardRemovals`): sent, and not held. The kind
  // filter is not decoration — `meetingId` is on meeting payloads only, and the
  // cast would throw on the first row that put something else under that name.
  const { rows: heardRows } = await client.query(
    `SELECT DISTINCT user_id FROM outbox
      WHERE kind LIKE 'meeting\\_%' ESCAPE '\\'
        AND sent_at IS NOT NULL AND hold_reason IS NULL
        AND (payload->>'meetingId')::bigint = $1`, [meeting.id]);
  const heard = new Set(heardRows.map((r) => Number(r.user_id)));

  // `asked` is the difference between somebody ignoring her and somebody she
  // never got a word to: it is what the room may say out loud about a person
  // (owner, 2026-09-22), and it is false for anybody whose invite the gate
  // held for the night or dropped as quiet.
  const who = (id) => {
    const phone = phoneByUser.get(Number(id)) || null;
    return {
      name: labelByUser.get(Number(id)) || null, phone, tag: mentionToken(phone),
      asked: heard.has(Number(id)),
    };
  };

  const { rows: parts } = await client.query(
    `SELECT user_id, state FROM meeting_participants WHERE meeting_id = $1`, [meeting.id]);
  const active = parts.filter((p) => p.state !== 'opted_out').map((p) => Number(p.user_id));
  const optedOut = parts.filter((p) => p.state === 'opted_out').map((p) => who(p.user_id));

  // EVERY moment the table moved, for the room's own "השולחן זז" line: a time
  // added carries `created_at`, a time taken off carries `decided_at`, and
  // GREATEST ignores the null on the half that does not apply.
  //
  // The list and not only the newest, because the room waits a quarter of an
  // hour before it says the table moved (`group-voice.TABLE_SETTLE_MS`) and
  // the clock on that starts at the FIRST change the room has not heard about
  // — which is the one thing a `max()` throws away. It is bounded by the five
  // options a coordination may hold plus whatever has been taken off it.
  const { rows: changes } = await client.query(
    `SELECT GREATEST(created_at, decided_at) AS at FROM meeting_options
      WHERE meeting_id = $1 ORDER BY at`, [meeting.id]);
  const changedAts = changes.map((r) => r.at).filter(Boolean);
  const all = await options.list(client, Number(meeting.id));
  const onTable = all.filter((o) => o.status === 'active');
  const answeredSomething = new Set();
  const table = onTable.map((o) => {
    const yes = [], no = [];
    for (const [uid, answer] of Object.entries(o.answers || {})) {
      if (!active.includes(Number(uid))) continue;
      answeredSomething.add(Number(uid));
      (answer === 'y' ? yes : no).push(who(uid));
    }
    return {
      optionId: o.id, slot: o.slotText, startsAt: o.startsAt,
      yes, no, missing: active.filter((uid) => !(uid in (o.answers || {}))).map(who),
      // What that many yeses MEANS in this room — nothing at all until
      // somebody has said what kind of room it is (groups.quorumFor).
      quorum: groups.quorumFor(group, yes.length),
    };
  });

  // The option the coordination closed on, with who said yes to it — the
  // "סגור" line names them (owner, 2026-09-20: "מי שיכולים, או כולם").
  // confirmOn keeps `confirmed_slot` and clears `settling_option_id`, and
  // `options.add` refuses a duplicate slot text, so the text is the key.
  const confirmedOption = meeting.confirmed_slot
    ? table.find((o) => o.slot === meeting.confirmed_slot) || null
    : null;
  return {
    coordination: {
      meetingId: Number(meeting.id), title: meeting.title, status: meeting.status,
      confirmedSlot: meeting.confirmed_slot || null,
      confirmedStartAt: meeting.confirmed_start_at || null,
      confirmedOption,
      // The minute between the last yes and the announcement, and whether a
      // shared calendar event exists for it — both undefined when the caller
      // did not select them, which the room line treats as "no".
      settleDueAt: meeting.settle_due_at || null,
      calendarEventId: meeting.calendar_event_id || null,
      // Where, in the room's own words, or null — which the done line asks
      // about (owner, 2026-09-20: only when nobody said one).
      location: meeting.location === undefined ? null : (meeting.location || null),
      startedBy: who(meeting.initiator_id).name,
      tableChangedAt: changedAts.length ? changedAts[changedAts.length - 1] : null,
      tableChangedAts: changedAts,
      participants: active.length,
      // Members of the ROOM this coordination could not sweep in at all: they
      // have never written to her, so there is nobody to ask. A COUNT and never
      // people — who is missing is the gate notice's own sentence, and the room
      // hearing the same list in two voices is what this family of lines avoids.
      outside: members.filter((m) => !m.left_at && !groups.isConnected(m)).length,
      options: table,
      // The two the room actually asks about: nobody has heard from these
      // people at all, and these ones are out. `silent` stays the exact answer
      // to "who has answered nothing" — the model's `answered` count is
      // `participants - silent.length` — and each person carries `asked`, which
      // is what decides whether they may be NAMED.
      silent: active.filter((uid) => !answeredSomething.has(uid)).map(who),
      optedOut,
      // The room's own settings, so she never has to infer them from the
      // options: kind null means nobody has told her, and then there is no
      // true sentence about "enough people" available to say.
      kind: groups.validKind(group.kind) ? group.kind : null,
      minimum: group.quorum_min === null || group.quorum_min === undefined ? null : Number(group.quorum_min),
      maximum: group.quorum_max === null || group.quorum_max === undefined ? null : Number(group.quorum_max),
    },
  };
}

// Closing it, from the room. The coordination belongs to the room, so any
// member of the room may close it — in public, in front of everybody, which is
// the check that matters and the one a private tool cannot have. Underneath it
// is `options.settleNow` acting as the INITIATOR: the room stands in for the
// person who happens to hold that column, and the audit row records who
// actually said it.
//
// The one thing it will not do is close a game below its own minimum. That is
// not Olma overruling anybody: the minimum is a number the room gave her and
// can change (setKind), and a padel game with three people is not the thing
// they asked her to arrange. She says how many are short and lets them decide
// which of the two to move.
async function settle(client, group, actingUser, optionId) {
  if (!group || group.state !== 'open') return err('forbidden', 'this group is not open');
  if (!actingUser) {
    return err('invalid', 'I cannot tell who asked for this — ask them to say it again in the group');
  }
  const members = await coordinatingMembers(client, group.id);
  if (!members.some((m) => Number(m.user_id) === Number(actingUser.id))) {
    return err('forbidden', 'that person is not a member of this group');
  }
  const meeting = await currentMeeting(client, group.id);
  if (!meeting) return err('not_found', 'nothing is being coordinated in this group right now');

  const table = await options.list(client, Number(meeting.id));
  const chosen = table.find((o) => o.status === 'active' && Number(o.id) === Number(optionId));
  if (!chosen) return err('not_found', 'no such time on the table', { reason: 'option_not_active' });
  const yes = Object.values(chosen.answers || {}).filter((a) => a === 'y').length;
  const q = groups.quorumFor(group, yes);
  if (q.known && q.min !== null && !q.met) {
    return err('invalid',
      `that time has ${yes} of the ${q.min} this group needs — ${q.short} short. Either wait, or the group can change the number.`,
      { reason: 'below_minimum', yes, minimum: q.min, short: q.short });
  }

  const res = await options.settleNow(client, Number(meeting.initiator_id), Number(meeting.id), Number(optionId));
  if (!res.ok) return res;
  await audit.record(client, actingUser.id, 'group.coordination_settled', {
    groupId: group.id, meetingId: Number(meeting.id), optionId: Number(optionId), yes,
  });
  await fanout.afterSettled(client, Number(meeting.id), res, {
    byName: memberLabel(members.find((m) => Number(m.user_id) === Number(actingUser.id)) || {}),
    groupSubject: group.subject || null,
  });
  return res;
}

// ---- a paused member who did not answer -------------------------------------
// The other half of the one message a paused person gets (domain/pause.js).
// A day after it went out with no word back they are taken out of the
// coordination, so nobody's digest keeps saying it is waiting on them.
//
// Also catches the member who was already counted in before this existed and
// whose invite the gate dropped: paused, nothing about this meeting still on
// its way to them, a coordination a day old, and no invite of theirs inside
// the last 24 hours. The `NOT EXISTS` is what keeps a row held for their night
// or their quiet day from being overtaken by its own exit.
//
// Nobody is TOLD they left — "X left the meeting" would be false, they never
// said a word. Only when their leaving closes it (no_match) does the initiator
// hear, in the same words any exit that closes a meeting uses.
async function sweepSilentPausedMembers(client, nowMs = Date.now()) {
  const { rows } = await client.query(
    `SELECT p.meeting_id, p.user_id
       FROM meeting_participants p
       JOIN meetings mt ON mt.id = p.meeting_id
       JOIN users u ON u.id = p.user_id
      WHERE mt.group_id IS NOT NULL AND mt.status = 'negotiating'
        AND p.state <> 'opted_out' AND p.user_id <> mt.initiator_id
        AND u.paused_at IS NOT NULL
        AND mt.created_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
        AND (u.room_invite_sent_at IS NULL
             OR u.room_invite_sent_at < u.paused_at
             OR u.room_invite_sent_at <= $1::timestamptz - ($2::bigint * interval '1 millisecond'))
        AND NOT EXISTS (
          SELECT 1 FROM outbox o
           WHERE o.user_id = p.user_id AND o.sent_at IS NULL
             AND (o.payload->>'meetingId')::bigint = p.meeting_id)
      ORDER BY p.meeting_id, p.user_id
      LIMIT 50`,
    [new Date(nowMs), pause.ROOM_INVITE_ANSWER_MS]);
  const out = [];
  for (const r of rows) {
    const meetingId = Number(r.meeting_id);
    const res = await meetings.applyExit(client, Number(r.user_id), meetingId, 'paused_no_answer');
    if (!res.ok) continue;
    if (res.data.meetingStatus === 'no_match') {
      await fanout.supersedeQueuedMeetingRows(client, meetingId, ['meeting_slot_proposed', 'meeting_invite']);
      const { rows: [m] } = await client.query(
        `SELECT initiator_id, title FROM meetings WHERE id = $1`, [meetingId]);
      await fanout.fanout(client, [Number(m.initiator_id)], 'meeting_no_match', {
        meetingId, title: m.title || 'meeting',
      }, { key: `mexit:${meetingId}:${r.user_id}` });
    }
    out.push({ meetingId, userId: Number(r.user_id), meetingStatus: res.data.meetingStatus });
  }
  return out;
}

// The room says where ("אצל יוסי"), before or after the time is set. Written
// onto the meeting in the room's own words; when a shared calendar event
// already exists, its organiser's event gets the place too — through the
// same `calendar.updateEvent` a person's own edit goes through, as that
// person, because the event is on THEIR calendar (owner, 2026-09-20).
async function setPlace(client, group, actingUser, where, opts = {}) {
  if (!group || group.state !== 'open') return err('forbidden', 'this group is not open');
  if (!actingUser) {
    return err('invalid', 'I cannot tell who said this — ask them to say it again in the group');
  }
  const members = await coordinatingMembers(client, group.id);
  if (!members.some((m) => Number(m.user_id) === Number(actingUser.id))) {
    return err('forbidden', 'that person is not a member of this group');
  }
  const location = meetings.cleanLocation(where);
  if (!location) return err('invalid', 'where is required');
  const meeting = await currentMeeting(client, group.id, { includeClosed: true });
  if (!meeting || !['negotiating', 'confirmed'].includes(meeting.status)) {
    return err('not_found', 'nothing is being coordinated in this group right now');
  }
  await client.query(`UPDATE meetings SET location = $2, updated_at = now() WHERE id = $1`, [meeting.id, location]);
  await audit.record(client, actingUser.id, 'meeting.place_set', { meetingId: Number(meeting.id), groupId: group.id });
  let calendarUpdated = false;
  if (meeting.calendar_event_id && meeting.calendar_organiser_id) {
    const upd = await calendar.updateEvent(client, Number(meeting.calendar_organiser_id),
      { eventId: meeting.calendar_event_id, location }, opts);
    calendarUpdated = Boolean(upd.ok);
  }
  return ok({ meetingId: Number(meeting.id), location, calendarUpdated, status: meeting.status });
}

module.exports = {
  startCoordination, coordinationStatus, statusOf, settle, setPlace, sweepSilentPausedMembers,
  currentMeeting, coordinatingMembers, memberLabel,
};
