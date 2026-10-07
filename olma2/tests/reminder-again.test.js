'use strict';
// בר, 2026-10-05: "תתזכרי אותי מחר בבוקר לקחת את החלב לעבודה", then "תשימי עוד
// תזכורת ב8:30". Two reminders on one task, 08:00 and 08:30, and both arrived
// as "⏰ תזכורת: *לקחת את החלב לעבודה*" — the second read like the first word
// about it. The second now says "תזכורת חוזרת", and only when the first one
// actually REACHED him.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const proactive = require('../src/domain/proactive-text');
const sweeps = require('../src/jobs/sweeps');

const FIRST = '2026-10-05T05:00:00.000Z';   // 08:00 Jerusalem
const SECOND = '2026-10-05T05:30:00.000Z';  // 08:30 Jerusalem
const TICK1 = '2026-10-05T05:00:30.000Z';
const TICK2 = '2026-10-05T05:30:30.000Z';

async function setup(phone) {
  const { pool, teardown } = await freshDb();
  const user = await makeUser(pool, phone, { timezone: 'Asia/Jerusalem' });
  const ids = await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לקחת את החלב לעבודה' });
    const a = await reminders.setReminder(c, user.id, t.data.task.id, FIRST, null);
    const b = await reminders.setReminder(c, user.id, t.data.task.id, SECOND, null);
    return { taskId: t.data.task.id, first: a.data.reminder.id, second: b.data.reminder.id };
  });
  return { pool, teardown, user, ...ids };
}

async function payloadOf(pool, reminderId) {
  const { rows } = await pool.query(
    `SELECT payload FROM outbox WHERE idempotency_key = $1`, [reminders.attemptKey(reminderId, 1)]);
  assert.equal(rows.length, 1);
  return rows[0].payload;
}

test('a second reminder on the same task, after the first reached them, says "תזכורת חוזרת"', async (t) => {
  const { pool, teardown, first, second } = await setup('+972505570001');
  t.after(teardown);

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  const p1 = await payloadOf(pool, first);
  assert.equal(p1.again, undefined, 'the first one is the first word about it');
  assert.equal(proactive.reminderTemplateKey(p1), 'reminder');
  await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL WHERE idempotency_key = $1`,
    [reminders.attemptKey(first, 1), TICK1]);

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK2));
  const p2 = await payloadOf(pool, second);
  assert.equal(p2.again, true);
  assert.equal(proactive.reminderTemplateKey(p2), 'reminder_again');
  assert.equal(p2.attempt, undefined, 'still rung 1: a moment they chose, asking nothing');
  assert.equal(p2.rung, 1);
});

test('a first reminder the gate held reached nobody, so the second is still plain', async (t) => {
  const { pool, teardown, first, second } = await setup('+972505570002');
  t.after(teardown);

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK1));
  await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = 'quiet' WHERE idempotency_key = $1`,
    [reminders.attemptKey(first, 1), TICK1]);

  await withTx(pool, (c) => sweeps.sweepReminders(c, TICK2));
  const p2 = await payloadOf(pool, second);
  assert.equal(p2.again, undefined);
  assert.equal(proactive.reminderTemplateKey(p2), 'reminder');
});

test('the wording has a Hebrew and an English text, and a batch of them is the plain list', () => {
  const he = proactive.renderReminderText({ title: 'לקחת את החלב לעבודה', again: true }, null, 'he');
  assert.match(he, /^⏰ תזכורת חוזרת: \*לקחת את החלב לעבודה\*$/);
  assert.doesNotMatch(he, /בוצע/, 'a moment they chose asks nothing');
  const en = proactive.renderReminderText({ title: 'take the milk', again: true }, null, 'en');
  assert.match(en, /^⏰ Reminder again: \*take the milk\*$/);
  const list = proactive.renderReminderText({ items: ['א', 'ב'], again: true }, null, 'he');
  assert.match(list, /^⏰ \*תזכורות\*/);
});
