'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const checkin = require('../src/jobs/checkin');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Onboarded 3 days ago and silent since (no audit rows after creation window).
async function silentUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(
    `UPDATE users SET onboarded_at = now() - interval '3 days', created_at = now() - interval '3 days' WHERE id = $1`, [u.id]);
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id = $1`, [u.id]);
  return u;
}

test('ladder rung 1: stuck meeting beats everything else', async () => {
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const meetings = require('../src/domain/meetings');
  const tasks = require('../src/domain/tasks');

  const a = await silentUser('+972591000001');
  const b = await silentUser('+972591000002');
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    const conn = (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, a.id, conn.id, 'meetings');
    await grants.grantFeature(c, b.id, conn.id, 'meetings');
    const m = (await meetings.startMeeting(c, a.id, 'coffee', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'Tuesday 17:00, cafe');
    // b also has an at-risk task — the meeting must still win
    const t = (await tasks.addTask(c, b.id, { title: 'urgent thing', dueAt: new Date(Date.now() + 3600_000).toISOString() })).data.task;
    await c.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE id = $1`, [t.id]);
    // audit rows from this setup made them look active — push back again
    await c.query(`UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id IN ($1, $2)`, [a.id, b.id]);
  });

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const bResult = results.find((r) => Number(r.userId) === Number(b.id));
  assert.ok(bResult, 'b got a checkin');
  assert.equal(bResult.rung, 'stuck_meeting');

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'checkin'`, [b.id]);
  assert.match(rows[0].payload.checkinInstruction, /Tuesday 17:00/);
});

test('ladder rungs: deadline_risk, overload, plain silence', async () => {
  const tasks = require('../src/domain/tasks');

  const risky = await silentUser('+972591000003');
  const overloaded = await silentUser('+972591000004');
  const quiet = await silentUser('+972591000005');

  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, risky.id, { title: 'submit report', dueAt: new Date(Date.now() + 12 * 3600_000).toISOString() })).data.task;
    await c.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE id = $1`, [t.id]);
    for (let i = 0; i < 5; i++) {
      const o = (await tasks.addTask(c, overloaded.id, { title: 'old ' + i, dueAt: new Date(Date.now() - 24 * 3600_000).toISOString() })).data.task;
      await c.query(`UPDATE tasks SET created_at = now() - interval '5 days' WHERE id = $1`, [o.id]);
    }
    await c.query(`UPDATE audit_log SET created_at = now() - interval '3 days' WHERE actor_id IN ($1, $2, $3)`,
      [risky.id, overloaded.id, quiet.id]);
  });

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const byId = Object.fromEntries(results.map((r) => [Number(r.userId), r.rung]));
  assert.equal(byId[Number(risky.id)], 'deadline_risk');
  assert.equal(byId[Number(overloaded.id)], 'overload');
  assert.equal(byId[Number(quiet.id)], 'silence');
});

test('idempotent per day; backoff excludes after 4 misses; recent activity excludes', async () => {
  const again = await withTx(db.pool, (c) => checkin.run(c));
  assert.equal(again.length, 0, 'second run same day enqueues nothing');

  const gaveUp = await silentUser('+972591000006');
  await db.pool.query(`UPDATE users SET checkin_misses = 4 WHERE id = $1`, [gaveUp.id]);
  const active = await makeUser(db.pool, '+972591000007'); // fresh audit rows = active now
  await db.pool.query(`UPDATE users SET onboarded_at = now() - interval '3 days' WHERE id = $1`, [active.id]);

  const results = await withTx(db.pool, (c) => checkin.run(c));
  const ids = results.map((r) => Number(r.userId));
  assert.ok(!ids.includes(Number(gaveUp.id)), 'backed-off user skipped');
  assert.ok(!ids.includes(Number(active.id)), 'recently active user skipped');
});

test('checkin cadence: fast for new users, slower once settled, backs off when ignored', () => {
  const { requiredGapMs } = require('../src/jobs/checkin');
  const h = (ms) => ms / 3600_000;

  // A brand-new user is the one most likely to drift away, so Olma reaches out
  // within hours; three weeks in, a daily rhythm is enough.
  assert.equal(h(requiredGapMs(0, 0)), 5, 'day 0');
  assert.equal(h(requiredGapMs(2.9, 0)), 5, 'still inside the first 3 days');
  assert.equal(h(requiredGapMs(3, 0)), 10, 'first week');
  assert.equal(h(requiredGapMs(10, 0)), 18, 'first three weeks');
  assert.equal(h(requiredGapMs(30, 0)), 24, 'settled');

  // Engagement, not the calendar, decides the rest: one ignored check-in
  // doubles the wait, two drops to weekly. A responsive new user keeps the
  // fast cadence; a silent one is left alone within a day.
  assert.equal(h(requiredGapMs(0, 1)), 10, 'one miss doubles');
  assert.equal(h(requiredGapMs(0, 2)), 24 * 7, 'two misses → weekly');
  assert.equal(h(requiredGapMs(30, 2)), 24 * 7, 'weekly regardless of age');
});

test('day one ladder: 15m / 2h / 5h, and steps expire instead of piling up', async () => {
  const checkin = require('../src/jobs/checkin');
  const { onboardingStepDue } = checkin;
  const MIN = 60_000, H = 3600_000;

  assert.equal(onboardingStepDue(5 * MIN, 0), null, 'nothing in the first minutes');
  assert.equal(onboardingStepDue(16 * MIN, 0).slot, '15m');
  assert.equal(onboardingStepDue(2.5 * H, 0).slot, '2h');
  assert.equal(onboardingStepDue(6 * H, 0).slot, '5h');
  // only the latest due step, so a gap in the sweep never replays old ones
  assert.equal(onboardingStepDue(23 * H, 0).slot, '5h');
  assert.equal(onboardingStepDue(25 * H, 0), null, 'day one is over');
  // present, not deaf: someone who ignored the first two is left alone
  assert.equal(onboardingStepDue(6 * H, 2), null);
  assert.equal(onboardingStepDue(6 * H, 1).slot, '5h');
});

test('day one ladder enqueues one step at a time, each with its own expiry', async () => {
  const checkin = require('../src/jobs/checkin');
  const fresh = await makeUser(db.pool, '+972615000042', { firstName: 'Chen' });
  const t0 = Date.now() - 20 * 60_000; // onboarded 20 minutes ago
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = to_timestamp($2/1000.0) WHERE id = $1`,
    [fresh.id, t0]);

  const out = await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  const mine = out.filter((r) => r.userId === fresh.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].rung, 'onboarding_15m');

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, expires_at, urgency FROM outbox WHERE user_id = $1`, [fresh.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].idempotency_key, /^onboarding:\d+:15m$/);
  // expires when the 2h step comes due, so an overnight signup wakes to ONE
  // message rather than the whole ladder at once
  assert.ok(new Date(rows[0].expires_at).getTime() - t0 <= 2 * 3600_000 + 1000);

  // re-running the sweep does not enqueue the same step twice
  await withTx(db.pool, (c) => checkin.run(c, Date.now()));
  const again = await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE user_id = $1`, [fresh.id]);
  assert.equal(again.rows[0].n, 1);
});
