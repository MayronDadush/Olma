'use strict';
// A task that arrives with a moment gets its reminder without being asked
// (2026-09-04). Miron dumped five tasks on his own account; "לאסוף את הילדים"
// (tomorrow 16:00) came back as a QUESTION — "רוצה שאזכיר לך?" — and only got
// a reminder because he answered it, while "דייט עם מאיה ליום ראשון", in the
// same call and equally timed, was never offered one at all. Two tasks, one
// call, different treatment, because the doctrine said "offer" and the rest
// was up to what the model remembered.
//
// So the decision moved out of the prompt. What is under test: the WHEN is a
// pure function of the due date and the person's zone, the reflex fires for
// every timed task in the same call, an explicit reminder still wins, and none
// of it can stack two reminders onto one task.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const { autoReminderAt, isDayShaped, BULK_CAP } = require('../src/domain/auto-reminder');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const TZ = 'Asia/Jerusalem';
// A fixed instant, so nothing here depends on the hour the suite runs — the
// bug this file guards is about clocks, and a clock-dependent test for it
// would be worse than none (CLAUDE.md, Testing).
const NOW = new Date('2026-09-04T10:00:00Z');   // 13:00 in Jerusalem

// ---- the rule, without a database ------------------------------------------

test('a task with a real time is reminded an hour before, in their zone', () => {
  // 2026-09-05 16:00 Jerusalem
  const at = autoReminderAt('2026-09-05T13:00:00+00:00', TZ, NOW);
  assert.equal(new Date(at).toISOString(), '2026-09-05T12:00:00.000Z'); // 15:00 local
});

test('a whole-day task is reminded that morning, not at 23:00 the night before', () => {
  // 2026-09-06 00:00 Jerusalem — how a bare date ("Sunday") is stored.
  const at = autoReminderAt('2026-09-05T21:00:00+00:00', TZ, NOW);
  // 08:00 Jerusalem on the 6th = 05:00Z. An hour-before rule would have given
  // 2026-09-05T20:00Z, which is 23:00 the previous night.
  assert.equal(new Date(at).toISOString(), '2026-09-06T05:00:00.000Z');
});

test('day-shaped is read in THEIR zone, not UTC', () => {
  // The same instant is midnight in Jerusalem and 21:00 in London.
  assert.equal(isDayShaped('2026-09-05T21:00:00+00:00', 'Asia/Jerusalem'), true);
  assert.equal(isDayShaped('2026-09-05T21:00:00+00:00', 'Europe/London'), false);
});

test('the morning is 08:00 local even across a DST boundary', () => {
  // Israel leaves DST at 02:00 on 2026-10-25, so that day starts at +03:00 and
  // reaches 08:00 at +02:00. Flat millisecond arithmetic from local midnight
  // lands at 07:00; only reading the offset in force AT the target hour gives
  // the person the morning they would recognise.
  const { partsInZone } = require('../src/domain/datetime');
  const at = autoReminderAt('2026-10-25T00:00:00+03:00', TZ, new Date('2026-10-20T00:00:00Z'));
  assert.equal(partsInZone(TZ, new Date(at)).hh, 8);
  assert.equal(new Date(at).toISOString(), '2026-10-25T06:00:00.000Z');
});

test('nothing is armed for a moment that has already gone', () => {
  assert.equal(autoReminderAt('2026-09-04T09:00:00+00:00', TZ, NOW), null);
  // Due in 20 minutes: the hour-before moment is already behind us. Reminding
  // retroactively is worse than not reminding.
  assert.equal(autoReminderAt('2026-09-04T10:20:00+00:00', TZ, NOW), null);
});

test('a due date months out gets no reminder yet', () => {
  assert.equal(autoReminderAt('2027-03-01T09:00:00+02:00', TZ, NOW), null);
});

test('no due date, or an unparseable one, is a null answer and not a throw', () => {
  assert.equal(autoReminderAt(null, TZ, NOW), null);
  assert.equal(autoReminderAt('not a date', TZ, NOW), null);
});

// ---- the reflex, against the real database ----------------------------------

async function freshUser(phone) {
  return makeUser(db.pool, phone, { timezone: TZ, onboardedAt: new Date().toISOString() });
}

test('add_task arms the reminder itself and reports it', async () => {
  const u = await freshUser('+972500000101');
  const res = await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'לאסוף את הילדים', dueAt: '2026-09-05T16:00:00+03:00', now: NOW,
  }));
  assert.ok(res.ok);
  assert.equal(res.data.reminders.length, 1, 'the caller is told what was armed');
  assert.equal(res.data.reminders[0].auto, true);
  assert.equal(new Date(res.data.reminders[0].remind_at).toISOString(), '2026-09-05T12:00:00.000Z');
});

test('a task with no due date arms nothing, and says nothing about it', async () => {
  const u = await freshUser('+972500000102');
  const res = await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'לקנות חלב', now: NOW,
  }));
  assert.ok(res.ok);
  assert.equal(res.data.reminders, undefined);
});

test('every timed item in one dump is armed — the bug that started this', async () => {
  const u = await freshUser('+972500000103');
  const res = await withTx(db.pool, (c) => tasks.addTasksBulk(c, u.id, [
    { title: 'לאסוף את הילדים', dueAt: '2026-09-05T16:00:00+03:00' },
    { title: 'לקנות חלב וקוטג׳' },                                    // no time
    { title: 'דייט עם מאיה', dueAt: '2026-09-06T00:00:00+03:00' },     // whole-day
  ], { now: NOW }));
  assert.ok(res.ok);
  assert.equal(res.data.tasks.length, 3);
  // Two timed tasks, two reminders. Previously one of these got a reminder and
  // the other did not, in this exact call.
  assert.equal(res.data.reminders.length, 2);
  const at = res.data.reminders.map((r) => new Date(r.remind_at).toISOString()).sort();
  assert.deepEqual(at, ['2026-09-05T12:00:00.000Z', '2026-09-06T05:00:00.000Z']);
  assert.equal(res.data.autoRemindersSkipped, undefined, 'nothing was capped here');
});

test('a dump past the cap says how many it left unarmed', async () => {
  const u = await freshUser('+972500000104');
  const items = [];
  for (let i = 0; i < BULK_CAP + 3; i++) {
    items.push({ title: `משימה ${i}`, dueAt: `2026-09-0${(i % 5) + 5}T14:00:00+03:00` });
  }
  const res = await withTx(db.pool, (c) => tasks.addTasksBulk(c, u.id, items, { now: NOW }));
  assert.ok(res.ok);
  assert.equal(res.data.reminders.length, BULK_CAP);
  // The cap is REPORTED. A cap nobody is told about reads as full coverage.
  assert.equal(res.data.autoRemindersSkipped, 3);
});

test('an explicit reminder replaces the automatic one rather than joining it', async () => {
  const u = await freshUser('+972500000105');
  const made = await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'לאסוף את הילדים', dueAt: '2026-09-05T16:00:00+03:00', now: NOW,
  }));
  const autoId = made.data.reminders[0].id;

  const set = await withTx(db.pool, (c) => reminders.setReminder(
    c, u.id, made.data.task.id, '2026-09-05T08:00:00+03:00'));
  assert.ok(set.ok);
  assert.equal(set.data.supersededAuto, 1);
  assert.equal(set.data.reminder.auto, false);

  const live = await withTx(db.pool, (c) => reminders.listReminders(c, u.id, made.data.task.id));
  assert.equal(live.data.reminders.length, 1, 'one thing, one reminder');
  assert.notEqual(Number(live.data.reminders[0].id), Number(autoId));
});

test('a task that already has a reminder is left alone', async () => {
  const u = await freshUser('+972500000106');
  const t = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'משימה', now: NOW }));
  await withTx(db.pool, (c) => reminders.setReminder(
    c, u.id, t.data.task.id, '2026-09-05T08:00:00+03:00'));
  // Re-running the reflex (a retried tool call, a re-run sweep) must not stack.
  const again = await withTx(db.pool, (c) => reminders.attachAutoReminder(
    c, u.id, { id: t.data.task.id, due_at: '2026-09-05T16:00:00+03:00' }, TZ, NOW));
  assert.equal(again, null);
  const live = await withTx(db.pool, (c) => reminders.listReminders(c, u.id, t.data.task.id));
  assert.equal(live.data.reminders.length, 1);
});

test('the reminder is written in the OWNER\'s zone, not the server\'s', async () => {
  const u = await makeUser(db.pool, '+14150000107', {
    timezone: 'America/Los_Angeles', onboardedAt: new Date().toISOString(),
  });
  // Midnight in Los Angeles — a whole-day task there, an ordinary evening in UTC.
  const res = await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'school run', dueAt: '2026-09-06T00:00:00-07:00', now: NOW,
  }));
  // 08:00 Los Angeles on the 6th = 15:00Z, which only holds if the zone read
  // was theirs. Read as UTC it is not day-shaped at all and would arm 06:00Z.
  assert.equal(new Date(res.data.reminders[0].remind_at).toISOString(), '2026-09-06T15:00:00.000Z');
});
