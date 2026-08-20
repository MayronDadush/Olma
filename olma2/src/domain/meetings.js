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
async function proposeSlot(client, userId, meetingId, slotText) {
  if (!slotText || !slotText.trim()) return err('invalid', 'slot description required');
  const p = await participantRow(client, meetingId, userId);
  if (!p) return err('not_found', 'not a participant of this meeting');
  if (p.meeting_status !== 'negotiating') return err('invalid', 'meeting is not negotiating');
  if (p.state === 'opted_out') return err('invalid', 'you opted out of this meeting');

  await client.query(
    `UPDATE meetings SET proposed_slot = $2, updated_at = now() WHERE id = $1`,
    [meetingId, slotText.trim()]
  );
  await client.query(
    `UPDATE meeting_participants SET state = CASE WHEN user_id = $2 THEN 'confirmed_current' ELSE 'awaiting' END
     WHERE meeting_id = $1 AND state <> 'opted_out'`,
    [meetingId, userId]
  );
  await audit.record(client, userId, 'meeting.slot_proposed', { meetingId, slot: slotText.trim() });
  return ok({ meetingId, proposedSlot: slotText.trim() });
}

// The hard gate. Confirms only when every active participant has
// confirmed_current. Called from respondToSlot and applyExit only.
async function tryConfirm(client, meetingId) {
  const { rows } = await client.query(
    `SELECT m.id, m.proposed_slot,
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
            updated_at = now(), closed_at = now() WHERE id = $1`,
    [meetingId]
  );
  return { confirmed: true, slot: s.proposed_slot };
}

async function respondToSlot(client, userId, meetingId, accept, counterProposal) {
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
    // Decline + counter in one move — immediately re-proposes.
    return proposeSlot(client, userId, meetingId, counterProposal);
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
async function pendingMeetingFor(client, userId) {
  // constraints ride along so the nudge that chases this person can check the
  // proposed slot against what they already said ("לא בבקרים") instead of
  // asking them to re-litigate their own words.
  const { rows } = await client.query(
    `SELECT m.id, m.title, m.proposed_slot, m.initiator_id, p.constraints
     FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id
     WHERE p.user_id = $1 AND p.state = 'awaiting' AND m.status = 'negotiating'
       AND m.proposed_slot IS NOT NULL
     ORDER BY m.updated_at LIMIT 1`,
    [userId]
  );
  return ok({ pending: rows[0] || null });
}

module.exports = {
  startMeeting, recordConstraint, proposeSlot, respondToSlot,
  optOut, applyExit, cancelMeeting, getStatus, listMine, pendingMeetingFor, tryConfirm,
};
