'use strict';
// A reminder used to fire exactly once. Live evidence for why that was not
// enough: 45 reminders fired and 3 were followed by a completion. Someone
// driving, in a meeting, or asleep past the 2h expiry heard about it never.
//
// Three rungs now, and every rule that keeps it from becoming a drum is
// pinned here — especially the one the check-in ladder got wrong: a rung that
// was never DELIVERED must not count as a rung the person ignored.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');

const AT = '2026-08-17T16:00:00Z';         // the moment the user picked
const TICK1 = '2026-08-17T16:01:00Z';      // rung 1
const PLUS_3H = '2026-08-17T19:05:00Z';    // rung 2 window
const NEXT_DAY = '2026-08-18T16:05:00Z';   // rung 3 window
const DAY_AFTER = '2026-08-19T16:05:00Z';

async function setup(phone, { repeatRule = null, timezone = 'UTC' } = {}) {
  const { pool, teardown } = await freshDb();
  const user = await makeUser(pool, phone, { timezone });
  const taskId = await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לקחת תרופה' });
    await reminders.setReminder(c, user.id, t.data.task.id, AT, repeatRule);
    return t.data.task.id;
  });
  return { pool, teardown, user, taskId };
}

// Mark the outbox row for one rung as genuinely delivered. hold_reason IS NULL
// is what "delivered" means here — the gate stamps a reason on everything it
// drops, holds or expires.
async function deliver(pool, reminderId, attempt, atIso) {
  const key = reminders.attemptKey(reminderId, attempt);
  const { rowCount } = await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL
      WHERE idempotency_key = $1`, [key, atIso]);
  assert.equal(rowCount, 1, `expected an outbox row for rung ${attempt} (${key})`);
}

async function reminderRow(pool) {
  const { rows } = await pool.query(`SELECT * FROM task_reminders ORDER BY id LIMIT 1`);
  return rows[0];
}

async function outboxKeys(pool) {
  const { rows } = await pool.query(
    `SELECT idempotency_key, urgency FROM outbox ORDER BY id`);
  return rows;
}

test('the ladder climbs only after a rung was actually delivered, and stops at three', async (t) => {
  const { pool, teardown, user } = await setup('+972505500001');
  t.after(teardown);
  const r = await reminderRow(pool);

  // Rung 1 — unchanged behaviour, and it keeps the ORIGINAL unsuffixed key so
  // rows enqueued before this shipped are never re-sent as brand new.
  assert.deepEqual(await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1)), [r.id]);
  let keys = await outboxKeys(pool);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].idempotency_key, `reminder:${r.id}`);
  assert.equal(keys[0].urgency, 'urgent', 'the moment THEY chose skips the budget');
  assert.equal((await reminderRow(pool)).attempts, 1);
  assert.equal((await reminderRow(pool)).sent_at, null, 'the ladder is still walking');

  // Still undelivered → no rung 2, however long we wait.
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.equal((await outboxKeys(pool)).length, 1, 'an undelivered rung 1 cannot be followed up');

  await deliver(pool, r.id, 1, AT);

  // Delivered, but the gap has not passed.
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-17T17:30:00Z'));
  assert.equal((await outboxKeys(pool)).length, 1, 'three hours means three hours');

  // Rung 2.
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  keys = await outboxKeys(pool);
  assert.equal(keys.length, 2);
  assert.equal(keys[1].idempotency_key, `reminder:${r.id}:2`);
  assert.equal(keys[1].urgency, 'normal', 'a follow-up is Olma\'s idea, not theirs');
  assert.equal((await reminderRow(pool)).attempts, 2);
  await deliver(pool, r.id, 2, PLUS_3H);

  // Rung 3 is next-day-at-the-original-hour, not gap-hours after rung 2.
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-17T23:00:00Z'));
  assert.equal((await outboxKeys(pool)).length, 2, 'the last rung waits for tomorrow');

  await withTx(pool, (c) => sweeps.sweepReminders(c, NEXT_DAY));
  keys = await outboxKeys(pool);
  assert.equal(keys.length, 3);
  assert.equal(keys[2].idempotency_key, `reminder:${r.id}:3`);
  const done = await reminderRow(pool);
  assert.equal(done.attempts, 3);
  assert.ok(done.sent_at, 'out of rungs — the reminder retires');

  // A fourth never happens, no matter how long anyone waits.
  await deliver(pool, r.id, 3, NEXT_DAY);
  await withTx(pool, (c) => sweeps.sweepReminders(c, DAY_AFTER));
  assert.equal((await outboxKeys(pool)).length, 3, 'three means three');
  assert.equal(user.id > 0, true);
});

// The check-in ladder's exact bug: it counted messages that died inside quiet
// hours as ignores and backed a person off to weekly having sent them nothing.
// A rung the gate held, dropped or expired must not burn a rung.
test('a rung that never reached them does not advance the ladder', async (t) => {
  const { pool, teardown } = await setup('+972505500002');
  t.after(teardown);
  const r = await reminderRow(pool);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));

  // Stamped, but with a reason — the shape the gate leaves behind.
  await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = 'expired'
      WHERE idempotency_key = $1`, [reminders.attemptKey(r.id, 1), AT]);

  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  await withTx(pool, (c) => sweeps.sweepReminders(c, NEXT_DAY));
  assert.equal((await outboxKeys(pool)).length, 1,
    'a message the person never saw is not a message they ignored');
  assert.equal((await reminderRow(pool)).attempts, 1);
});

test('completing the task ends the ladder mid-climb', async (t) => {
  const { pool, teardown, user, taskId } = await setup('+972505500003');
  t.after(teardown);
  const r = await reminderRow(pool);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  await deliver(pool, r.id, 1, AT);

  await withTx(pool, (c) => tasks.completeTask(c, user.id, taskId));
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.equal((await outboxKeys(pool)).length, 1, '"done" stops it with no new plumbing');
  assert.ok((await reminderRow(pool)).cancelled_at);
});

test('"stop reminding me" ends the ladder mid-climb', async (t) => {
  const { pool, teardown, user } = await setup('+972505500004');
  t.after(teardown);
  const r = await reminderRow(pool);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  await deliver(pool, r.id, 1, AT);

  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, r.id));
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.equal((await outboxKeys(pool)).length, 1);
});

// A repeat rule IS the person's own chosen cadence. Chasing it as well would
// be two drums on one task, and rung 2 of Monday's reminder would collide with
// Tuesday's scheduled one.
test('a repeating reminder never escalates — it retires and spawns its successor', async (t) => {
  const { pool, teardown } = await setup('+972505500005', { repeatRule: 'FREQ=DAILY' });
  t.after(teardown);
  const first = await reminderRow(pool);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));

  const after = await pool.query(`SELECT * FROM task_reminders ORDER BY id`);
  assert.equal(after.rows.length, 2, 'the successor is still written');
  assert.ok(after.rows[0].sent_at, 'the fired one retires immediately');
  assert.equal(new Date(after.rows[1].remind_at).toISOString(), '2026-08-18T16:00:00.000Z');

  await deliver(pool, first.id, 1, AT);
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  const keys = await outboxKeys(pool);
  assert.equal(keys.filter((k) => k.idempotency_key.endsWith(':2')).length, 0,
    'a daily reminder must not be chased on top of repeating');
});

// The last rung lands "tomorrow at the hour they chose", which is a wall-clock
// promise, not a 24-hour one. Computed through their timezone in Postgres so a
// DST boundary keeps the hour instead of drifting it.
test('the last rung is next-day-same-hour in the user\'s own timezone', async (t) => {
  // 2026-10-25 is the European DST fall-back. 08:00 Jerusalem on the 24th is
  // 05:00Z; 08:00 on the 25th is 06:00Z — a 25-hour gap, not 24.
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972505500006', { timezone: 'Asia/Jerusalem' });
  await withTx(pool, async (c) => {
    const tk = await tasks.addTask(c, user.id, { title: 'שעון חורף' });
    await reminders.setReminder(c, user.id, tk.data.task.id, '2026-10-24T05:00:00Z', null);
  });
  const r = await reminderRow(pool);

  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-10-24T05:01:00Z'));
  await deliver(pool, r.id, 1, '2026-10-24T05:00:00Z');
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-10-24T08:05:00Z'));
  await deliver(pool, r.id, 2, '2026-10-24T08:05:00Z');

  // 24h later is 05:00Z on the 25th — which is 07:00 local, an hour early.
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-10-25T05:30:00Z'));
  assert.equal((await outboxKeys(pool)).length, 2,
    'a flat +24h would knock on their door an hour before the hour they chose');

  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-10-25T06:05:00Z'));
  assert.equal((await outboxKeys(pool)).length, 3);
});

// Before escalation, a reminder retired on enqueue whether or not anything
// reached anyone. Now it waits for a delivery that may never come — so a rung
// the gate held or expired leaves a row that can never climb again, and
// without this backstop it would sit in list_my_reminders for ever looking
// like a reminder that had not fired yet.
test('a ladder that can no longer climb retires instead of sitting pending', async (t) => {
  const { pool, teardown } = await setup('+972505500008');
  t.after(teardown);
  const r = await reminderRow(pool);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = 'expired'
      WHERE idempotency_key = $1`, [reminders.attemptKey(r.id, 1), AT]);

  // A day on it is still legitimately mid-ladder — do not retire it early.
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-18T16:05:00Z'));
  assert.equal((await reminderRow(pool)).sent_at, null);

  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-20T16:05:00Z'));
  const done = await reminderRow(pool);
  assert.ok(done.sent_at, 'nothing can still be due, so the row stops being pending');
  assert.equal(done.attempts, 1, 'and it still records the one rung that was tried');
  assert.equal((await outboxKeys(pool)).length, 1, 'retiring sends nothing');
});

test('the ladder length is a flag, and 1 restores the old fire-once behaviour', async (t) => {
  const { pool, teardown } = await setup('+972505500007');
  t.after(teardown);
  await withTx(pool, (c) =>
    require('../src/domain/flags').setFlag(c, 'reminder_escalation_max', 1));
  const r = await reminderRow(pool);

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  assert.ok((await reminderRow(pool)).sent_at, 'one rung and it retires, exactly as before');
  await deliver(pool, r.id, 1, AT);
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.equal((await outboxKeys(pool)).length, 1);
});

// Three places ask "what reminders are still pending" and show the answer to
// somebody. `sent_at IS NULL` used to mean "has not gone out"; with a ladder it
// means "the ladder has not finished", and a row can sit there for a day having
// already been delivered. Reporting that as upcoming is a lie in each place:
// the nightly plan names a time that is behind us, the digest overcounts, and
// the dashboard flags a working reminder as overdue.
test('a reminder mid-ladder is not reported as one that has yet to fire', async (t) => {
  const { pool, teardown, user } = await setup('+972505500009');
  t.after(teardown);
  const digest = require('../src/domain/digest');
  const r = await reminderRow(pool);

  const pendingCount = async () => {
    const c = await pool.connect();
    try { return (await digest.assemble(c, user.id, 'summary')).data.counts.pendingReminders; }
    finally { c.release(); }
  };
  const planned = async () => (await pool.query(
    `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.cancelled_at IS NULL AND r.sent_at IS NULL
        AND r.attempts = 0 AND r.remind_at < now() + interval '7 days'`, [user.id])).rows[0].n;
  const overdueOnDashboard = async () => (await pool.query(
    `SELECT count(*)::int AS n FROM task_reminders r
      WHERE r.id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
        AND r.remind_at < now() AND r.attempts = 0`, [r.id])).rows[0].n;

  assert.equal(await pendingCount(), 1, 'before it fires it is genuinely pending');

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  assert.equal((await reminderRow(pool)).sent_at, null, 'still mid-ladder, by design');

  assert.equal(await pendingCount(), 0, 'the digest must not count it again');
  assert.equal(await planned(), 0, 'the plan must not announce a time already behind us');
  assert.equal(await overdueOnDashboard(), 0, 'and it is not an operator problem');
});
