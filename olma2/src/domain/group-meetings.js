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
const options = require('./meeting-options');
const fanout = require('./meeting-fanout');
const groups = require('./groups');

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
// everybody — the gate is exactly this condition — so the filter is not
// redundant, it is what keeps this correct on the day the gate changes.
async function coordinatingMembers(client, groupId) {
  const rows = await groups.listMembers(client, groupId);
  return rows.filter((m) => m.user_id && m.last_inbound_at);
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
async function startCoordination(client, group, actingUser, title) {
  if (!group || group.state !== 'open') return err('forbidden', 'this group is not open');
  // Null acting member is a real state, not an error to paper over: the
  // gateway filed no sender for this turn, or the sender is not a user. Olma
  // has no one to hold the coordination, and guessing a member would hand one
  // person's name to a decision they never made.
  if (!actingUser) {
    return err('invalid', 'I cannot tell who asked for this — ask them to say it again in the group');
  }
  const members = await coordinatingMembers(client, group.id);
  if (!members.some((m) => Number(m.user_id) === Number(actingUser.id))) {
    return err('forbidden', 'that person is not a member of this group');
  }
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
  const started = await meetings.startMeeting(client, actingUser.id, finalTitle, others, { groupId: group.id });
  if (!started.ok) return started;
  const meeting = started.data.meeting;

  // The private fan-out. It carries the ROOM's name and the thing being
  // arranged, and nothing else about the group: not who else is in it, not who
  // asked, beyond the name the room already shows everyone.
  // Same kind, same idempotency shape and the same reader as a person-to-
  // person invite (channels/openclaw.js) — `groupSubject` is what makes that
  // reader say the room's name instead of a person's.
  await fanout.fanout(client, others, 'meeting_invite', {
    meetingId: Number(meeting.id), title: finalTitle,
    byName: memberLabel(members.find((m) => Number(m.user_id) === Number(actingUser.id)) || {}),
    groupSubject: group.subject || null,
  }, { key: `minvite:${meeting.id}` });

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
  const who = (id) => ({ name: labelByUser.get(Number(id)) || null, phone: phoneByUser.get(Number(id)) || null });

  const { rows: parts } = await client.query(
    `SELECT user_id, state FROM meeting_participants WHERE meeting_id = $1`, [meeting.id]);
  const active = parts.filter((p) => p.state !== 'opted_out').map((p) => Number(p.user_id));
  const optedOut = parts.filter((p) => p.state === 'opted_out').map((p) => who(p.user_id));

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

  return {
    coordination: {
      meetingId: Number(meeting.id), title: meeting.title, status: meeting.status,
      confirmedSlot: meeting.confirmed_slot || null,
      confirmedStartAt: meeting.confirmed_start_at || null,
      startedBy: who(meeting.initiator_id).name,
      participants: active.length,
      options: table,
      // The two the room actually asks about: nobody has heard from these
      // people at all, and these ones are out.
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

module.exports = {
  startCoordination, coordinationStatus, statusOf, settle,
  currentMeeting, coordinatingMembers, memberLabel,
};
