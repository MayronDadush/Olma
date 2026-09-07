'use strict';
// Vered's first evening (2026-09-06): three tasks that would not have reached
// her the next morning, and a page that said they would.
//
// She opened a voice note with "אני צריכה לזכור למחר לעשות כמה משימות" and
// listed five. By the time the evening was over:
//
//  - "לדבר עם גידיס" had lost its 08:00, because she asked for a reminder
//    "בעוד דקה" — the word was נוספת, ADDITIONAL — and an explicit reminder
//    cancelled the automatic one it was standing beside.
//  - "לדבר עם אביטל" had lost its 08:00 to a reminder armed three hours in
//    the PAST: valid ISO, correct offset, already gone. It fired on the spot,
//    its outbox row expired undelivered, and on the way in it withdrew the
//    08:00 she had been promised in the same breath.
//  - "לארגן אימון לרביעי" was filed on Wednesday, because the ל־ dates the
//    TRAINING and was read as dating the organising.
//
// And the personal dashboard drew a bell on all of them, because it asked
// `sent_at IS NULL` three lines under a comment saying to ask `attempts = 0`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const userDashboard = require('../src/domain/user-dashboard');
const { datesTheObject } = require('../src/domain/datetime');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const TZ = 'Asia/Jerusalem';
// Her actual evening, pinned: nothing here may depend on the hour the suite
// runs (CLAUDE.md, Testing).
const NOW = new Date('2026-09-06T20:02:00Z');          // 23:02 in Jerusalem
const TOMORROW_8 = '2026-09-07T08:00:00+03:00';
const WEDNESDAY = '2026-09-09T08:00:00+03:00';

let seq = 300;
async function freshUser() {
  seq += 1;
  return makeUser(db.pool, `+9725000009${seq}`, { timezone: TZ });
}

async function withTask(dueAt) {
  const u = await freshUser();
  const made = await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'לדבר עם גידיס', dueAt, now: NOW,
  }));
  assert.ok(made.ok, JSON.stringify(made));
  return { u, taskId: made.data.task.id, autoId: made.data.reminders[0].id };
}

// ---- a moment already gone --------------------------------------------------

// The predicate is pure and reads a `now`, so this stays honest at any hour.
test('the moment three hours gone is recognised, and one seconds old is not', () => {
  assert.equal(reminders.momentIsPast('2026-09-06T20:02:00+03:00', NOW), true);
  assert.equal(reminders.momentIsPast(new Date(NOW.getTime() - 30_000).toISOString(), NOW), false,
    'the grace is for latency, not for mistakes');
  assert.equal(reminders.momentIsPast(TOMORROW_8, NOW), false);
});

// The refusal lives at the TOOL boundary, not in the domain: our own sweeps,
// repairs and most of this suite arm past moments on purpose. Only a model
// asking for one is a mistake — and refusing there means setReminder is never
// reached, so nothing is superseded on the way past.
test('the tool refuses a past moment and cancels nothing on its way', async () => {
  const { u, taskId, autoId } = await withTask(TOMORROW_8);
  const gone = new Date(Date.now() - 3 * 3600_000).toISOString().replace('Z', '+00:00');

  const res = await withTx(db.pool, (c) => BY_NAME.get('set_task_reminder')
    .handler(c, { id: u.id, timezone: TZ }, { task_id: taskId, remind_at: gone }));

  assert.equal(res.ok, false, 'a moment three hours gone was accepted');
  assert.equal(res.error.reason, 'remind_at_in_past');
  assert.match(res.error.message, /NOTHING was changed/, 'the refusal says the table is untouched');

  const live = await withTx(db.pool, (c) => reminders.listReminders(c, u.id, taskId));
  assert.deepEqual(live.data.reminders.map((r) => Number(r.id)), [Number(autoId)],
    'a moment we will not honour withdrew one we would have');
});

test('the same tool still arms a real moment', async () => {
  const { u, taskId } = await withTask(TOMORROW_8);
  const soon = new Date(Date.now() + 3 * 3600_000).toISOString().replace('Z', '+00:00');
  const res = await withTx(db.pool, (c) => BY_NAME.get('set_task_reminder')
    .handler(c, { id: u.id, timezone: TZ }, { task_id: taskId, remind_at: soon }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
});

// ---- replacing versus standing beside ---------------------------------------

test('an explicit reminder on ANOTHER day joins the automatic one instead of cancelling it', async () => {
  const { u, taskId, autoId } = await withTask(TOMORROW_8);

  // "תזכורת נוספת בעוד דקה" — tonight, while the automatic one is tomorrow.
  const inAMinute = new Date(NOW.getTime() + 60_000).toISOString().replace('Z', '+00:00');
  const res = await withTx(db.pool, (c) => reminders.setReminder(
    c, u.id, taskId, inAMinute, null));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.supersededAuto, 0, 'the next morning was cancelled by a reminder for tonight');

  const live = await withTx(db.pool, (c) => reminders.listReminders(c, u.id, taskId));
  assert.equal(live.data.reminders.length, 2, 'she asked for another one, not for a different one');
  assert.ok(live.data.reminders.some((r) => Number(r.id) === Number(autoId)), 'the 08:00 survived');
});

test('...and on the SAME local day it still replaces — one thing, one reminder', async () => {
  const { u, taskId, autoId } = await withTask(TOMORROW_8);
  const res = await withTx(db.pool, (c) => reminders.setReminder(
    c, u.id, taskId, '2026-09-07T19:00:00+03:00', null));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.supersededAuto, 1);

  const live = await withTx(db.pool, (c) => reminders.listReminders(c, u.id, taskId));
  assert.equal(live.data.reminders.length, 1);
  assert.notEqual(Number(live.data.reminders[0].id), Number(autoId));
});

test('a reminder that already went out is not a plan to revise, so nothing supersedes it', async () => {
  const { u, taskId, autoId } = await withTask(TOMORROW_8);
  // The ladder has started on the automatic row: delivered, `sent_at` still null.
  await db.pool.query('UPDATE task_reminders SET attempts = 1 WHERE id = $1', [autoId]);
  const res = await withTx(db.pool, (c) => reminders.setReminder(
    c, u.id, taskId, '2026-09-07T19:00:00+03:00', null));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.supersededAuto, 0, 'cancelled a reminder that had already reached her');
});

// ---- the bell ---------------------------------------------------------------

test('the page draws a bell for what is actually pending, not for what has already rung', async () => {
  const { u, taskId, autoId } = await withTask(TOMORROW_8);

  let page = await withTx(db.pool, (c) => userDashboard.load(c, u.id));
  let row = page.data.tasks.find((t) => Number(t.id) === Number(taskId));
  assert.ok(row.reminder, 'a pending reminder should show');

  // attempts = 1 with sent_at still null is the shape the escalation ladder
  // leaves behind for up to a day — and the shape that made the page lie.
  await db.pool.query('UPDATE task_reminders SET attempts = 1 WHERE id = $1', [autoId]);
  page = await withTx(db.pool, (c) => userDashboard.load(c, u.id));
  row = page.data.tasks.find((t) => Number(t.id) === Number(taskId));
  assert.equal(row.reminder, null, 'the bell outlived the reminder it stood for');
});

// ---- a date that belongs to the object --------------------------------------

test('ל+weekday dates the THING; the task filed on that day is the ambiguity worth reporting', () => {
  // The founding case, both halves.
  assert.ok(datesTheObject('לארגן אימון לרביעי', WEDNESDAY, TZ), 'Vered\'s training');
  assert.equal(datesTheObject('לארגן אימון לרביעי', '2026-09-07T09:00:00+03:00', TZ), null,
    'filed on Monday — already the right reading, and silence is the answer');

  // ב־ dates the task itself. This is the ordinary case and must never fire.
  assert.equal(datesTheObject('לדבר עם גידיס ברביעי', WEDNESDAY, TZ), null);
  assert.equal(datesTheObject('פגישה ביום רביעי', WEDNESDAY, TZ), null);

  // The same shape, a different verb, the same mistake.
  assert.ok(datesTheObject('לקבוע תור לשלישי', '2026-09-08T09:00:00+03:00', TZ));

  // Nothing to say about a task with no weekday in it at all.
  assert.equal(datesTheObject('לדבר עם גידיס', '2026-09-07T09:00:00+03:00', TZ), null);
  assert.equal(datesTheObject('לארגן אימון לרביעי', null, TZ), null);
});
