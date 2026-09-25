'use strict';
// The check-in ladder's miss is counted where the question REACHED them, not
// where it was queued (jobs/checkin.js, `run`; outbox/worker.js,
// `countLadderAsk`). Counted on the enqueue, a check-in held for the night or
// replaced before it went out made somebody "silent" to a question nobody had
// asked them: Sharon's coordination confirmation was dropped as `quiet`, and
// עידן was paused by the ladder with none of its three check-ins delivered
// (incidents.md, "Paused for three questions nobody asked").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, daytime } = require('./helpers');
const { withTx } = require('../src/db/pool');
const checkin = require('../src/jobs/checkin');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const ok = async () => ({ ok: true });

// Onboarded `days` ago and silent since, so the ladder is due.
async function silentUser(phone, extra = {}, days = 3) {
  const u = await makeUser(db.pool, phone, { timezone: 'UTC', ...extra });
  await db.pool.query(
    `UPDATE users SET onboarded_at = now() - make_interval(days => $2), created_at = now() - make_interval(days => $2) WHERE id = $1`, [u.id, days]);
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - make_interval(days => $2) WHERE actor_id = $1`, [u.id, days]);
  return u;
}
const queuedFor = async (id) => (await db.pool.query(
  `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'checkin' AND sent_at IS NULL`, [id])).rows[0].n;
const missesOf = async (id) => Number((await db.pool.query(
  `SELECT checkin_misses FROM users WHERE id = $1`, [id])).rows[0].checkin_misses);
// Everything else still queued is somebody else's test; out of the way.
const clearOthers = (id) => db.pool.query(
  `UPDATE outbox SET sent_at = now() - interval '2 hours', hold_reason = 'cancelled_by_admin'
    WHERE sent_at IS NULL AND user_id <> $1`, [id]);

test('a queued check-in is not a miss; the one that reaches them is', async () => {
  const u = await silentUser('+972641100001', { firstName: 'Noa' });
  await withTx(db.pool, (c) => checkin.run(c));
  const { rows } = await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND kind = 'checkin' AND sent_at IS NULL`, [u.id]);
  assert.equal(rows.length, 1, 'the ladder asked');
  assert.equal(await missesOf(u.id), 0, 'queued is not asked');

  await clearOthers(u.id);
  const out = await drainOnce(db.pool, ok, daytime());
  assert.equal(out.delivered, 1);
  assert.equal(await missesOf(u.id), 1, 'delivered and unanswered is a miss');
});

test('a check-in held for the night counts nothing until it goes out', async () => {
  const u = await silentUser('+972641100002');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { checkinInstruction: 'hi', rung: 'silence' }, idempotencyKey: 'night-miss',
  }));
  await clearOthers(u.id);
  const night = new Date(daytime()); night.setUTCHours(3);
  const held = await drainOnce(db.pool, ok, night);
  assert.equal(held.held, 1);
  assert.equal(await missesOf(u.id), 0, 'held at 03:00 is not a question they failed to answer');

  await drainOnce(db.pool, ok, daytime(new Date(night.getTime() + 24 * 3600_000)));
  assert.equal(await missesOf(u.id), 1);
});

test('a check-in the gate DROPPED, a failed send, and a day-one step never count', async () => {
  const u = await silentUser('+972641100003');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { checkinInstruction: 'hi', rung: 'onboarding_5h' }, idempotencyKey: 'step-miss',
  }));
  await clearOthers(u.id);
  await drainOnce(db.pool, ok, daytime());
  assert.equal(await missesOf(u.id), 0, 'a day-one step is built not to need an answer');

  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { checkinInstruction: 'hi', rung: 'silence' }, idempotencyKey: 'fail-miss',
  }));
  const failed = await drainOnce(db.pool, async () => ({ ok: false, error: 'gateway hiccup' }), daytime());
  assert.equal(failed.failed, 1);
  assert.equal(await missesOf(u.id), 0, 'a send that failed asked nothing');

  await db.pool.query(`UPDATE outbox SET sent_at = now(), hold_reason = 'cancelled_by_admin' WHERE user_id = $1 AND sent_at IS NULL`, [u.id]);
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { checkinInstruction: 'hi', rung: 'silence' }, idempotencyKey: 'paused-miss',
  }));
  const dropped = await drainOnce(db.pool, ok, daytime());
  assert.equal(dropped.dropped, 1);
  assert.equal(await missesOf(u.id), 0, 'a row dropped as paused reached nobody');
});

test('a timed-out send is booked as sent, so it counts', async () => {
  const u = await silentUser('+972641100004');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: u.id, kind: 'checkin', payload: { checkinInstruction: 'hi', rung: 'silence' }, idempotencyKey: 'timeout-miss',
  }));
  await clearOthers(u.id);
  await drainOnce(db.pool, async () => ({ ok: false, timedOut: true, error: 'openclaw timeout' }), daytime());
  assert.equal(await missesOf(u.id), 1);
});

test('the ladder pauses only after two check-ins that really reached them', async () => {
  // One real miss: the next rung is asked, counted nothing, and pauses nobody.
  // Counted on the enqueue this was the second miss, and a third undelivered
  // row would have paused them.
  const u = await silentUser('+972641100005', {}, 20);
  await db.pool.query(
    `UPDATE users SET checkin_misses = 1, last_checkin_at = now() - interval '8 days' WHERE id = $1`, [u.id]);
  await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(await queuedFor(u.id), 1, 'the next rung was asked');
  const { rows: [one] } = await db.pool.query(`SELECT checkin_misses, paused_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(Number(one.checkin_misses), 1);
  assert.equal(one.paused_at, null);

  // Two real misses: this third one is the pause, as it always was. (Another
  // person, because a day's check-in key is spent once per day.)
  const v = await silentUser('+972641100006', {}, 20);
  await db.pool.query(
    `UPDATE users SET checkin_misses = 2, last_checkin_at = now() - interval '8 days' WHERE id = $1`, [v.id]);
  await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(await queuedFor(v.id), 1, 'the third was asked, and meets the gate as a paused row');
  const { rows: [three] } = await db.pool.query(`SELECT checkin_misses, paused_reason FROM users WHERE id = $1`, [v.id]);
  assert.equal(Number(three.checkin_misses), 3);
  assert.equal(three.paused_reason, 'quiet_ladder');
});
