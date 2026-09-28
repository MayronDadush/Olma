'use strict';
// "כל יום ב-8 וחצי" — Dov, 2026-09-27. add_task has no repeat of its own, so
// the model armed 08:30 on add_task and then set_task_reminder(daily) at the
// same 08:30: two rows, the same message twice every first morning, and four
// rows for two tasks at 20:00 the next evening. A repeat now withdraws a
// one-off of theirs at the SAME moment, and nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');

// Two days out, on a whole minute, computed ONCE (rules/testing.md).
const AT = new Date(Math.floor((Date.now() + 2 * 86400_000) / 60_000) * 60_000);
const iso = (d) => d.toISOString().replace('Z', '+00:00');

async function rows(pool, taskId) {
  const { rows: r } = await pool.query(
    `SELECT id, repeat_rule, cancelled_at IS NOT NULL AS cancelled
       FROM task_reminders WHERE task_id = $1 ORDER BY id`, [taskId]);
  return r;
}

test('a daily at the moment a one-off already holds replaces the one-off', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972506610001', { timezone: 'Asia/Jerusalem' });
  const taskId = await withTx(pool, async (c) => {
    const task = await tasks.addTask(c, user.id, { title: 'לשתות מים וכדור סגול', remindAt: iso(AT) });
    assert.equal(task.ok, true, JSON.stringify(task.error || {}));
    const daily = await reminders.setReminder(c, user.id, task.data.task.id, iso(AT), 'daily');
    assert.equal(daily.ok, true, JSON.stringify(daily.error || {}));
    return task.data.task.id;
  });
  const r = await rows(pool, taskId);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.repeat_rule, x.cancelled]), [[null, true], ['daily', false]]);
  const { rows: audit } = await pool.query(
    `SELECT detail FROM audit_log WHERE event = 'reminder.created' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
  assert.deepEqual(audit[0].detail.supersededOneOff, [Number(r[0].id)]);
});

test('a one-off at any OTHER moment stands beside the repeat', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972506610002', { timezone: 'Asia/Jerusalem' });
  const taskId = await withTx(pool, async (c) => {
    const task = await tasks.addTask(c, user.id, { title: 'לסדר קבלות', remindAt: iso(AT) });
    await reminders.setReminder(c, user.id, task.data.task.id, iso(new Date(AT.getTime() + 3600_000)), 'daily');
    return task.data.task.id;
  });
  assert.deepEqual((await rows(pool, taskId)).map((x) => x.cancelled), [false, false]);
});

test('a second ONE-OFF at the same moment is not a repeat and withdraws nothing', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972506610003', { timezone: 'Asia/Jerusalem' });
  const taskId = await withTx(pool, async (c) => {
    const task = await tasks.addTask(c, user.id, { title: 'להתקשר לרואה חשבון', remindAt: iso(AT) });
    await reminders.setReminder(c, user.id, task.data.task.id, iso(AT), null);
    return task.data.task.id;
  });
  assert.deepEqual((await rows(pool, taskId)).map((x) => x.cancelled), [false, false]);
});
