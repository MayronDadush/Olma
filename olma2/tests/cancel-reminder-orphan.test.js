'use strict';
// "בטלי את התזכורת לאיסוף ילדים" and "בטלי את האיסוף" are one sentence to most
// people. A live user said the first, was told the reminder was cancelled, and
// reported the surviving task as a bug the next day. Olma did say "the task
// stays" that time — out of the model's own memory, because the tool result
// was `{reminderId}` and had nothing else in it. These tests pin the fact into
// the result, where it cannot be forgotten.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972509200001', { firstName: 'מירון' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [user.id]);
});
after(async () => { await db.teardown(); });

const soon = (h = 30) => new Date(Date.now() + h * 3600_000).toISOString().replace('Z', '+00:00');

async function taskWithReminder() {
  return withTx(db.pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לאסוף את הילדים' });
    const r = await reminders.setReminder(c, user.id, t.data.task.id, soon());
    return { taskId: t.data.task.id, reminderId: r.data.reminder.id };
  });
}

test('cancelling the last reminder on an open task says the task is still there', async () => {
  const { taskId, reminderId } = await taskWithReminder();
  const res = await withTx(db.pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  assert.equal(res.ok, true);
  assert.equal(res.data.taskStillOpen, true);
  // The title travels with it: the question Olma asks names the thing, and a
  // second round-trip to look it up is a round-trip the person waits through.
  assert.equal(res.data.task.title, 'לאסוף את הילדים');
  assert.equal(res.data.task.id, Number(taskId));
  assert.equal(res.data.remainingReminders, 0);
});

test('another pending reminder means nothing was orphaned', async () => {
  const { taskId, reminderId } = await taskWithReminder();
  await db.pool.query(
    `INSERT INTO task_reminders (task_id, remind_at) VALUES ($1, $2)`, [taskId, soon(50)]);
  const res = await withTx(db.pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  assert.equal(res.data.taskStillOpen, undefined, 'asked about a task still being raised');
  assert.equal(res.data.remainingReminders, 1);
});

test('a task already done is not offered for deletion', async () => {
  const { taskId, reminderId } = await taskWithReminder();
  await db.pool.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1`, [taskId]);
  const res = await withTx(db.pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  assert.equal(res.ok, true);
  assert.equal(res.data.taskStillOpen, undefined);
  assert.equal(res.data.task.status, 'done');
});

test('an archived task is not offered either', async () => {
  const { taskId, reminderId } = await taskWithReminder();
  await db.pool.query(`UPDATE tasks SET archived_at = now() WHERE id = $1`, [taskId]);
  const res = await withTx(db.pool, (c) => reminders.cancelReminder(c, user.id, reminderId));
  assert.equal(res.data.taskStillOpen, undefined, 'offered to delete a filed task');
});

test('somebody else\'s reminder is still not cancellable', async () => {
  const { reminderId } = await taskWithReminder();
  const other = await makeUser(db.pool, '+972509200002');
  const res = await withTx(db.pool, (c) => reminders.cancelReminder(c, other.id, reminderId));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_found');
});
