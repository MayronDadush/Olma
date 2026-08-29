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

// Splitting a goal into its parts has to be ONE call. When it was three
// sequential add_task calls, big goals in practice got saved as a single
// undoable line — "sell 3 of my cars" — that nothing could ever complete
// halfway.
test('addTasksBulk saves a whole split under one parent, in one call', async () => {
  await withClient(async (c) => {
    const goal = (await tasks.addTask(c, alice.id, { title: 'למכור 3 רכבים' })).data.task;
    const parts = await tasks.addTasksBulk(c, alice.id,
      [{ title: 'רכב 1' }, { title: 'רכב 2' }, { title: 'רכב 3' }],
      { parentId: goal.id });
    assert.equal(parts.ok, true);
    assert.equal(parts.data.tasks.length, 3);
    assert.ok(parts.data.tasks.every((t) => Number(t.parent_id) === Number(goal.id)));
    assert.ok(parts.data.tasks.every((t) => t.source === 'breakdown'));

    const overview = await tasks.projectOverview(c, alice.id, goal.id);
    assert.equal(overview.data.subtasks.length, 3);

    // each part completes on its own — the reason to split in the first place
    const one = await tasks.completeTask(c, alice.id, parts.data.tasks[0].id);
    assert.equal(one.ok, true);
    const still = await tasks.projectOverview(c, alice.id, goal.id);
    assert.equal(still.data.project.status, 'open');
  });
});

test('a bulk split obeys the same parent rules as add_task', async () => {
  await withClient(async (c) => {
    const parent = (await tasks.addTask(c, alice.id, { title: 'goal' })).data.task;
    const sub = (await tasks.addTask(c, alice.id, { title: 'part', parentId: parent.id })).data.task;

    const deep = await tasks.addTasksBulk(c, alice.id, [{ title: 'deeper' }], { parentId: sub.id });
    assert.equal(deep.ok, false);
    assert.equal(deep.error.code, 'invalid'); // one level only

    const foreign = await tasks.addTasksBulk(c, bob.id, [{ title: 'sneak' }], { parentId: parent.id });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error.code, 'not_found');
    const bobs = await tasks.listTasks(c, bob.id, {});
    assert.equal(bobs.data.tasks.filter((t) => t.title === 'sneak').length, 0);
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

// A snooze overwrites due_at, so the audit row is the ONLY surviving record of
// the moment the person was pushing away from. Without it "moved to Sunday" is
// unreadable: two hours or the fourth postponement of the same errand look
// identical, and every later question about how this person actually treats
// deadlines has no data behind it.
test('a snooze records what it moved FROM, not only where it moved to', async () => {
  await withClient(async (c) => {
    const from = new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00');
    const to = new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace('Z', '+00:00');
    const t = (await tasks.addTask(c, alice.id, { title: 'snoozable', dueAt: from })).data.task;

    const r = await tasks.snoozeTask(c, alice.id, t.id, to);
    assert.equal(r.ok, true);
    assert.equal(new Date(r.data.task.due_at).toISOString(), new Date(to).toISOString());
    assert.ok(!('prev_due_at' in r.data.task), 'the join column must not leak to callers');

    const { rows } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'task.snoozed'
        AND detail->>'taskId' = $2::text ORDER BY id DESC LIMIT 1`, [alice.id, t.id]);
    const d = rows[0].detail;
    assert.equal(new Date(d.fromDueAt).toISOString(), new Date(from).toISOString());
    assert.equal(d.pushedMinutes, 120);
    assert.equal(d.snoozeCount, 1);
    assert.equal(d.afterReminder, false, 'nothing had nudged them — this was their own move');
  });
});

test('the second snooze knows it is the second, and that a reminder had fired', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, alice.id, {
      title: 'twice snoozed',
      dueAt: new Date(Date.now() + 3600 * 1000).toISOString().replace('Z', '+00:00'),
    })).data.task;
    const rem = (await reminders.setReminder(c, alice.id, t.id,
      new Date(Date.now() + 600 * 1000).toISOString().replace('Z', '+00:00'))).data.reminder;
    await reminders.markSent(c, rem.id);

    const step = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString().replace('Z', '+00:00');
    await tasks.snoozeTask(c, alice.id, t.id, step(4));
    await tasks.snoozeTask(c, alice.id, t.id, step(28));

    const { rows } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'task.snoozed'
        AND detail->>'taskId' = $2::text ORDER BY id`, [alice.id, t.id]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].detail.snoozeCount, 1);
    assert.equal(rows[1].detail.snoozeCount, 2);
    // Both happened after the nudge — the distinction the escalation ladder needs.
    assert.equal(rows[0].detail.afterReminder, true);
    assert.equal(rows[1].detail.afterReminder, true);
    assert.equal(rows[1].detail.pushedMinutes, 24 * 60);
  });
});

// Snoozing a task that never had a date is SETTING a date, not postponing one.
// Recording it as pushedMinutes: 0 would drag every average toward "this person
// barely postpones" using events that were not postponements at all.
test('snoozing an undated task records a null delta, not a zero', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, alice.id, { title: 'no date' })).data.task;
    const r = await tasks.snoozeTask(c, alice.id, t.id,
      new Date(Date.now() + 7200 * 1000).toISOString().replace('Z', '+00:00'));
    assert.equal(r.ok, true);
    const { rows } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'task.snoozed'
        AND detail->>'taskId' = $2::text`, [alice.id, t.id]);
    assert.equal(rows[0].detail.fromDueAt, null);
    assert.equal(rows[0].detail.pushedMinutes, null);
  });
});

test("a snooze on someone else's task records nothing at all", async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, alice.id, { title: 'alice only' })).data.task;
    const before = (await c.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE event = 'task.snoozed'`)).rows[0].n;
    const r = await tasks.snoozeTask(c, bob.id, t.id,
      new Date(Date.now() + 7200 * 1000).toISOString().replace('Z', '+00:00'));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'not_found');
    const after = (await c.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE event = 'task.snoozed'`)).rows[0].n;
    assert.equal(after, before);
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
