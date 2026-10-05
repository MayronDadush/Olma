'use strict';
// A repeating EVENT (migration 111). Dov, 2026-10-05: a course on Mondays and
// Thursdays, 17:30-21:30, from 12.10, "שיהיה קבוע". Before this an event was one
// moment, and Olma saved one event plus a weekly REMINDER — the course was on
// his list once.
//
// Every moment here is a fixed date in 2030, and every function is handed its
// `now`, so nothing depends on the day the suite runs. 27.10.2030 is the night
// Israel leaves summer time, which is why the Monday series is walked across it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const sweeps = require('../src/jobs/sweeps');
const listBlock = require('../src/domain/list-block');
const dt = require('../src/domain/datetime');

let db, dov;
before(async () => {
  db = await freshDb();
  dov = await makeUser(db.pool, '+972501000311', { firstName: 'Dov' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [dov.id]);
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
const local = (d) => {
  const p = dt.partsInZone('Asia/Jerusalem', new Date(d));
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}`;
};
const NOW = new Date('2030-10-10T09:00:00+03:00');

test('two weekdays are two events, and the same title twice is not a duplicate', async () => {
  const mon = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'קורס', dueAt: '2030-10-14T17:30:00+03:00', endsAt: '2030-10-14T21:30:00+03:00',
    repeat: 'weekly', now: NOW,
  }));
  assert.ok(mon.ok, JSON.stringify(mon));
  assert.equal(mon.data.task.kind, 'event');
  // Pinned to the weekday the first occurrence falls on, in HIS zone.
  assert.equal(mon.data.task.repeat_rule, 'weekly:MO');

  const thu = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'קורס', dueAt: '2030-10-17T17:30:00+03:00', endsAt: '2030-10-17T21:30:00+03:00',
    repeat: 'weekly:TH', now: NOW,
  }));
  assert.ok(thu.ok, JSON.stringify(thu));
  assert.equal(thu.data.task.repeat_rule, 'weekly:TH');

  // A retried call carries the same moment and is still refused.
  const again = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'קורס', dueAt: '2030-10-17T17:30:00+03:00', endsAt: '2030-10-17T21:30:00+03:00',
    repeat: 'weekly:TH', now: NOW,
  }));
  assert.equal(again.ok, false);
  assert.equal(again.error.reason, 'duplicate');
});

test('what one row cannot say is refused, never guessed', async () => {
  const both = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'סדנה', dueAt: '2030-10-14T10:00:00+03:00', repeat: 'weekly:MO,TH', now: NOW,
  }));
  assert.equal(both.ok, false);
  assert.match(both.error.message, /once per day/);

  const clash = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'סדנה', dueAt: '2030-10-14T10:00:00+03:00', repeat: 'weekly:TH', now: NOW,
  }));
  assert.equal(clash.ok, false);
  assert.match(clash.error.message, /falls on MO/);

  const undated = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'סדנה', repeat: 'weekly', now: NOW,
  }));
  assert.equal(undated.ok, false);

  const todo = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'לשטוף כלים', kind: 'todo', dueAt: '2030-10-14T10:00:00+03:00', repeat: 'daily', now: NOW,
  }));
  assert.equal(todo.ok, false);

  const { rows } = await db.pool.query(`SELECT 1 FROM tasks WHERE owner_id = $1 AND title IN ('סדנה', 'לשטוף כלים')`, [dov.id]);
  assert.equal(rows.length, 0, 'nothing refused was written');
});

test('when an occurrence ends the sweep moves it on, across a clock change, and keeps the hour', async () => {
  const { rows: [mon] } = await db.pool.query(
    `SELECT * FROM tasks WHERE owner_id = $1 AND repeat_rule = 'weekly:MO'`, [dov.id]);
  // Bound to a Google event that has now happened: it must stay there.
  await db.pool.query(`UPDATE tasks SET calendar_event_id = 'olmaold' WHERE id = $1`, [mon.id]);

  // Monday 14.10, 22:00 — the class is over.
  await withClient((c) => sweeps.sweepFinishedTasks(c, '2030-10-14T19:00:00Z'));
  let { rows: [row] } = await db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [mon.id]);
  assert.equal(row.status, 'open');
  assert.equal(row.archived_at, null);
  assert.equal(local(row.due_at), '2030-10-21 17:30');
  assert.equal(local(row.ends_at), '2030-10-21 21:30');
  assert.equal(row.calendar_event_id, null, 'the next one is created fresh; the past one is left alone');

  // The automatic reminder followed it to the new occurrence.
  const { rows: rem } = await db.pool.query(
    `SELECT remind_at FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, [mon.id]);
  assert.equal(rem.length, 1);
  assert.equal(local(rem[0].remind_at), '2030-10-21 16:30');

  // 21.10 → 28.10 crosses 27.10, the end of summer time: still 17:30 local.
  await withClient((c) => sweeps.sweepFinishedTasks(c, '2030-10-21T19:00:00Z'));
  ({ rows: [row] } = await db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [mon.id]));
  assert.equal(local(row.due_at), '2030-10-28 17:30');
  assert.equal(local(row.ends_at), '2030-10-28 21:30');
});

test('a sweep that was away for weeks lands on the next REAL occurrence', async () => {
  const { rows: [thu] } = await db.pool.query(
    `SELECT * FROM tasks WHERE owner_id = $1 AND repeat_rule = 'weekly:TH'`, [dov.id]);
  await withClient((c) => sweeps.sweepFinishedTasks(c, '2030-11-05T12:00:00Z'));
  const { rows: [row] } = await db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [thu.id]);
  assert.equal(local(row.due_at), '2030-11-07 17:30');
});

test('past repeat_until the series closes like any event', async () => {
  const res = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'חוג', dueAt: '2030-10-15T18:00:00+03:00', endsAt: '2030-10-15T19:00:00+03:00',
    repeat: 'weekly', repeatUntil: '2030-10-20T23:59:00+03:00', now: NOW,
  }));
  assert.ok(res.ok);
  await withClient((c) => sweeps.sweepFinishedTasks(c, '2030-10-15T17:00:00Z'));
  const { rows: [row] } = await db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [res.data.task.id]);
  assert.equal(row.status, 'done');
  assert.ok(row.archived_at);
});

test('"done" on one occurrence moves the series on rather than ending it', async () => {
  const res = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'יוגה', dueAt: '2030-10-16T07:00:00+03:00', repeat: 'daily', now: NOW,
  }));
  const done = await withClient((c) => tasks.completeTask(c, dov.id, res.data.task.id,
    { now: new Date('2030-10-16T05:00:00Z') }));
  assert.ok(done.ok);
  assert.equal(done.data.recurring, true);
  assert.equal(local(done.data.nextDueAt), '2030-10-17 07:00');
});

test('the list draws the cadence beside the next occurrence', async () => {
  const listed = await withClient((c) => tasks.listTasks(c, dov.id, {}));
  const block = listBlock.renderTaskListBlock(listed.data,
    { locale: 'he', timezone: 'Asia/Jerusalem', channelType: 'whatsapp', now: new Date('2030-10-27T09:00:00Z') });
  assert.match(block, /קורס, כל יום שני/);
  assert.match(block, /קורס, כל יום חמישי/);
});

test('the page is handed the event\'s rule, apart from any reminder\'s', async () => {
  const dash = require('../src/domain/user-dashboard');
  const page = await withClient((c) => dash.load(c, dov.id));
  assert.ok(page.ok, JSON.stringify(page));
  const courses = page.data.tasks.filter((x) => x.title === 'קורס');
  assert.deepEqual(courses.map((x) => x.repeat).sort(), ['weekly:MO', 'weekly:TH']);
  const yoga = page.data.tasks.find((x) => x.title === 'יוגה');
  assert.equal(yoga.repeat, 'daily');
  assert.equal(yoga.repeatUntil, null);
});

test('moving a repeating event\'s date moves the series, and it cannot lose its date', async () => {
  const res = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'חוג ציור', dueAt: '2030-10-14T18:00:00+03:00', endsAt: '2030-10-14T19:00:00+03:00',
    repeat: 'weekly', now: NOW,
  }));
  assert.equal(res.data.task.repeat_rule, 'weekly:MO');
  const id = res.data.task.id;

  // Monday → Tuesday: a Tuesday class from now on, not one Tuesday and back.
  const moved = await withClient((c) => tasks.editTask(c, dov.id, id, { dueAt: '2030-10-15T18:00:00+03:00', endsAt: '2030-10-15T19:00:00+03:00' }));
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(moved.data.task.repeat_rule, 'weekly:TU');
  await withClient((c) => sweeps.sweepFinishedTasks(c, '2030-10-15T17:00:00Z'));
  const { rows: [row] } = await db.pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  assert.equal(local(row.due_at), '2030-10-22 18:00');

  // Only the hour: the day and the rule stay.
  const hour = await withClient((c) => tasks.editTask(c, dov.id, id, { dueAt: '2030-10-22T19:00:00+03:00', endsAt: '2030-10-22T20:00:00+03:00' }));
  assert.equal(hour.data.task.repeat_rule, 'weekly:TU');

  const cleared = await withClient((c) => tasks.editTask(c, dov.id, id, { dueAt: null }));
  assert.equal(cleared.ok, false);
  assert.equal(cleared.error.reason, 'repeat_needs_date');
  const { rows: [still] } = await db.pool.query(`SELECT due_at, repeat_rule FROM tasks WHERE id = $1`, [id]);
  assert.equal(local(still.due_at), '2030-10-22 19:00');
  assert.equal(still.repeat_rule, 'weekly:TU');
});

test('a monthly series follows its date to the new day of the month', async () => {
  const res = await withClient((c) => tasks.addTask(c, dov.id, {
    title: 'ועד בית', dueAt: '2030-10-31T20:00:00+02:00', repeat: 'monthly:last', now: NOW,
  }));
  assert.ok(res.ok, JSON.stringify(res));
  const id = res.data.task.id;
  // 30.11 is the last day of November, so "the last day" still holds.
  let ed = await withClient((c) => tasks.editTask(c, dov.id, id, { dueAt: '2030-11-30T20:00:00+02:00' }));
  assert.equal(ed.data.task.repeat_rule, 'monthly:last');
  ed = await withClient((c) => tasks.editTask(c, dov.id, id, { dueAt: '2030-11-12T20:00:00+02:00' }));
  assert.equal(ed.data.task.repeat_rule, 'monthly:12');
});
