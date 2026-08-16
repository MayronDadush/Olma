'use strict';
// The message quota — volume-based, never feature-based. Free plan: daily
// window; paid plan: hourly window (refreshes faster). Blocking is
// bidirectional and handled by callers via isBlocked/quota_blocked_until.
//
// This module counts and decides; it never sends anything. The one-notice-
// per-block-window rule lives in users.quota_notice_sent_at, checked by the
// caller that would send the today view.
//
// Flood protection (N per minute) is deliberately NOT here — that's an
// in-memory counter in brokerd; this table is the durable day/hour ledger.
const { ok } = require('./results');
const audit = require('./audit');
const flags = require('./flags');

function windowStart(kind, now) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  if (kind === 'day') d.setUTCHours(0);
  return d.toISOString();
}

async function planFor(client, userId) {
  const { rows } = await client.query(`SELECT plan, status, valid_until FROM entitlements WHERE user_id = $1`, [userId]);
  const e = rows[0];
  if (!e || e.status !== 'active') return 'free';
  if (e.valid_until && new Date(e.valid_until) < new Date()) return 'free';
  return e.plan;
}

// Count one inbound user message. Returns { blocked, justBlocked, count, limit }.
// justBlocked=true exactly once per window crossing — that's the moment the
// caller sends the single today-view notice.
async function countMessage(client, userId, nowIso) {
  const now = nowIso || new Date().toISOString();
  const plan = await planFor(client, userId);
  const kind = plan === 'free' ? 'day' : 'hour';
  const start = windowStart(kind, now);

  const { rows: userRows } = await client.query(
    `SELECT quota_override_daily, quota_blocked_until FROM users WHERE id = $1`, [userId]
  );
  const u = userRows[0];
  const limit = u.quota_override_daily
    ?? Number(await flags.getFlag(client, plan === 'free' ? 'quota_daily_free' : 'quota_hourly_paid'));

  const { rows } = await client.query(
    `INSERT INTO quota_counters (user_id, window_kind, window_start, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (user_id, window_kind, window_start)
     DO UPDATE SET count = quota_counters.count + 1
     RETURNING count`,
    [userId, kind, start]
  );
  const count = rows[0].count;
  const blocked = count > limit;
  let justBlocked = false;

  if (blocked && !u.quota_blocked_until) {
    const until = nextWindow(kind, now);
    await client.query(
      `UPDATE users SET quota_blocked_until = $2 WHERE id = $1`, [userId, until]
    );
    justBlocked = true;
    await audit.record(client, userId, 'quota.blocked', { plan, count, limit, until });
  }
  return ok({ blocked, justBlocked, count, limit, plan });
}

function nextWindow(kind, now) {
  const d = new Date(now);
  if (kind === 'day') {
    d.setUTCHours(24, 0, 0, 0);
  } else {
    d.setUTCMinutes(60, 0, 0);
  }
  return d.toISOString();
}

async function isBlocked(client, userId, nowIso) {
  const now = nowIso || new Date().toISOString();
  const { rows } = await client.query(
    `SELECT quota_blocked_until FROM users WHERE id = $1`, [userId]
  );
  const until = rows[0] && rows[0].quota_blocked_until;
  return Boolean(until && new Date(until) > new Date(now));
}

// The single-notice gate: returns true (and stamps) only the first time it is
// asked during a given block window.
async function shouldSendBlockNotice(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET quota_notice_sent_at = now()
     WHERE id = $1 AND quota_blocked_until IS NOT NULL
       AND (quota_notice_sent_at IS NULL OR quota_notice_sent_at < quota_blocked_until - interval '2 day')
     RETURNING id`,
    [userId]
  );
  return Boolean(rows[0]);
}

// Users whose block just lapsed — the unblock job turns these into outbox
// rows (respectfully timed), then clears the block fields.
async function lapsedBlocks(client, nowIso) {
  const now = nowIso || new Date().toISOString();
  const { rows } = await client.query(
    `SELECT id, first_name, timezone FROM users
     WHERE quota_blocked_until IS NOT NULL AND quota_blocked_until <= $1`,
    [now]
  );
  return ok({ users: rows });
}

async function clearBlock(client, userId) {
  await client.query(
    `UPDATE users SET quota_blocked_until = NULL, quota_notice_sent_at = NULL WHERE id = $1`,
    [userId]
  );
  await audit.record(client, userId, 'quota.unblocked', {});
  return ok({ userId });
}

module.exports = {
  countMessage, isBlocked, shouldSendBlockNotice, lapsedBlocks, clearBlock,
  planFor, windowStart, nextWindow,
};
