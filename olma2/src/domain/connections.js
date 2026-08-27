'use strict';
// Connections — the mutual-consent base layer every cross-user feature gates
// on. Two entry states in one machine: target already a user → pending_target;
// target unknown → invited (intake sends the intro message, Phase E).
//
// revokeConnection is THE cascade: everything that leaned on the connection
// dies with it, atomically — live shares revoked, grants deleted, and a
// negotiating meeting whose only two sides are this pair is treated as the
// revoker opting out. Nothing keeps working "in the air" after a revoke.
const { ok, err } = require('./results');
const audit = require('./audit');
const usersDomain = require('./users');

async function activeConnectionBetween(client, userIdA, userIdB) {
  const { rows } = await client.query(
    `SELECT * FROM connections
     WHERE status = 'active'
       AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))`,
    [userIdA, userIdB]
  );
  return rows[0] || null;
}

async function requestConnection(client, requesterId, targetPhone, { reason, message } = {}) {
  if (!/^\+\d{7,15}$/.test(targetPhone || '')) return err('invalid', 'target phone must be E.164');
  const requester = await usersDomain.getById(client, requesterId);
  if (requester.phone === targetPhone) return err('invalid', 'cannot connect to yourself');

  // The name is the whole content of the intro the other person gets. Without
  // one it falls back to the raw phone number, and a real recipient got exactly
  // that: "+972502205854 sent a connection request" — telling him nothing about
  // who was asking or why he should say yes. A first name is required; the last
  // name is asked for but not enforced, because most people here have never
  // given one and a hard gate would block them from connecting at all.
  if (!requester.first_name) {
    return err('invalid', 'we need your name before asking someone to connect', {
      reason: 'requester_name_missing',
    });
  }

  const target = await usersDomain.getByPhone(client, targetPhone);
  if (target) {
    const existing = await activeConnectionBetween(client, requesterId, target.id);
    if (existing) return err('conflict', 'already connected', { connectionId: existing.id });
  }
  const status = target ? 'pending_target' : 'invited';
  let row;
  try {
    const { rows } = await client.query(
      `INSERT INTO connections (requester_id, target_id, target_phone, status, invite_reason, invite_message)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [requesterId, target ? target.id : null, targetPhone, status, reason || null, message || null]
    );
    row = rows[0];
  } catch (e) {
    if (e.code === '23505') return err('conflict', 'a live request to this person already exists');
    throw e;
  }
  await audit.record(client, requesterId, 'connection.requested', {
    connectionId: row.id, targetPhone, targetKnown: Boolean(target), reason: reason || null,
  });
  return ok({ connection: row, targetKnown: Boolean(target) });
}

// Called when an invited stranger has just been provisioned — links their new
// user row to the invite and moves the state machine forward.
async function attachProvisionedTarget(client, connectionId, targetUserId) {
  const { rows } = await client.query(
    `UPDATE connections SET target_id = $2, status = 'pending_target'
     WHERE id = $1 AND status = 'invited' RETURNING *`,
    [connectionId, targetUserId]
  );
  if (!rows[0]) return err('not_found', 'invited connection not found');
  return ok({ connection: rows[0] });
}

async function listPendingFor(client, userId) {
  const { rows } = await client.query(
    `SELECT c.*, u.first_name AS requester_first_name, u.last_name AS requester_last_name, u.phone AS requester_phone
     FROM connections c JOIN users u ON u.id = c.requester_id
     WHERE c.target_id = $1 AND c.status = 'pending_target'
     ORDER BY c.invited_at`,
    [userId]
  );
  return ok({ pending: rows });
}

async function respondToConnection(client, targetUserId, connectionId, decision) {
  if (!['approve', 'decline'].includes(decision)) return err('invalid', 'decision must be approve|decline');
  const { rows } = await client.query(
    `UPDATE connections SET status = $3, responded_at = now()
     WHERE id = $1 AND target_id = $2 AND status = 'pending_target'
     RETURNING *`,
    [connectionId, targetUserId, decision === 'approve' ? 'active' : 'declined']
  );
  if (!rows[0]) return err('not_found', 'pending connection not found');
  await audit.record(client, targetUserId, `connection.${decision === 'approve' ? 'approved' : 'declined'}`, {
    connectionId, requesterId: rows[0].requester_id,
  });
  if (decision === 'approve') {
    // Approving the friendship is the consent moment: every feature comes on
    // for both sides right here, so the original errand ("לתאם איתו פגישה")
    // can continue in the same breath instead of stalling on a toggle
    // conversation. Either side can still switch any feature off at will —
    // see grants.autoGrantAll. Lazy require: grants requires this module.
    const grants = require('./grants');
    await grants.autoGrantAll(client, rows[0].id, [Number(rows[0].requester_id), Number(targetUserId)]);
  }
  return ok({ connection: rows[0] });
}

async function listConnections(client, userId) {
  const { rows } = await client.query(
    `SELECT c.*,
            CASE WHEN c.requester_id = $1 THEN c.requester_label ELSE c.target_label END AS my_label,
            u.id AS other_id, u.first_name AS other_first_name, u.last_name AS other_last_name, u.phone AS other_phone
     FROM connections c
     JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.target_id ELSE c.requester_id END
     WHERE c.status = 'active' AND (c.requester_id = $1 OR c.target_id = $1)
     ORDER BY c.invited_at`,
    [userId]
  );
  return ok({ connections: rows });
}

// Private per-side nicknames ("אמא") — structured, never prose in memory files.
async function setLabel(client, userId, connectionId, label) {
  const col = await sideColumn(client, userId, connectionId);
  if (!col) return err('not_found', 'connection not found');
  await client.query(
    `UPDATE connections SET ${col} = $2 WHERE id = $1`,
    [connectionId, label && label.trim() ? label.trim() : null]
  );
  return ok({ connectionId, label: label || null });
}

async function sideColumn(client, userId, connectionId) {
  const { rows } = await client.query(
    `SELECT requester_id, target_id FROM connections WHERE id = $1 AND status = 'active'`,
    [connectionId]
  );
  if (!rows[0]) return null;
  if (rows[0].requester_id === userId) return 'requester_label';
  if (rows[0].target_id === userId) return 'target_label';
  return null;
}

// The cascade. Caller must run this inside withTx.
async function revokeConnection(client, userId, connectionId) {
  const { rows } = await client.query(
    `SELECT * FROM connections
     WHERE id = $1 AND status = 'active' AND (requester_id = $2 OR target_id = $2)`,
    [connectionId, userId]
  );
  const conn = rows[0];
  if (!conn) return err('not_found', 'active connection not found');
  const otherId = conn.requester_id === userId ? conn.target_id : conn.requester_id;

  await client.query(
    `UPDATE connections SET status = 'revoked', responded_at = now() WHERE id = $1`, [connectionId]
  );
  const shares = await client.query(
    `UPDATE shares SET status = 'revoked', responded_at = now()
     WHERE connection_id = $1 AND status IN ('pending_viewer','pending_owner','active')
     RETURNING id`,
    [connectionId]
  );
  const grants = await client.query(
    `DELETE FROM connection_feature_grants WHERE connection_id = $1 RETURNING feature, grantor_id`,
    [connectionId]
  );

  // Negotiating meetings where this pair are the only non-opted-out
  // participants: treated as the revoker opting out → meeting closes no_match.
  const meetings = require('./meetings');
  const affected = await client.query(
    `SELECT m.id FROM meetings m
     WHERE m.status = 'negotiating'
       AND EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1 AND p.state <> 'opted_out')
       AND EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $2 AND p.state <> 'opted_out')
       AND NOT EXISTS (SELECT 1 FROM meeting_participants p
                       WHERE p.meeting_id = m.id AND p.state <> 'opted_out' AND p.user_id NOT IN ($1, $2))`,
    [userId, otherId]
  );
  const closedMeetings = [];
  for (const m of affected.rows) {
    // The revoker is walking away: as initiator that's a cancel, as a
    // participant it's an opt-out (which auto-closes no_match for a pair).
    const { rows: mi } = await client.query(`SELECT initiator_id FROM meetings WHERE id = $1`, [m.id]);
    const res = mi[0].initiator_id === userId
      ? await meetings.cancelMeeting(client, userId, m.id)
      : await meetings.applyExit(client, userId, m.id, 'connection_revoked');
    closedMeetings.push({ meetingId: m.id, outcome: res.ok ? res.data.meetingStatus : 'error' });
  }

  await audit.record(client, userId, 'connection.revoked', {
    connectionId, otherId,
    sharesRevoked: shares.rowCount, grantsDeleted: grants.rowCount,
    meetingsAffected: closedMeetings,
  });
  return ok({ connectionId, sharesRevoked: shares.rowCount, grantsDeleted: grants.rowCount, meetingsAffected: closedMeetings });
}

module.exports = {
  activeConnectionBetween, requestConnection, attachProvisionedTarget,
  listPendingFor, respondToConnection, listConnections, setLabel, revokeConnection,
};
