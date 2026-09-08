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
const { enqueue } = require('../outbox/enqueue');

function actorName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.phone;
}

async function fanout(client, userIds, kind, payload, { urgency = 'urgent', key } = {}) {
  for (const uid of userIds) {
    await enqueue(client, {
      userId: uid, kind, payload, urgency,
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
      payload: {
        ...basePayload, calendarRole: calendarRoleFor(roles, uid),
        ...(extraFor ? extraFor(uid) : {}),
      },
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

// What to tell the confirming user's own agent, in their own turn.
function calendarHintFor(role, meetingId) {
  switch (role) {
    case 'organiser':
      return `Everyone is agreed. Work out the real start and end from the confirmed slot (full ISO-8601 WITH the user's UTC offset) and call create_shared_meeting_event meeting_id=${meetingId} — one shared event; the other participants get a Google invitation automatically. Tell the user you added it and that the others were invited. Their email addresses are visible to each other on the invitation, which is how calendar invitations work — mention it in passing, do not ask permission.`;
    case 'invitee':
      return 'Someone else is hosting the calendar event — tell the user an invitation will arrive in their Google Calendar shortly. Do not create an event yourself.';
    case 'solo':
      return 'Work out the real start and end from the confirmed slot (full ISO-8601 WITH their UTC offset) and call create_calendar_event to add it to their own calendar, then mention that you did.';
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
async function afterSettled(client, meetingId, res, { actor = null, byName = null, groupSubject = null } = {}) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  // Every queued question about this meeting is now a wrong question.
  await supersedeQueuedMeetingRows(client, meetingId,
    ['meeting_slot_proposed', 'meeting_option_removed', 'meeting_invite']);
  const everyone = await activeParticipants(client, meetingId);
  const recipients = actor ? everyone.filter((id) => id !== Number(actor.id)) : everyone;
  const withoutYes = new Set((res.data.withoutYes || []).map(Number));
  const settledBy = actor ? actorName(actor) : byName;
  const roles = await meetingCalendarFanout(client, meetingId, recipients, {
    meetingId: Number(meetingId), title: brief.title || 'meeting',
    slot: res.data.slot || brief.confirmed_slot,
    ...(settledBy ? { byName: settledBy, forced: true } : {}),
    ...(groupSubject ? { groupSubject } : {}),
  }, `mconf:${meetingId}`, (uid) => (withoutYes.has(Number(uid)) ? { settledWithoutYou: true } : {}));
  if (actor) res.data.hint = calendarHintFor(calendarRoleFor(roles, actor.id), Number(meetingId));
  return res;
}

async function meetingBrief(client, meetingId) {
  const { rows } = await client.query(
    `SELECT title, initiator_id, proposed_slot, confirmed_slot FROM meetings WHERE id = $1`, [meetingId]
  );
  return rows[0] || {};
}

// ---------------------------------------------------------------------------
// The two composites. Each takes the result of the domain call that already
// happened and does everything that follows from it.

// After meetings.respondToSlot succeeded. `res` is that result, mutated with a
// `hint` for the actor's own agent when there is one to give.
async function afterSlotResponse(client, actor, meetingId, res, { accept } = {}) {
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
      reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
    });
  } else if (!accept) {
    await fanout(client, [Number(brief.initiator_id)].filter((id) => id !== Number(actor.id)),
      'meeting_slot_declined', {
        meetingId: Number(meetingId), title: brief.title || 'meeting', byName: actorName(actor),
        reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
      });
  }
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
    res.data.hint = 'The meeting is still on for the others — say so. If it sits on this user\'s calendar, offer to take it off: their own event goes via delete_calendar_event; a Google invitation they decline from the calendar itself.';
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
  await fanout(client, [Number(brief.initiator_id)],
    res.data.meetingStatus === 'no_match' ? 'meeting_no_match' : 'meeting_opt_out', {
      meetingId: Number(meetingId), title: brief.title || 'meeting', byName: actorName(actor),
    }, { key: `mexit:${meetingId}:${actor.id}` });
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
  const base = { meetingId: Number(meetingId), title: brief.title || 'meeting', slot: o.slotText, startsAt: res.data.startsAt || o.startsAt, optionId: o.id, byName: actorName(actor) };
  if (res.data.duplicate) {
    res.data.hint = 'That moment was already on the table — their yes to it was recorded instead of a second copy.';
    return res;
  }
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  await fanout(client, others, 'meeting_slot_proposed', {
    ...base, reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
  }, { key: `mopt:${meetingId}:${o.id}` });
  return res;
}

// After meetings.options.remove. Two things follow from a time leaving the
// table, and only one of them is a message.
//
// The queued "does this work for you?" about that exact option is now a wrong
// question — the same rule as a superseded proposal, and the reason
// supersedeQueuedMeetingRows exists.
//
// The message goes to the people who had ANSWERED it, and to nobody else. They
// gave a yes or a no to a question that has been taken away, and their answer
// went with it; leaving them to notice a row missing is how a tally goes
// quietly wrong. Everybody else hears nothing, deliberately: the commonest
// delete is somebody taking back a time they typed a minute ago, and a
// coordination-wide announcement about that is the kind of message that
// teaches people to stop reading them.
async function afterOptionRemoved(client, actor, meetingId, res) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'superseded'
      WHERE sent_at IS NULL AND kind = 'meeting_slot_proposed'
        AND (payload->>'meetingId')::bigint = $1 AND (payload->>'optionId')::bigint = $2`,
    [meetingId, res.data.optionId]);
  await fanout(client, res.data.hadAnswered, 'meeting_option_removed', {
    meetingId: Number(meetingId), title: brief.title || 'meeting', slot: res.data.slot,
    byName: actorName(actor), optionsLeft: res.data.optionsLeft,
  }, { key: `mopt-del:${meetingId}:${res.data.optionId}` });
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

module.exports = {
  afterSettled,
  afterStart, afterOptionAdded, afterOptionRemoved,
  afterSlotResponse, afterOptOut, afterRejoin,
  actorName, fanout, supersedeQueuedMeetingRows, activeParticipantsExcept,
  meetingCalendarFanout, calendarRoleFor, cancelCalendarCleanup, calendarHintFor,
  meetingBrief, CANCEL_CLEANUP_HINTS,
};
