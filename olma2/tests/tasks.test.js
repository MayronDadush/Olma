'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');

let db, alice, bob;
before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972501000001');
  bob = await makeUser(db.pool, '+972501000002');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('addTask + listTasks are owner-scoped', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'buy milk' });
    assert.equal(r.ok, true);
    const mine = await tasks.listTasks(c, alice.id, {});
    assert.equal(mine.data.tasks.length, 1);
    const theirs = await tasks.listTasks(c, bob.id, {});
    assert.equal(theirs.data.tasks.length, 0); // isolation: bob never sees alice's rows
  });
});

test('one level of nesting only', async () => {
  await withClient(async (c) => {
    const parent = (await tasks.addTask(c, alice.id, { title: 'project' })).data.task;
    const child = (await tasks.addTask(c, alice.id, { title: 'sub', parentId: parent.id })).data.task;
    const grandchild = await tasks.addTask(c, alice.id, { title: 'subsub', parentId: child.id });
    assert.equal(grandchild.ok, false);
    assert.equal(grandchild.error.code, 'invalid');
  });
});

test('cannot attach a subtask to someone else\'s parent', async () => {
  await withClient(async (c) => {
    const parent = (await tasks.addTask(c, alice.id, { title: 'alice project' })).data.task;
    const sneak = await tasks.addTask(c, bob.id, { title: 'sneak', parentId: parent.id });
    assert.equal(sneak.ok, false);
    assert.equal(sneak.error.code, 'not_found'); // deliberately indistinguishable from nonexistent
  });
});

test('addTasksBulk is all-or-nothing inside a transaction', async () => {
  const { withTx } = require('../src/db/pool');
  const items = [{ title: 'a' }, { title: 'b' }, { title: '' }]; // last one invalid
  let result;
  try {
    result = await withTx(db.pool, async (c) => {
      const r = await tasks.addTasksBulk(c, alice.id, items);
      if (!r.ok) throw Object.assign(new Error('rollback'), { result: r });
      return r;
    });
  } catch (e) {
    result = e.result;
  }
  assert.equal(result.ok, false);
  await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1 AND source = 'brain_dump'`, [alice.id]);
    assert.equal(rows[0].n, 0); // nothing from the failed bulk survived
  });
});

test('completing a task auto-cancels its pending reminders', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, alice.id, { title: 'with reminders' })).data.task;
    const future = new Date(Date.now() + 3600_000).toISOString();
    await reminders.setReminder(c, alice.id, t.id, future);
    await reminders.setReminder(c, alice.id, t.id, new Date(Date.now() + 7200_000).toISOString());

    const done = await tasks.completeTask(c, alice.id, t.id);
    assert.equal(done.ok, true);
    assert.equal(done.data.remindersCancelled, 2);

    const left = await reminders.dueForSending(c, new Date(Date.now() + 86400_000).toISOString());
    assert.equal(left.data.due.filter((d) => d.task_id === t.id).length, 0);
  });
});

test('cannot set a reminder on a completed task', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, alice.id, { title: 'done deal' })).data.task;
    await tasks.completeTask(c, alice.id, t.id);
    const r = await reminders.setReminder(c, alice.id, t.id, new Date().toISOString());
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'invalid');
  });
});

test('dueForSending returns only pending, open-task reminders', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, bob.id, { title: 'bob task' })).data.task;
    const past = new Date(Date.now() - 60_000).toISOString();
    const rem = (await reminders.setReminder(c, bob.id, t.id, past)).data.reminder;

    const due = await reminders.dueForSending(c, new Date().toISOString());
    const ids = due.data.due.map((d) => d.reminder_id);
    assert.ok(ids.includes(rem.id));

    await reminders.markSent(c, rem.id);
    const due2 = await reminders.dueForSending(c, new Date().toISOString());
    assert.ok(!due2.data.due.map((d) => d.reminder_id).includes(rem.id));
  });
});

test('audit trail records the lifecycle', async () => {
  await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT event, count(*)::int AS n FROM audit_log WHERE actor_id = $1 GROUP BY event`, [alice.id]);
    const events = Object.fromEntries(rows.map((r) => [r.event, r.n]));
    assert.ok(events['task.created'] >= 3);
    assert.ok(events['task.completed'] >= 1);
    assert.ok(events['reminder.created'] >= 2);
  });
});
