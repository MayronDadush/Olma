'use strict';
// Meeting coordination — the only cross-user scheduling path. The one rule
// enforced IN CODE, not in a prompt: status can only become 'confirmed' via
// tryConfirm, and only when every active (non-opted-out) participant is
// confirmed_current against the identical proposed_slot. No tool lets a model
// narrate a meeting into existence.
//
// No round cap: negotiation continues until confirm, initiator cancel, or
// opt-outs leave nobody. slot text = date+time+medium as ONE package.
const { ok, err } = require('./results');
const audit = require('./audit');
const grants = require('./grants');
const { hasOffset, badTime } = require('./datetime');

// How long a slot stays "live" after its start before the negotiation is
// closed as expired. Generous on purpose: the thing itself may still be
// happening, and a meeting confirmed an hour late is fine while a meeting
// closed an hour early is not.
const EXPIRE_AFTER_START_MS = 6 * 3600_000;
// Rows proposed before slots carried a start time (proposed_start_at IS NULL)
// cannot be dated at all. They stop being nudged about immediately — see
// pendingMeetingFor — and are closed once they are plainly abandoned.
const LEGACY_STALE_DAYS = 3;

async function startMeeting(client, initiatorId, title, participantUserIds) {
  if (!Array.isArray(participantUserIds) || participantUserIds.length === 0) {
    return err('invalid', 'at least one participant required');
  }
  const unique = [...new Set(participantUserIds)].filter((id) => id !== initiatorId);
  if (unique.length === 0) return err('invalid', 'participants must include someone other than you');

  for (const pid of unique) {
    const gate = await grants.requireFeatureBetween(client, initiatorId, pid, 'meetings');
    if (!gate.ok) return { ...gate, error: { ...gate.error, participantId: pid } };
  }

  const { rows } = await client.query(
    `INSERT INTO meetings (initiator_id, title) VALUES ($1, $2) RETURNING *`,
    [initiatorId, title || null]
  );
  const meeting = rows[0];
  for (const uid of [initiatorId, ...unique]) {
    await client.query(
      `INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1, $2)`,
      [meeting.id, uid]
    );
  }
  await audit.record(client, initiatorId, 'meeting.started', { meetingId: meeting.id, participants: unique });
  return ok({ meeting });
}

async function participantRow(client, meetingId, userId) {
  const { rows } = await client.query(
    `SELECT p.*, m.status AS meeting_status, m.proposed_slot, m.initiator_id
     FROM meeting_participants p JOIN meetings m ON m.id = p.meeting_id
     WHERE p.meeting_id = $1 AND p.user_id = $2`,
    [meetingId, userId]
  );
  return rows[0] || null;
}

// Constraints persist so nobody is asked about a day they already ruled out.
async function recordConstraint(client, userId, meetingId, text) {
  if (!text || !text.trim()) return err('invalid', 'constraint text required');
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  await client.query(
    `UPDATE meeting_participants SET constraints = constraints || $3::jsonb
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, JSON.stringify([text.trim()])]
  );
  await audit.record(client, userId, 'meeting.constraint_recorded', { meetingId });
  return ok({ meetingId });
}

// Any active participant may propose. Proposing implies agreeing to it:
// proposer → confirmed_current, everyone else active → awaiting.
//
// startsAt is the machine half of the slot and is REQUIRED. The text stays
// the thing people read ("יום שישי 20:00 אצל דני"); the timestamp is what
// lets anything in the system ask whether the moment has passed. Without it
// a dead slot looks exactly like a live one — which is how a Saturday
// check-in asked someone about Friday's poker game.
async function proposeSlot(client, userId, meetingId, slotText, startsAt) {
  if (!slotText || !slotText.trim()) return err('invalid', 'slot description required');
  if (!hasOffset(startsAt)) return badTime('starts_at', startsAt);
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  // A slot already in the past is a mistake at the moment it is made, and the
  // cheapest place to catch it is before it reaches anyone else's phone.
  if (new Date(startsAt).getTime() < Date.now()) {
    return err('invalid', 'that slot is already in the past — propose a future time',
      { reason: 'slot_in_past' });
  }

  await client.query(
    `UPDATE meetings SET proposed_slot = $2, proposed_start_at = $3, updated_at = now() WHERE id = $1`,
    [meetingId, slotText.trim(), startsAt]
  );
  await client.query(
    `UPDATE meeting_participants SET state = CASE WHEN user_id = $2 THEN 'confirmed_current' ELSE 'awaiting' END
     WHERE meeting_id = $1 AND state <> 'opted_out'`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.slot_proposed',
    { meetingId, slot: slotText.trim(), startsAt });
  return ok({ meetingId, proposedSlot: slotText.trim(), startsAt });
}

// The hard gate. Confirms only when every active participant has
// confirmed_current. Called from respondToSlot and applyExit only.
async function tryConfirm(client, meetingId) {
  const { rows } = await client.query(
    `SELECT m.id, m.proposed_slot, m.proposed_start_at,
            count(*) FILTER (WHERE p.state <> 'opted_out') AS active_count,
            count(*) FILTER (WHERE p.state = 'confirmed_current') AS confirmed_count
     FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE m.id = $1 AND m.status = 'negotiating'
     GROUP BY m.id`,
    [meetingId]
  );
  const s = rows[0];
  if (!s || !s.proposed_slot) return { confirmed: false };
  if (Number(s.active_count) < 2) return { confirmed: false }; // a meeting of one cannot confirm
  if (Number(s.active_count) !== Number(s.confirmed_count)) return { confirmed: false };
  await client.query(
    `UPDATE meetings SET status = 'confirmed', confirmed_slot = proposed_slot,
            confirmed_start_at = proposed_start_at,
            updated_at = now(), closed_at = now() WHERE id = $1`,
    [meetingId]
  );
  return { confirmed: true, slot: s.proposed_slot, startsAt: s.proposed_start_at };
}

async function respondToSlot(client, userId, meetingId, accept, counterProposal, counterStartsAt) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');
  if (!p.proposed_slot) return err('invalid', 'no slot has been proposed yet');

  if (accept) {
    await client.query(
      `UPDATE meeting_participants SET state = 'confirmed_current' WHERE meeting_id = $1 AND user_id = $2`,
      [meetingId, userId]
    );
    await audit.record(client, userId, 'meeting.slot_accepted', { meetingId, slot: p.proposed_slot });
    const c = await tryConfirm(client, meetingId);
    if (c.confirmed) {
      await audit.record(client, userId, 'meeting.confirmed', { meetingId, slot: c.slot });
      return ok({ meetingId, meetingStatus: 'confirmed', slot: c.slot });
    }
    return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'confirmed_current' });
  }

  await client.query(
    `UPDATE meeting_participants SET state = 'declined_current' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.slot_declined', { meetingId, slot: p.proposed_slot });
  if (counterProposal && counterProposal.trim()) {
    // Decline + counter in one move — immediately re-proposes, and the counter
    // needs its own start time for the same reason the first proposal did.
    return proposeSlot(client, userId, meetingId, counterProposal, counterStartsAt);
  }
  return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'declined_current' });
}

// Shared exit logic for opt_out AND connection-revoke. Initiator cannot exit
// their own meeting (must cancel). If exiting leaves fewer than 2 active
// participants, the meeting closes no_match.
async function applyExit(client, userId, meetingId, cause) {
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.initiator_id === userId) return err('invalid', 'initiator cannot opt out — cancel the meeting instead');
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
  // Remaining participants might now all agree on the current slot.
  const c = await tryConfirm(client, meetingId);
  if (c.confirmed) {
    await audit.record(client, userId, 'meeting.confirmed', { meetingId, slot: c.slot });
    return ok({ meetingId, meetingStatus: 'confirmed', yourState: 'opted_out' });
  }
  return ok({ meetingId, meetingStatus: 'negotiating', yourState: 'opted_out' });
}

async function optOut(client, userId, meetingId) {
  return applyExit(client, userId, meetingId, 'user_choice');
}

async function cancelMeeting(client, userId, meetingId) {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'cancelled', updated_at = now(), closed_at = now()
     WHERE id = $1 AND initiator_id = $2 AND status = 'negotiating' RETURNING id`,
    [meetingId, userId]
  );
  if (!rows[0]) return err('not_found', 'negotiating meeting you initiated not found');
  await audit.record(client, userId, 'meeting.cancelled', { meetingId });
  return ok({ meetingId, meetingStatus: 'cancelled' });
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
  return ok({ meeting: m.rows[0], participants: parts.rows });
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
  return ok({ pending: rows[0] || null });
}

// Close negotiations whose moment has passed. Until this existed nothing ever
// ended a meeting except confirmation, cancellation, or everyone leaving — so
// an unanswered proposal stayed 'negotiating' forever, and forever is how long
// it kept surfacing.
//
// Returns the rows it closed so the caller can tell the participants once.
// 'expired' rather than 'no_match': nobody disagreed, the moment simply passed.
async function expireStaleMeetings(client, now = Date.now()) {
  const { rows } = await client.query(
    `UPDATE meetings SET status = 'expired', updated_at = now(), closed_at = now()
      WHERE status = 'negotiating'
        AND (
          (proposed_start_at IS NOT NULL AND proposed_start_at < $1::timestamptz - make_interval(secs => $2))
          OR (proposed_start_at IS NULL AND updated_at < $1::timestamptz - make_interval(days => $3))
        )
      RETURNING id, title, initiator_id, proposed_slot`,
    [new Date(now).toISOString(), EXPIRE_AFTER_START_MS / 1000, LEGACY_STALE_DAYS]
  );
  for (const m of rows) {
    await audit.record(client, m.initiator_id, 'meeting.expired',
      { meetingId: Number(m.id), slot: m.proposed_slot });
  }
  return rows;
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
  await audit.record(client, rows[0].initiator_id, 'admin.meeting.expired',
    { meetingId: Number(meetingId), slot: rows[0].proposed_slot });
  return ok({ meeting: rows[0] });
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
  startMeeting, recordConstraint, proposeSlot, respondToSlot,
  optOut, applyExit, cancelMeeting, getStatus, listMine, pendingMeetingFor, tryConfirm,
  expireStaleMeetings, expireOne, listNegotiating, EXPIRE_AFTER_START_MS, LEGACY_STALE_DAYS,
};
