'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { decide, withinWindow, msUntilWindowOpen } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const sweeps = require('../src/jobs/sweeps');
const { withTx } = require('../src/db/pool');

// ---------------- gate: pure policy tests (no DB) ----------------------------

const DAY = { start: '09:00', end: '20:00' };
const noonUTC = new Date('2026-08-16T12:00:00Z'); // 15:00 in Asia/Jerusalem (UTC+3)
const threeAmUTC = new Date('2026-08-16T00:00:00Z'); // 03:00 local

function row(overrides) {
  return { kind: 'checkin', urgency: 'normal', expires_at: null, ...overrides };
}
const baseFacts = {
  plan: 'free', blocked: false, window: DAY, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: noonUTC,
};

test('gate: healthy daytime message delivers', () => {
  assert.equal(decide({ ...baseFacts, row: row() }).action, 'deliver');
});

test('gate: blocked user holds everything except paid reminders and unblock', () => {
  const blocked = { ...baseFacts, blocked: true };
  assert.equal(decide({ ...blocked, row: row() }).holdReason, 'blocked');
  assert.equal(decide({ ...blocked, row: row({ kind: 'reminder' }) }).holdReason, 'blocked'); // free plan
  assert.equal(decide({ ...blocked, plan: 'paid', row: row({ kind: 'reminder' }) }).action, 'deliver'); // paid bypass
  assert.equal(decide({ ...blocked, row: row({ kind: 'unblock_summary' }) }).action, 'deliver');
});

test('gate: night holds until the personal window opens; user-chosen times bypass', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  const held = decide({ ...night, row: row() });
  assert.equal(held.holdReason, 'night');
  // 03:00 → 09:00 local = six hours away
  assert.equal(Math.round((held.releaseAfter - threeAmUTC) / 3600_000), 6);
  assert.equal(decide({ ...night, row: row({ kind: 'reminder' }) }).action, 'deliver'); // user picked 03:00
  assert.equal(decide({ ...night, row: row({ kind: 'digest' }) }).action, 'deliver');
});

test('gate: personal window beats the default one', () => {
  const lateOwl = { ...baseFacts, window: { start: '22:00', end: '06:00' }, now: threeAmUTC };
  assert.equal(decide({ ...lateOwl, row: row() }).action, 'deliver'); // 03:00 inside their overnight window
  const sameNowDefault = { ...baseFacts, now: threeAmUTC };
  assert.equal(decide({ ...sameNowDefault, row: row() }).action, 'hold');
});

test('gate: over budget folds normal, urgent passes', () => {
  const busy = { ...baseFacts, sentToday: 4 };
  const held = decide({ ...busy, row: row() });
  assert.equal(held.holdReason, 'budget');
  assert.equal(held.releaseAfter, null); // waits for the next digest, not a clock
  assert.equal(decide({ ...busy, row: row({ urgency: 'urgent' }) }).action, 'deliver');
});

test('gate: expired rows never deliver live', () => {
  const r = row({ kind: 'reminder', expires_at: '2026-08-16T10:00:00Z' });
  assert.equal(decide({ ...baseFacts, row: r }).action, 'expire');
});

test('window math: overnight windows and reopen distance', () => {
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T23:30:00Z')), true);
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T12:00:00Z')), false);
  const ms = msUntilWindowOpen({ start: '09:00', end: '20:00' }, 'UTC', new Date('2026-08-16T21:00:00Z'));
  assert.equal(ms / 3600_000, 12); // 21:00 → 09:00 next day
});

// ---------------- worker + sweeps: DB-backed lifecycle -----------------------

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972581000001', { firstName: 'Dana', timezone: 'UTC' });
});
after(async () => { await db.teardown(); });

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r.kind); return { ok: true }; } };
}

// Each worker test starts from an empty pending set — a failed assertion in
// one test must not leak rows into the next one's drain.
async function flushOutbox() {
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
}

test('worker delivers pending rows and records sent_at', async () => {
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'hi' },
    idempotencyKey: 'w1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['checkin']);
  const { rows } = await db.pool.query(`SELECT sent_at FROM outbox WHERE idempotency_key = 'w1'`);
  assert.ok(rows[0].sent_at);
});

test('idempotency: same key enqueues once, jobs are re-runnable', async () => {
  const r1 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  const r2 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  assert.equal(r1.data.enqueued, true);
  assert.equal(r2.data.enqueued, false);
});

test('delivery failure → attempts + backoff, then success on retry', async () => {
  await flushOutbox();
  // kind=reminder: window-independent, so the retry (whose clock comes from
  // the DB's real now()) can't be night-held by the wall clock of the test run
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'flaky' }));
  let fail = true;
  const deliver = async () => fail ? { ok: false, error: 'gateway hiccup' } : { ok: true };
  let out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.failed, 1);
  const { rows } = await db.pool.query(`SELECT attempts, last_error, release_after FROM outbox WHERE idempotency_key = 'flaky'`);
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /hiccup/);
  fail = false;
  out = await drainOnce(db.pool, deliver, new Date(new Date(rows[0].release_after).getTime() + 1000));
  assert.equal(out.delivered, 1);
});

test('night hold: row waits, then releases when the window opens', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'night1' }));
  const rec = recorder();
  let out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T03:00:00Z')); // 3am UTC = user tz
  assert.equal(out.held, 1);
  assert.equal(rec.sent.length, 0);
  out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T09:30:00Z'));
  assert.equal(out.delivered, 1);
});

test('welcome goes out at once — never held, never deferred to a window', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'welcome', urgency: 'urgent', payload: { text: 'x' }, idempotencyKey: 'wstab',
  }));
  const rec = recorder();
  // 3am in the user's timezone: a welcome is the reply to a message they just
  // sent, so it is exempt from the quiet-hours window like reminders/digests
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T03:00:00Z'));
  assert.equal(out.delivered, 1);
  assert.equal(out.held, 0);
  assert.equal(rec.sent.length, 1);
});

test('reminder sweep: due → urgent outbox row + repeat spawns next occurrence', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { taskId } = await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, user.id, { title: 'daily pills' })).data.task;
    await reminders.setReminder(c, user.id, t.id, '2026-08-16T07:00:00Z', 'daily');
    return { taskId: t.id };
  });
  const swept = await withTx(db.pool, (c) => sweeps.sweepReminders(c, '2026-08-16T07:01:00Z'));
  assert.equal(swept.length, 1);
  const { rows } = await db.pool.query(
    `SELECT urgency, expires_at FROM outbox
     WHERE kind = 'reminder' AND user_id = $1 AND idempotency_key LIKE 'reminder:%'`, [user.id]);
  assert.equal(rows[0].urgency, 'urgent');
  assert.ok(rows[0].expires_at); // 2h staleness horizon
  const next = await db.pool.query(
    `SELECT remind_at FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL`, [taskId]);
  assert.equal(new Date(next.rows[0].remind_at).toISOString(), '2026-08-17T07:00:00.000Z');
});

test('digest sweep fires on the user\'s local slot and folds budget-held rows', async () => {
  await flushOutbox();
  await db.pool.query(
    `UPDATE users SET digest_times = '08:00', digest_scope = 'summary', onboarded_at = now() WHERE id = $1`, [user.id]);
  // a budget-held row waiting to ride along
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'system_update', idempotencyKey: 'held-b', payload: { note: 'x' } }));
  await db.pool.query(`UPDATE outbox SET hold_reason = 'budget' WHERE idempotency_key = 'held-b'`);

  const fired = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T08:01:00Z')));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].folded, 1);
  const missed = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T11:00:00Z')));
  assert.equal(missed.length, 0); // wrong time → nothing
});

test('unblock sweep: consolidates held + stale, clears the block', async () => {
  const other = await makeUser(db.pool, '+972581000002', { timezone: 'UTC' });
  await db.pool.query(
    `UPDATE users SET quota_blocked_until = '2026-08-16T10:00:00Z' WHERE id = $1`, [other.id]);
  await withTx(db.pool, async (c) => {
    await enqueue(c, { userId: other.id, kind: 'reminder', idempotencyKey: 'ub-stale',
      payload: { title: 'pick up kid 16:00' }, expiresAt: '2026-08-16T09:00:00Z' });
    await enqueue(c, { userId: other.id, kind: 'system_update', idempotencyKey: 'ub-fresh', payload: { note: 'still relevant' } });
  });
  await db.pool.query(`UPDATE outbox SET hold_reason = 'blocked' WHERE user_id = $1`, [other.id]);

  const unblocked = await withTx(db.pool, (c) => sweeps.sweepUnblocks(c, '2026-08-16T10:05:00Z'));
  assert.deepEqual(unblocked.map(Number), [Number(other.id)]);

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'unblock_summary'`, [other.id]);
  const p = rows[0].payload;
  assert.equal(p.accumulated.length, 1);
  assert.equal(p.expired.length, 1); // the 16:00 pickup — listed as עבר זמנה, not live
  const u = await db.pool.query(`SELECT quota_blocked_until FROM users WHERE id = $1`, [other.id]);
  assert.equal(u.rows[0].quota_blocked_until, null);
});
