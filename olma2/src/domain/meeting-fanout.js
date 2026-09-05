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
async function meetingCalendarFanout(client, meetingId, recipients, basePayload, key) {
  const roles = await calendar.meetingCalendarRoles(client, meetingId);
  for (const uid of recipients) {
    await enqueue(client, {
      userId: uid, kind: 'meeting_confirmed', urgency: 'urgent',
      payload: { ...basePayload, calendarRole: calendarRoleFor(roles, uid) },
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
  if (res.data.meetingStatus === 'confirmed') {
    // The negotiation is over; a queued ask about any slot is moot — the
    // meeting_confirmed fan-out is what everyone should hear next.
    await supersedeQueuedMeetingRows(client, meetingId, ['meeting_slot_proposed']);
    const roles = await meetingCalendarFanout(client, meetingId, others, {
      meetingId: Number(meetingId), title: brief.title || 'meeting',
      slot: res.data.slot || brief.confirmed_slot, byName: actorName(actor),
    }, `mconf:${meetingId}`);
    res.data.hint = calendarHintFor(calendarRoleFor(roles, actor.id), Number(meetingId));
  } else if (res.data.proposedSlot) {
    // decline carried a counter → everyone else hears the NEW option. The asks
    // about the others are not cancelled: since options, those are still on
    // the table (the pending case never reaches here — a counter from a
    // non-initiator at a full table is a question for the initiator alone).
    if (res.data.pending) {
      await fanout(client, [Number(res.data.initiatorId || brief.initiator_id)].filter((id) => id !== Number(actor.id)),
        'meeting_option_pending', {
          meetingId: Number(meetingId), title: brief.title || 'meeting', slot: res.data.proposedSlot,
          startsAt: res.data.startsAt, optionId: res.data.optionId, byName: actorName(actor),
        }, { key: `mopt-pend:${meetingId}:${res.data.optionId}` });
      return res;
    }
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
  if (res.data.meetingStatus === 'confirmed') {
    // the exit completed the gate for everyone left
    await meetingCalendarFanout(client, meetingId,
      await activeParticipantsExcept(client, meetingId, actor.id), {
        meetingId: Number(meetingId), title: brief.title || 'meeting', slot: brief.proposed_slot,
      }, `mconf:${meetingId}`);
  }
  return res;
}

// After meetings.options.add (or proposeSlot) succeeded. An option on the
// table is a question for everyone else; a pending one is a question for the
// initiator alone, and the others hear nothing until it is approved.
async function afterOptionAdded(client, actor, meetingId, res) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  const o = res.data.option || { slotText: res.data.proposedSlot, startsAt: res.data.startsAt, id: res.data.optionId };
  const base = { meetingId: Number(meetingId), title: brief.title || 'meeting', slot: o.slotText, startsAt: res.data.startsAt || o.startsAt, optionId: o.id, byName: actorName(actor) };
  if (res.data.duplicate) {
    res.data.hint = 'That moment was already on the table — their yes to it was recorded instead of a second copy.';
    return res;
  }
  if (res.data.pending) {
    const initiator = Number(res.data.initiatorId || brief.initiator_id);
    await fanout(client, [initiator].filter((id) => id !== Number(actor.id)), 'meeting_option_pending', base,
      { key: `mopt-pend:${meetingId}:${o.id}` });
    res.data.hint = `The table already holds ${meetings.options.MAX_ACTIVE} options, so this one went to the initiator to approve or turn down — tell the user that, and that nothing else changes until then.`;
    return res;
  }
  const others = await activeParticipantsExcept(client, meetingId, actor.id);
  await fanout(client, others, 'meeting_slot_proposed', {
    ...base, reasons: await meetings.shareableConstraints(client, meetingId, actor.id),
  }, { key: `mopt:${meetingId}:${o.id}` });
  return res;
}

// After meetings.options.approve / reject. Approved: everyone else hears the
// new option exactly as they would any other. Rejected: only its proposer.
async function afterOptionDecision(client, actor, meetingId, res, { approved } = {}) {
  if (!res.ok) return res;
  const brief = await meetingBrief(client, meetingId);
  if (approved) {
    const others = await activeParticipantsExcept(client, meetingId, actor.id);
    await fanout(client, others, 'meeting_slot_proposed', {
      meetingId: Number(meetingId), title: brief.title || 'meeting', slot: res.data.slot,
      optionId: res.data.optionId, byName: actorName(actor), approvedFromPending: true,
    }, { key: `mopt:${meetingId}:${res.data.optionId}` });
    if (res.data.meetingStatus === 'confirmed') {
      await supersedeQueuedMeetingRows(client, meetingId, ['meeting_slot_proposed']);
      const roles = await meetingCalendarFanout(client, meetingId, others, {
        meetingId: Number(meetingId), title: brief.title || 'meeting',
        slot: res.data.confirmedSlot, byName: actorName(actor),
      }, `mconf:${meetingId}`);
      res.data.hint = calendarHintFor(calendarRoleFor(roles, actor.id), Number(meetingId));
    }
    return res;
  }
  await fanout(client, [Number(res.data.proposerId)].filter((id) => id !== Number(actor.id)), 'meeting_option_rejected', {
    meetingId: Number(meetingId), title: brief.title || 'meeting', slot: res.data.slot, byName: actorName(actor),
  }, { key: `mopt-rej:${meetingId}:${res.data.optionId}` });
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
  afterStart, afterOptionAdded, afterOptionDecision,
  afterSlotResponse, afterOptOut, afterRejoin,
  actorName, fanout, supersedeQueuedMeetingRows, activeParticipantsExcept,
  meetingCalendarFanout, calendarRoleFor, cancelCalendarCleanup, calendarHintFor,
  meetingBrief, CANCEL_CLEANUP_HINTS,
};
