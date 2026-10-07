'use strict';
// Yahav, 2026-10-06: the 10:00 digest listed "לבטל את האשראי" and the automatic
// rung 2 of the same task went out 59 seconds later. A follow-up chases an
// action; a digest that has just named the task already said it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');

const DUE = '2026-10-06T05:00:00Z';
const RUNG1 = '2026-10-06T04:00:00Z';
const DIGEST_AT = '2026-10-06T07:00:36Z';
const RUNG2_TICK = '2026-10-06T07:01:35Z';

async function setup(phone, { nudge = false } = {}) {
  const { pool, teardown } = await freshDb();
  const user = await makeUser(pool, phone, { timezone: 'UTC' });
  await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לבטל את האשראי', dueAt: DUE });
    await reminders.setReminder(c, user.id, t.data.task.id, RUNG1, null, { nudge });
    await c.query(`UPDATE task_reminders SET auto = $1`, [!nudge]);
  });
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-10-06T04:01:00Z'));
  await pool.query(
    `UPDATE outbox SET sent_at = '2026-10-06T04:00:36Z', hold_reason = NULL WHERE kind = 'reminder'`);
  return { pool, teardown, user };
}

async function digest(pool, userId, scope, sentAt) {
  await pool.query(
    `INSERT INTO outbox (user_id, kind, payload, sent_at) VALUES ($1, 'digest', $2::jsonb, $3)`,
    [userId, JSON.stringify({ scope, folded: [] }), sentAt]);
}

const rungKeys = async (pool) => (await pool.query(
  `SELECT idempotency_key FROM outbox WHERE kind = 'reminder' ORDER BY id`)).rows.map((r) => r.idempotency_key);

test('a digest that listed the task covers the automatic follow-up', async (t) => {
  const { pool, teardown, user } = await setup('+972505500201');
  t.after(teardown);
  await digest(pool, user.id, 'today', DIGEST_AT);
  await withTx(pool, (c) => sweeps.sweepReminders(c, RUNG2_TICK));
  assert.equal((await rungKeys(pool)).length, 1, 'no rung 2 behind the digest');
  const { rows: [r] } = await pool.query(`SELECT sent_at FROM task_reminders`);
  assert.ok(r.sent_at, 'the ladder is retired, not left pending');
  const { rows: a } = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'reminder.covered_by_digest'`);
  assert.equal(a.length, 1);
});

test('a summary digest names nothing, so the follow-up still goes', async (t) => {
  const { pool, teardown, user } = await setup('+972505500202');
  t.after(teardown);
  await digest(pool, user.id, 'summary', DIGEST_AT);
  await withTx(pool, (c) => sweeps.sweepReminders(c, RUNG2_TICK));
  assert.equal((await rungKeys(pool)).length, 2);
});

test('a digest that never reached them (held) covers nothing', async (t) => {
  const { pool, teardown, user } = await setup('+972505500203');
  t.after(teardown);
  await digest(pool, user.id, 'today', DIGEST_AT);
  await pool.query(`UPDATE outbox SET hold_reason = 'quiet' WHERE kind = 'digest'`);
  await withTx(pool, (c) => sweeps.sweepReminders(c, RUNG2_TICK));
  assert.equal((await rungKeys(pool)).length, 2);
});

test('a nudge they asked for keeps its ladder under a digest', async (t) => {
  const { pool, teardown, user } = await setup('+972505500204', { nudge: true });
  t.after(teardown);
  await digest(pool, user.id, 'full', DIGEST_AT);
  await withTx(pool, (c) => sweeps.sweepReminders(c, RUNG2_TICK));
  assert.equal((await rungKeys(pool)).length, 2);
});
