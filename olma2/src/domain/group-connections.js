'use strict';
// Standing in the same room IS the introduction (owner's rule, 2026-09-09).
//
// Everyone who is in a WhatsApp group with Olma and is already a user becomes
// connected to everyone else there, with every feature on, without anybody
// being asked. That reverses the older rule — "no unrequested connections" —
// and deliberately so, because the two are about different evidence:
//
//   * the old rule refused connections INFERRED from data ("these two talk
//     about each other, they must be close"), which is a guess about people;
//   * this one is not a guess. Being in the room is a fact both people can
//     see, they already have each other's number there, and the errand that
//     brought them in is a shared one. The room is the consent moment the
//     approval flow was standing in for.
//
// Three lines that are NOT crossed, because each of them would turn a
// convenience into something nobody agreed to:
//
//   1. Only people who are ALREADY users. A member who has never met Olma is
//      not invited by this — a room of twelve would become twelve intro
//      messages nobody asked for, and `requestConnection`'s invite path is
//      exactly the thing that must stay a decision somebody made.
//   2. A `declined` or `revoked` connection is never re-created. Revoking is
//      the only way out of a connection, and a revoke that walking into a
//      room can undo is not a way out at all. Those two people simply stay
//      unconnected while sharing the room.
//   3. Nothing here reads or moves anybody's data. An active connection with
//      every grant means each of them MAY be asked to share a task or be
//      offered a time; a share still waits for the viewer to accept it
//      (`shares.offerShare` → `pending_viewer`), and a relayed message still
//      goes through the recipient's own delivery gate.
const { ok } = require('./results');
const audit = require('./audit');
const grants = require('./grants');

// Live in either direction: the UNIQUE index is (requester_id, target_phone)
// for live states, so inserting the mirror row of an existing invite would
// pass the constraint and leave two connections for one pair. Ask about the
// PAIR, never about the direction.
async function liveBetween(client, a, b) {
  const { rows } = await client.query(
    `SELECT * FROM connections
      WHERE status IN ('invited', 'pending_target', 'active')
        AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))
      LIMIT 1`,
    [a, b]);
  return rows[0] || null;
}

async function refusedBetween(client, a, b) {
  const { rows } = await client.query(
    `SELECT 1 FROM connections
      WHERE status IN ('declined', 'revoked')
        AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))
      LIMIT 1`,
    [a, b]);
  return rows.length > 0;
}

// Its own event name, never `connection.approved`. Two reasons, and the second
// is the one that bites: the daily metrics count approvals as a friction
// signal (`jobs/metrics.js`), and a number that silently absorbs a second
// meaning is a number nobody can read six weeks later. It keeps the
// `connection.` prefix, so it is retained forever like every other consent
// record.
//
// One row PER SIDE. This is the only trail saying why two people are
// connected when neither of them pressed anything, and a per-person audit view
// asks `WHERE actor_id = $1` — a single row would leave one of the two with
// nothing on their record.
async function recordBothSides(client, row, a, b, outcome, detail) {
  for (const [self, other] of [[a, b], [b, a]]) {
    await audit.record(client, self, 'connection.auto_connected', {
      connectionId: Number(row.id), withUserId: other, outcome, via: 'group', ...(detail || {}),
    });
  }
}

// One pair. Returns what happened, which is what makes the sweep's audit row
// worth reading: 'created' | 'activated' | 'already' | 'refused_before'.
async function connectPair(client, aId, bId, detail) {
  const a = Number(aId);
  const b = Number(bId);
  if (!a || !b || a === b) return { outcome: 'already', connectionId: null };

  const live = await liveBetween(client, a, b);
  if (live && live.status === 'active') return { outcome: 'already', connectionId: Number(live.id) };

  if (live) {
    // An ask that was already on the table. The room answers it — the same
    // consent moment `respondToConnection` writes, reached another way.
    const { rows } = await client.query(
      `UPDATE connections SET status = 'active', responded_at = now(),
              target_id = COALESCE(target_id, $2)
        WHERE id = $1 RETURNING *`,
      [live.id, live.requester_id === a ? b : a]);
    const row = rows[0];
    await grants.autoGrantAll(client, Number(row.id), [a, b], detail);
    await recordBothSides(client, row, a, b, 'activated', detail);
    return { outcome: 'activated', connectionId: Number(row.id) };
  }

  if (await refusedBetween(client, a, b)) return { outcome: 'refused_before', connectionId: null };

  const { rows: [me] } = await client.query(`SELECT phone FROM users WHERE id = $1`, [b]);
  if (!me || !me.phone) return { outcome: 'already', connectionId: null };
  const { rows } = await client.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, invite_reason, responded_at)
          VALUES ($1, $2, $3, 'active', 'group', now())
       RETURNING *`,
    [a, b, me.phone]);
  const row = rows[0];
  await grants.autoGrantAll(client, Number(row.id), [a, b], detail);
  await recordBothSides(client, row, a, b, 'created', detail);
  return { outcome: 'created', connectionId: Number(row.id) };
}

// Every pair of USERS in one room. Idempotent by construction — the second
// pass finds every pair settled and writes nothing — so it is safe to call on
// every roster sync, which is what makes a member who signs up next week
// connected without anybody remembering to run anything.
//
// The state of every pair is read in ONE query rather than per pair. A room of
// twenty-five is three hundred pairs, and asking three questions about each of
// them inside the sweep's transaction is exactly the shape that held a lock on
// `chat_groups` for twenty seconds on 2026-09-07 (`incidents.md`, "The room was
// told twice"). In the steady state — everybody already connected — this costs
// two queries for the whole room and writes nothing at all.
//
// Pairs are ordered by user id, so a pair is always (lower, higher): otherwise
// the row's `requester_id` would be decided by roster order, and a pair that
// swapped direction between two passes would become two live rows.
async function connectRoom(client, groupId) {
  const { rows: members } = await client.query(
    `SELECT DISTINCT m.user_id FROM chat_group_members m
      WHERE m.group_id = $1 AND m.left_at IS NULL AND m.user_id IS NOT NULL
      ORDER BY m.user_id`,
    [groupId]);
  const ids = members.map((r) => Number(r.user_id));
  const result = { created: 0, activated: 0, already: 0, refusedBefore: 0, members: ids.length };
  if (ids.length < 2) return ok(result);

  const { rows: known } = await client.query(
    `SELECT requester_id, target_id, status FROM connections
      WHERE requester_id = ANY($1) AND target_id = ANY($1)`, [ids]);
  const state = new Map();
  for (const r of known) {
    const key = [Number(r.requester_id), Number(r.target_id)].sort((x, y) => x - y).join(':');
    const rank = { active: 3, pending_target: 2, invited: 2, declined: 1, revoked: 1 }[r.status] || 0;
    const prev = state.get(key);
    if (!prev || rank > prev.rank) state.set(key, { rank, status: r.status });
  }

  const todo = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const s = state.get(`${ids[i]}:${ids[j]}`);
      if (s && s.status === 'active') { result.already++; continue; }
      if (s && (s.status === 'declined' || s.status === 'revoked')) { result.refusedBefore++; continue; }
      todo.push([ids[i], ids[j]]);
    }
  }

  for (const [a, b] of todo) {
    const r = await connectPair(client, a, b, { groupId: Number(groupId) });
    if (r.outcome === 'created') result.created++;
    else if (r.outcome === 'activated') result.activated++;
    else if (r.outcome === 'refused_before') result.refusedBefore++;
    else result.already++;
  }

  if (result.created || result.activated) {
    await audit.record(client, ids[0], 'group.connected', {
      groupId: Number(groupId), members: ids.length,
      created: result.created, activated: result.activated,
    });
  }
  return ok(result);
}

module.exports = { connectRoom, connectPair, liveBetween, refusedBetween };
