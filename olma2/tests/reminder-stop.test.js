'use strict';
// "תפסיק עם התזכורות לזמן הקרוב / תזכורת הבאה רק ביום שני" — sent at 08:01 on
// 2026-09-09, as a WhatsApp reply quoting the reminder that had landed sixty
// seconds earlier. Olma answered "ביטלתי" and named two reminders on OTHER
// tasks; the one she had been asked to stop kept climbing, and the person
// reported it as "זה לא עבד כי הוא המשיך להזכיר לי".
//
// The model was not wrong and the prompt was not the problem. A one-off
// reminder that has delivered rung 1 sits with `attempts = 1, sent_at NULL`,
// and EVERY read path filters `attempts = 0` — list_my_reminders, list_my
// _tasks, the digest, the personal dashboard. That filter is right for the
// question those four ask ("an hour Olma may promise": incidents.md, "A
// hundred and five pending reminders") and it silently answers a second
// question with it — "what is still going to reach you" — for which it is
// wrong. So the one row that was about to send two more messages was the one
// row nothing could name, and cancel_reminder needs an id.
//
// This file holds open the two halves of the fix: the chase is findable, and
// stopping it actually stops it — outbox rows included, because the ladder
// dies on the reminder row while its already-queued rung stays deliverable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');
const { createBrokerServer } = require('../src/brokerd/server');

const AT = '2026-08-17T16:00:00Z';         // the moment they asked for
const TICK1 = '2026-08-17T16:01:00Z';      // rung 1 goes out
const PLUS_3H = '2026-08-17T19:05:00Z';    // rung 2 is due

async function addReminder(pool, userId, title, at = AT) {
  return withTx(pool, async (c) => {
    const t = await tasks.addTask(c, userId, { title });
    const r = await reminders.setReminder(c, userId, t.data.task.id, at);
    return { taskId: t.data.task.id, reminderId: Number(r.data.reminder.id) };
  });
}

// Mark a rung as genuinely delivered — hold_reason IS NULL is what separates
// "reached them" from held, dropped or expired, and only a delivered rung
// lets the ladder climb.
async function deliver(pool, reminderId, attempt, atIso) {
  const { rowCount } = await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL
      WHERE idempotency_key = $1`, [reminders.attemptKey(reminderId, attempt), atIso]);
  assert.equal(rowCount, 1, `expected an outbox row for rung ${attempt}`);
}

async function keysFor(pool, reminderId) {
  const { rows } = await pool.query(
    `SELECT idempotency_key, hold_reason FROM outbox
      WHERE idempotency_key = $1 OR idempotency_key LIKE $2 ORDER BY id`,
    [`reminder:${reminderId}`, `reminder:${reminderId}:%`]);
  return rows;
}

// The state the whole file is about, reached the way production reaches it:
// the sweep enqueued rung 1 and the worker delivered it. Never written by
// hand — a fixture that sets `attempts = 1` itself would pass over a ladder
// that no sweep could ever produce.
async function chasingSetup(phone, title = 'לדבר עם אסתר על הצילומים') {
  const { pool, teardown } = await freshDb();
  const user = await makeUser(pool, phone);
  const { taskId, reminderId } = await addReminder(pool, user.id, title);
  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  await deliver(pool, reminderId, 1, AT);
  return { pool, teardown, user, taskId, reminderId };
}

test('a reminder that is chasing somebody can be found and named', async (t) => {
  const { pool, teardown, user, taskId, reminderId } = await chasingSetup('+972505600001');
  t.after(teardown);

  const res = await withTx(pool, (c) => reminders.listReminders(c, user.id));
  assert.equal(res.data.reminders.length, 0,
    'it is no longer an hour to promise anybody — rung 1 is behind us');
  assert.equal(res.data.chasing.length, 1, 'but it is still going to send two more messages');
  const [c0] = res.data.chasing;
  assert.equal(c0.id, reminderId, 'and cancel_reminder needs exactly this');
  assert.equal(c0.taskId, taskId);
  assert.equal(c0.rungsSent, 1);
  assert.equal(c0.askedFor, new Date(AT).toISOString(),
    'the moment THEY chose — never a guess at when the next rung lands');
});

test('cancelling the chase stops it, and the task is left exactly as it was', async (t) => {
  const { pool, teardown, user, taskId, reminderId } = await chasingSetup('+972505600002');
  t.after(teardown);

  const res = await withTx(pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  assert.equal(res.ok, true, 'a mid-ladder reminder is cancellable — it was never sent_at');

  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.deepEqual((await keysFor(pool, reminderId)).map((r) => r.idempotency_key),
    [`reminder:${reminderId}`], 'rung 2 never happens');

  const { rows } = await pool.query(`SELECT status, archived_at FROM tasks WHERE id = $1`, [taskId]);
  assert.equal(rows[0].status, 'open', '"stop reminding me" is not "drop it"');
  assert.equal(rows[0].archived_at, null);
});

test('a rung already sitting in the outbox goes down with the cancel', async (t) => {
  // The ladder dies on the reminder row the moment cancelled_at is set —
  // dueForSending filters on it — but a rung the sweep ALREADY enqueued is a
  // message the worker will still deliver. The gate holds a follow-up rung
  // all night (it is Olma's moment, not theirs), so the window where one is
  // queued and unsent is hours wide. "ביטלתי" followed by the reminder is the
  // same broken promise as never cancelling at all.
  const { pool, teardown, user, reminderId } = await chasingSetup('+972505600003');
  t.after(teardown);

  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  const queued = await keysFor(pool, reminderId);
  assert.equal(queued.length, 2, 'rung 2 is enqueued and not yet delivered');

  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  const after = await keysFor(pool, reminderId);
  const rung2 = after.find((r) => r.idempotency_key === `reminder:${reminderId}:2`);
  assert.equal(rung2.hold_reason, 'cancelled', 'withdrawn, never deleted — the key is what stops the sweep re-making it');
  const { rows } = await pool.query(
    `SELECT sent_at FROM outbox WHERE idempotency_key = $1`, [`reminder:${reminderId}:2`]);
  assert.ok(rows[0].sent_at, 'a withdrawn row is closed, so the worker will not pick it up');
});

test('cancelling a different reminder leaves this one climbing — the incident, exactly', async (t) => {
  // What Olma could see on 2026-09-09 was two reminders on two other tasks.
  // She cancelled both, said so, and the ladder she had been asked to stop
  // sent its next rung on schedule.
  const { pool, teardown, user, reminderId } = await chasingSetup('+972505600004');
  t.after(teardown);
  const other = await addReminder(pool, user.id, 'להוציא דיסק לאבא', '2026-08-20T09:00:00Z');

  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, other.reminderId));
  await withTx(pool, (c) => sweeps.sweepReminders(c, PLUS_3H));
  assert.equal((await keysFor(pool, reminderId)).length, 2,
    'cancelling what you can see is not cancelling what is chasing them');

  // And now the id that was missing does the job.
  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-18T16:05:00Z'));
  assert.equal((await keysFor(pool, reminderId)).length, 2, 'no rung 3');
});

test('"the next one only on Monday" is a cancel and a new moment, and both survive', async (t) => {
  const { pool, teardown, user, taskId, reminderId } = await chasingSetup('+972505600005');
  t.after(teardown);
  const monday = '2026-08-24T09:00:00+03:00';

  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  const set = await withTx(pool, (c) => reminders.setReminder(c, user.id, taskId, monday));
  assert.equal(set.ok, true);

  const res = await withTx(pool, (c) => reminders.listReminders(c, user.id));
  assert.equal(res.data.chasing, undefined, 'nothing is chasing them any more');
  assert.equal(res.data.reminders.length, 1, 'and Monday is the one hour left to say');
  assert.equal(new Date(res.data.reminders[0].remind_at).toISOString(),
    new Date(monday).toISOString());
});

test('a retired or completed ladder is not a chase', async (t) => {
  const { pool, teardown, user, taskId, reminderId } = await chasingSetup('+972505600006');
  t.after(teardown);

  await withTx(pool, (c) => tasks.completeTask(c, user.id, taskId));
  const res = await withTx(pool, (c) => reminders.listReminders(c, user.id));
  assert.equal(res.data.chasing, undefined,
    'done is done — the field is absent, not empty, so it costs nothing on the calls it does not apply to');
  assert.equal(reminderId > 0, true);
});

test('the turn that answers a reminder carries the id needed to stop it', async (t) => {
  // The hint fires on exactly this turn already — "a bare סיימתי is probably
  // about the newest one" — and until this it handed over a title and nothing
  // to act on. Driven through brokerd, because turn_start is where the model
  // meets it.
  const { pool, teardown, user, taskId, reminderId } = await chasingSetup('+972505600007');
  t.after(teardown);
  const broker = createBrokerServer({ pool });
  // The turn only carries reminders delivered in the last day, off the real
  // clock; the ladder above runs on fixed instants so it cannot depend on the
  // hour the suite runs. Move the delivered rung into that window and nothing
  // else changes.
  await pool.query(
    `UPDATE outbox SET sent_at = now() - interval '10 minutes' WHERE idempotency_key = $1`,
    [reminders.attemptKey(reminderId, 1)]);

  const res = await broker.dispatch(
    { id: 1, method: 'tool_call', params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    { opened: false, counted: false });
  assert.equal(res.ok, true, res.text);
  const data = JSON.parse(res.text.replace(/^OK /, ''));

  const [recent] = data.recentReminders;
  assert.equal(recent.stillChasing, true);
  assert.equal(recent.reminderId, reminderId);
  assert.equal(recent.taskId, taskId);
  assert.match(data.hints.stillChasing, /cancel_reminder/,
    'the flag never travels without the thing to do about it');

  // Once it is stopped, the turn stops saying so — the reminder is still
  // recent context for a "סיימתי", it is simply no longer actionable.
  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  const after = await broker.dispatch(
    { id: 2, method: 'tool_call', params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    { opened: false, counted: false });
  const d2 = JSON.parse(after.text.replace(/^OK /, ''));
  assert.equal(d2.recentReminders[0].stillChasing, undefined);
  assert.equal(d2.hints.stillChasing, undefined);
});
