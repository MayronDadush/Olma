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

// ── Two asks that arrived in one sentence ────────────────────────────────────
// Yahav said two things joined by ו and got one task holding both, so
// finishing the first half left a row that was neither done nor open.
test('a title that joins two asks is reported, and an ordinary one is not', () => {
  const { joinsTwoAsks } = require('../src/domain/tasks');
  assert.ok(joinsTwoAsks('לקנות חלב וגם לחם'));
  assert.ok(joinsTwoAsks('לדבר עם גידיס ואז לחזור לאבי'));
  assert.ok(joinsTwoAsks('לשלוח את המסמכים ואחר כך להתקשר לרואה חשבון'));

  // The three readings that were measured against all 202 production titles
  // and thrown away, each with the real title that killed it. A hint firing on
  // ordinary titles costs tokens on turns it does not apply to and teaches the
  // model to skim past hints — so these must stay quiet.
  assert.equal(joinsTwoAsks('להוציא את הכביסה ולתלות אותה'), false,
    'Hebrew chains infinitives inside ONE chore');
  assert.equal(joinsTwoAsks('לדבר עם מור חן ולבקש חומרי גלם'), false,
    'and inside one conversation');
  assert.equal(joinsTwoAsks('לבקש מכולם פעילויות למצגת ושמעיין תבקש החזרים מהקופה'), false,
    'here וש is the start of a name, not a conjunction');
  assert.equal(joinsTwoAsks('לקנות חלב'), false);
  assert.equal(joinsTwoAsks(''), false);
  assert.equal(joinsTwoAsks(null), false);
});

// Vered, 2026-09-07, 21:43: "אשמח לעדכון מחר בתשע בבוקר של שאר המשימות". Five
// tasks moved to 09:00 the next day — and the reminders of their OLD date, two
// rungs up their ladders, still had "זו התזכורת האחרונה" scheduled for 08:00.
// Moving the thing IS the answer to the rung: the ladder closes, the automatic
// reminder follows the date, a rung the sweep had already queued is withdrawn.
test('moving a task answers its ladder: rungs retire, the queued rung is withdrawn, the auto reminder follows the date', async () => {
  const { enqueue } = require('../src/outbox/enqueue');
  await withClient(async (c) => {
    const iso = (d) => new Date(d).toISOString().replace('Z', '+00:00');
    const HOUR = 3600_000;
    const oldDue = new Date(Date.now() + 2 * HOUR);
    const t = (await tasks.addTask(c, alice.id, { title: 'לבדוק על שחיינים', dueAt: iso(oldDue) })).data.task;
    const { rows: [auto] } = await c.query(`SELECT * FROM task_reminders WHERE task_id = $1`, [t.id]);
    assert.equal(auto.auto, true);
    // Rungs 1 and 2 went out; rung 3 is queued, held for the night.
    await reminders.recordAttempt(c, auto.id);
    await reminders.recordAttempt(c, auto.id);
    await enqueue(c, { userId: alice.id, kind: 'reminder', urgency: 'normal',
      payload: { taskId: Number(t.id), rung: 3, attempt: 3, finalAttempt: true, auto: true },
      idempotencyKey: reminders.attemptKey(auto.id, 3) });
    await c.query(`UPDATE outbox SET hold_reason = 'night', release_after = now() + interval '8 hours'
                    WHERE idempotency_key = $1`, [reminders.attemptKey(auto.id, 3)]);

    const newDue = new Date(Date.now() + 26 * HOUR);
    const r = await tasks.snoozeTask(c, alice.id, t.id, iso(newDue));
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.remindersRetired, [Number(auto.id)]);

    const { rows: [old] } = await c.query(`SELECT sent_at, cancelled_at FROM task_reminders WHERE id = $1`, [auto.id]);
    assert.ok(old.sent_at, 'retired — answered by the move, not cancelled');
    assert.equal(old.cancelled_at, null);
    const { rows: [queued] } = await c.query(`SELECT sent_at, hold_reason FROM outbox WHERE idempotency_key = $1`,
      [reminders.attemptKey(auto.id, 3)]);
    assert.ok(queued.sent_at, 'the dawn rung is withdrawn');
    assert.equal(queued.hold_reason, 'moved');

    // The automatic reminder follows the date: an hour before the new one.
    assert.equal(r.data.reminders.length, 1);
    assert.equal(new Date(r.data.reminders[0].remind_at).getTime(), newDue.getTime() - HOUR);
    assert.equal(r.data.reminders[0].auto, true);
    assert.ok(Array.isArray(r.data.remindersAt) && r.data.remindersAt.length === 1, 'the armed hour rides the result');
    const { rows: live } = await c.query(
      `SELECT id FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, [t.id]);
    assert.equal(live.length, 1, 'exactly one live reminder on the task');

    // And the sweep would not chase the retired one at what used to be its rung 3.
    const due = await reminders.dueForSending(c, new Date(Date.now() + 30 * HOUR));
    assert.ok(!due.data.due.some((d) => Number(d.reminder_id) === Number(auto.id)));
  });
});

test('a snooze leaves an explicit pending reminder alone, cancels a stale automatic one, and does not re-arm over a moment they named', async () => {
  await withClient(async (c) => {
    const iso = (d) => new Date(d).toISOString().replace('Z', '+00:00');
    const HOUR = 3600_000;
    const t = (await tasks.addTask(c, alice.id, { title: 'להתקשר לרופא', dueAt: iso(Date.now() + 2 * HOUR) })).data.task;
    // "תזכירי לי מחר ב-8" — an explicit moment on another day, standing beside the auto one.
    const named = new Date(Date.now() + 40 * HOUR);
    const rem = (await reminders.setReminder(c, alice.id, t.id, iso(named))).data.reminder;
    const before = (await c.query(`SELECT id, auto FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL`, [t.id])).rows;
    assert.equal(before.length, 2, 'auto and explicit, different days');

    const r = await tasks.snoozeTask(c, alice.id, t.id, iso(Date.now() + 30 * HOUR));
    assert.equal(r.ok, true);
    assert.equal(r.data.remindersRetired, undefined, 'nothing was mid-ladder');
    assert.equal(r.data.reminders, undefined, 'they named a moment, so no automatic one is armed over it');
    const { rows: live } = await c.query(
      `SELECT id, auto, remind_at FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, [t.id]);
    assert.equal(live.length, 1);
    assert.equal(Number(live[0].id), Number(rem.id), 'the one they set is the one that stays');
    assert.equal(new Date(live[0].remind_at).getTime(), named.getTime());
  });
});

test('a snooze onto the same instant moves nothing and retires nothing', async () => {
  await withClient(async (c) => {
    const iso = (d) => new Date(d).toISOString().replace('Z', '+00:00');
    const due = new Date(Date.now() + 5 * 3600_000);
    const t = (await tasks.addTask(c, alice.id, { title: 'same', dueAt: iso(due) })).data.task;
    const { rows: [auto] } = await c.query(`SELECT id FROM task_reminders WHERE task_id = $1`, [t.id]);
    await reminders.recordAttempt(c, auto.id);
    const r = await tasks.snoozeTask(c, alice.id, t.id, iso(due));
    assert.equal(r.ok, true);
    const { rows: [same] } = await c.query(`SELECT sent_at FROM task_reminders WHERE id = $1`, [auto.id]);
    assert.equal(same.sent_at, null);
  });
});
