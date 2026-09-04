'use strict';
// The dashboard's write half. Two things are being pinned here more than the
// happy paths: that an imported task cannot be quietly edited into a lie, and
// that a paused account cannot be given a reminder the delivery gate will drop.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const tasks = require('../src/domain/tasks');

let db, me;
const tx = (fn) => withTx(db.pool, fn);
const act = (action, payload) => tx((c) => write.perform(c, me.id, action, payload));
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, '+00:00');

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531920001', { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
});
after(async () => { if (db) await db.teardown(); });

const mkTask = async (extra = {}) => {
  const r = await tx((c) => tasks.addTask(c, me.id, { title: 'לקנות חלב', ...extra }));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.task;
};

test('an unknown action is refused before anything runs', async () => {
  for (const bad of ['drop', 'constructor', '__proto__', 'toString', '']) {
    const r = await act(bad, {});
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(r.error.code, 'invalid');
  }
});

test('a task written here is marked as written here', async () => {
  const r = await act('addTask', { title: 'להזמין צמיגים' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.task.source, 'dashboard',
    'a row typed on the page is indistinguishable from one said in chat');
});

test('an edit changes only what it names', async () => {
  const t = await mkTask({ category: 'home', dueAt: iso(86400e3) });
  const r = await act('editTask', { taskId: t.id, title: 'לקנות לחם' });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.task.title, 'לקנות לחם');
  assert.equal(r.data.task.category, 'home', 'an untouched field was cleared');
  assert.notEqual(r.data.task.due_at, null, 'the due date was wiped by a rename');
});

test('null clears a field and undefined leaves it — the difference is the point', async () => {
  const t = await mkTask({ category: 'home', dueAt: iso(86400e3) });
  const r = await act('editTask', { taskId: t.id, dueAt: null });
  assert.equal(r.ok, true);
  assert.equal(r.data.task.due_at, null);
  assert.equal(r.data.task.category, 'home');
});

test('a bare local time is refused here exactly as it is in add_task', async () => {
  const t = await mkTask();
  const r = await act('editTask', { taskId: t.id, dueAt: '2026-09-20T15:00:00' });
  assert.equal(r.ok, false, 'a time with no offset was accepted');
});

test('a title cannot be emptied, and another person\'s task cannot be touched', async () => {
  const t = await mkTask();
  assert.equal((await act('editTask', { taskId: t.id, title: '   ' })).ok, false);
  const other = await makeUser(db.pool, '+972531920002');
  const theirs = await tx((c) => tasks.addTask(c, other.id, { title: 'שלהם' }));
  const r = await act('editTask', { taskId: theirs.data.task.id, title: 'שלי עכשיו' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found', 'ownership leaked through the error');
});

test('a field the source does not have is refused as unsupported', async () => {
  // Slack carries a date and who it involves, and nothing else this page edits.
  const t = await mkTask({ source: 'slack' });
  const r = await act('editTask', { taskId: t.id, category: 'work' });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'unsupported_by_source');
  assert.equal(r.error.source, 'slack');
});

test('a field the source DOES have is still refused, and says why', async () => {
  const t = await mkTask({ source: 'monday' });
  const r = await act('editTask', { taskId: t.id, dueAt: iso(86400e3) });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'no_writeback',
    'an imported field was edited locally, to be erased by the next sync');
});

test('an origin we do not model is the person\'s own writing', async () => {
  const t = await mkTask({ source: 'chat' });
  assert.equal((await act('editTask', { taskId: t.id, title: 'משהו אחר' })).ok, true);
});

test('an imported task can still be reminded about — the reminder is ours', async () => {
  const t = await mkTask({ source: 'monday' });
  const r = await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
});

test('a paused account is not given a reminder that would be silently dropped', async () => {
  const t = await mkTask();
  assert.equal((await act('pause', {})).ok, true);
  const r = await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) });
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'paused', 'the page has nothing to offer without a reason');
  // Cancelling always works: it only ever reduces what Olma will send.
  const live = await db.pool.query(
    `SELECT id FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL`, [t.id]);
  if (live.rows[0]) {
    assert.equal((await act('cancelReminder', { reminderId: live.rows[0].id })).ok, true);
  }
  assert.equal((await act('resume', {})).ok, true);
  assert.equal((await act('setReminder', { taskId: t.id, remindAt: iso(3600e3) })).ok, true);
});

test('a timezone picked here is confirmed, and repairs what the guess converted', async () => {
  const u = await makeUser(db.pool, '+972531920003', { firstName: 'Sarah' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', timezone_confirmed = false WHERE id = $1`, [u.id]);
  const t = await tx((c) => tasks.addTask(c, u.id, { title: 'brunch', dueAt: iso(4 * 86400e3) }));
  const r = await tx((c) => write.perform(c, u.id, 'setTimezone', { timezone: 'America/Los_Angeles' }));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.confirmed, true, 'a person picking their own city is not a guess');
  assert.equal(r.data.movedTasks.length >= 1, true,
    'the zone was corrected and the rows it had already converted were left wrong');
  assert.equal(String(r.data.movedTasks[0].id ?? r.data.movedTasks[0]), String(t.data.task.id));
});

test('every write leaves a trail saying it came from the dashboard', async () => {
  const t = await mkTask();
  await act('completeTask', { taskId: t.id });
  const { rows } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event = 'dashboard.completeTask'`, [me.id]);
  assert.equal(rows.length >= 1, true,
    'an operator cannot tell a person tapping their phone from their agent acting for them');
});

test('the payload can never name the actor', async () => {
  const other = await makeUser(db.pool, '+972531920004');
  const r = await act('addTask', { title: 'שלהם', userId: other.id, ownerId: other.id });
  assert.equal(r.ok, true);
  assert.equal(String(r.data.task.owner_id), String(me.id),
    'a user id in the payload moved the write to another account');
});

test('the read model sees what the write model just did', async () => {
  const r = await act('addTask', { title: 'לבדוק מהדף' });
  const page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.ok, true);
  assert.equal(page.data.tasks.some((x) => String(x.id) === String(r.data.task.id)), true);
});
