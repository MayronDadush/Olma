'use strict';
// A task can now say where it STOPS, and say what KIND of thing it is — and
// those two together are what let something leave the list on its own.
//
// The whole risk of this feature sits in one asymmetry: a job wrongly left on
// the list costs a glance, and a moment wrongly guessed archives something
// somebody still had to do. Most of these tests are about that direction.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const taskKind = require('../src/domain/task-kind');
const taskCalendar = require('../src/domain/task-calendar');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');
const flags = require('../src/domain/flags');

let db, ana;
before(async () => {
  db = await freshDb();
  ana = await makeUser(db.pool, '+972501000081', { firstName: 'Ana' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
// Offsets from now, stated the way every tool requires: with an offset.
// One clock for the whole file, frozen at load and rounded to the second the
// same way the value is. Two at() calls a few lines apart used to straddle a
// second boundary on the box and fail a deploy by exactly one second — twice
// on 2026-09-05. Relative moments stay relative; they simply agree with each
// other.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const at = (hours) => new Date(NOW + hours * 3600_000).toISOString().replace(/\.\d+Z$/, '+00:00');

// ------------------------------------------------------------------ the kind

test('the verb decides, so booking an appointment is not an appointment', () => {
  // The whole distinction lives here. Both sentences are about a doctor.
  assert.equal(taskKind.decideKind({ title: 'תור רופא' }), 'event');
  assert.equal(taskKind.decideKind({ title: 'לקבוע תור לרופא שיניים' }), 'todo');
  assert.equal(taskKind.decideKind({ title: 'פגישה עם הבנק' }), 'event');
  assert.equal(taskKind.decideKind({ title: 'לתאם פגישה עם הבנק' }), 'todo');
  assert.equal(taskKind.decideKind({ title: 'Book a dentist appointment' }), 'todo');
  assert.equal(taskKind.decideKind({ title: 'Dentist appointment' }), 'event');
});

test('real production titles, and the default is always todo', () => {
  const cases = [
    ['משמרת - ראשון 12:00-19:00', 'event'],
    ['היפגש עם חברה', 'event'],
    ['Brunch with a friend', 'event'],
    // Everything below is a job, or is unreadable — and either way must never
    // be swept off somebody's list.
    ['לאסוף את הילדים', 'todo'],
    ['לתאם דייט עם מאיה ליום שני', 'todo'],
    ['לעזור לשרה במעבר דירה', 'todo'],
    ['שיחת טלפון עם רופא', 'todo'],
    ['נוח', 'todo'],
    ['רכב 2 - השלמת בדיקה ומכירה', 'todo'],
    ['', 'todo'],
  ];
  for (const [title, want] of cases) {
    assert.equal(taskKind.decideKind({ title }), want, title);
  }
});

test('a task records the kind it was judged to be', async () => {
  await withClient(async (c) => {
    const ev = await tasks.addTask(c, ana.id, { title: 'תור לרופא', dueAt: at(2) });
    const td = await tasks.addTask(c, ana.id, { title: 'לקבוע תור לרופא', dueAt: at(2) });
    assert.equal(ev.data.task.kind, 'event');
    assert.equal(td.data.task.kind, 'todo');
  });
});

// ----------------------------------------------------------------- the range

test('a shift is a title and two times, not hours typed into a title', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(24), endsAt: at(31) });
    assert.equal(r.ok, true);
    assert.equal(new Date(r.data.task.ends_at).toISOString(), new Date(at(31)).toISOString());
  });
});

test('half a range, or a backwards one, is refused rather than stored', async () => {
  await withClient(async (c) => {
    const noStart = await tasks.addTask(c, ana.id, { title: 'משמרת', endsAt: at(31) });
    assert.equal(noStart.ok, false);
    assert.match(noStart.error.message, /needs a due_at/);

    const backwards = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(31), endsAt: at(24) });
    assert.equal(backwards.ok, false);

    const zero = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(24), endsAt: at(24) });
    assert.equal(zero.ok, false, 'an event that ends when it starts is not a range');

    const bare = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(24), endsAt: '2026-09-09T19:00:00' });
    assert.equal(bare.ok, false, 'a bare local time is refused at both ends, not just the start');
  });
});

test('editing one end is checked against the end already stored', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(24), endsAt: at(31) });
    const id = r.data.task.id;
    // Moving only the START past the stored end is exactly as broken as
    // writing the pair that way, and a check that looked only at the patch
    // would let it through.
    const bad = await tasks.editTask(c, ana.id, id, { dueAt: at(40) });
    assert.equal(bad.ok, false);

    // One moment, computed once: at() is relative to now, and computing it
    // twice across a second boundary failed a production deploy on
    // 2026-09-05 by exactly one second.
    const end = at(33);
    const good = await tasks.editTask(c, ana.id, id, { endsAt: end });
    assert.equal(good.ok, true);
    assert.equal(new Date(good.data.task.ends_at).toISOString(), new Date(end).toISOString());
  });
});

test('clearing the start clears the end with it', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, ana.id, { title: 'משמרת', dueAt: at(24), endsAt: at(31) });
    const cleared = await tasks.editTask(c, ana.id, r.data.task.id, { dueAt: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.data.task.ends_at, null, 'an end with nothing to end is not a time');
  });
});

test('the calendar event uses the real end, not a thirty-minute guess', () => {
  const start = '2026-09-09T09:00:00.000Z';
  const stop = '2026-09-09T16:00:00.000Z';
  assert.equal(taskCalendar.windowFor(start, stop).end, stop);
  // ...and still guesses when there is nothing to use.
  assert.equal(taskCalendar.windowFor(start, null).end, '2026-09-09T09:30:00.000Z');
  assert.equal(taskCalendar.windowFor(start, start).end, '2026-09-09T09:30:00.000Z');
});

// ------------------------------------------------------ the last box ticked

test('ticking the last subtask finishes the project', async () => {
  await withClient(async (c) => {
    const p = await tasks.addTask(c, ana.id, { title: 'סופר' });
    const pid = p.data.task.id;
    const kids = await tasks.addTasksBulk(c, ana.id,
      [{ title: 'ירקות' }, { title: 'פירות' }], { parentId: pid });

    const first = await tasks.completeTask(c, ana.id, kids.data.tasks[0].id);
    assert.equal(first.data.parentCompleted, undefined, 'not while one is still open');

    const last = await tasks.completeTask(c, ana.id, kids.data.tasks[1].id);
    assert.deepEqual(last.data.parentCompleted, { id: Number(pid), title: 'סופר' },
      'and the caller is told, so it can say so');

    const { rows } = await c.query(`SELECT status FROM tasks WHERE id = $1`, [pid]);
    assert.equal(rows[0].status, 'done');
  });
});

test('a project with no subtasks is not "all done"', async () => {
  await withClient(async (c) => {
    // 0 of 0 is arithmetically complete and means "nothing broken out yet".
    const p = await tasks.addTask(c, ana.id, { title: 'פרויקט ריק' });
    const done = await tasks.completeParentIfDrained(c, ana.id, p.data.task.id);
    assert.deepEqual(done, {});
    const { rows } = await c.query(`SELECT status FROM tasks WHERE id = $1`, [p.data.task.id]);
    assert.equal(rows[0].status, 'open');
  });
});

test('putting a task back puts it back OPEN, not back and already ticked', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, ana.id, { title: 'להחזיר' });
    await tasks.completeTask(c, ana.id, r.data.task.id);
    await tasks.archiveTask(c, ana.id, r.data.task.id);
    const back = await tasks.unarchiveTask(c, ana.id, r.data.task.id);
    assert.equal(back.ok, true);
    const { rows } = await c.query(
      `SELECT status, archived_at, completed_at FROM tasks WHERE id = $1`, [r.data.task.id]);
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0].archived_at, null);
    assert.equal(rows[0].completed_at, null);
  });
});

// ------------------------------------------------------------------ the sweep

test('an appointment whose moment passed leaves the list; a late job does not', async () => {
  const made = await withClient(async (c) => ({
    // Four hours ago, and the grace is three.
    passed: (await tasks.addTask(c, ana.id, { title: 'תור לרופא עיניים', dueAt: at(-4) })).data.task,
    // Same shape, same lateness, but it is a job — and staying late is what
    // being late MEANS for a job.
    late: (await tasks.addTask(c, ana.id, { title: 'לקבוע תור לרופא עיניים', dueAt: at(-4) })).data.task,
    // Inside the grace: somebody may still be in the waiting room.
    fresh: (await tasks.addTask(c, ana.id, { title: 'תור לספר', dueAt: at(-1) })).data.task,
  }));
  assert.equal(made.passed.kind, 'event');
  assert.equal(made.late.kind, 'todo');

  const res = await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.ok(res.tasks >= 1);

  const state = async (id) => (await db.pool.query(
    `SELECT status, archived_at FROM tasks WHERE id = $1`, [id])).rows[0];
  assert.equal((await state(made.passed.id)).archived_at !== null, true);
  assert.equal((await state(made.late.id)).archived_at, null, 'a late job stays on the list');
  assert.equal((await state(made.fresh.id)).archived_at, null, 'the grace window is real');
});

test('a range is over when it ENDS, not when it starts', async () => {
  const shift = await withClient(async (c) => (await tasks.addTask(c, ana.id, {
    // Started nine hours ago, ends in an hour. A sweep keyed on the start
    // would archive somebody's shift while they were still on it.
    title: 'משמרת ארוכה', dueAt: at(-9), endsAt: at(1),
  })).data.task);
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  const { rows } = await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [shift.id]);
  assert.equal(rows[0].archived_at, null);
});

test('a standing appointment is never swept — doing it once does not finish it', async () => {
  const t = await withClient(async (c) => {
    const r = await tasks.addTask(c, ana.id, { title: 'אימון קבוע', dueAt: at(-5) });
    await reminders.setReminder(c, ana.id, r.data.task.id, at(-5), 'weekly');
    return r.data.task;
  });
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  const { rows } = await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(rows[0].archived_at, null);
});

test('a project left drained by an older path is swept, and both kinds ride ONE message', async () => {
  const bob = await makeUser(db.pool, '+972501000082', { firstName: 'Bob' });
  const ids = await withClient(async (c) => {
    const p = await tasks.addTask(c, bob.id, { title: 'סופר' });
    const kids = await tasks.addTasksBulk(c, bob.id,
      [{ title: 'חלב' }, { title: 'לחם' }], { parentId: p.data.task.id });
    // Straight to the column, imitating the rows that were already like this
    // before completeTask learned to close a drained project.
    await c.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = ANY($1::bigint[])`,
      [kids.data.tasks.map((t) => t.id)]);
    const ev = await tasks.addTask(c, bob.id, { title: 'פגישה עם דני', dueAt: at(-6) });
    return { project: p.data.task.id, event: ev.data.task.id };
  });

  const res = await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.ok(res.users >= 1);

  const { rows: state } = await db.pool.query(
    `SELECT id, archived_at FROM tasks WHERE id = ANY($1::bigint[])`,
    [[ids.project, ids.event]]);
  assert.equal(state.every((r) => r.archived_at !== null), true);

  // One interruption, not two. And it names what went, because a task that
  // leaves on its own is otherwise indistinguishable from one we lost.
  const { rows: out } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'tasks_auto_archived'`, [bob.id]);
  assert.equal(out.length, 1);
  const titles = out[0].payload.tasks.map((t) => t.title).sort();
  assert.deepEqual(titles, ['סופר', 'פגישה עם דני'].sort());
  assert.deepEqual(out[0].payload.tasks.map((t) => t.why).sort(), ['finished', 'passed']);
});

test('a second run has nothing left to say', async () => {
  const before = (await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE kind = 'tasks_auto_archived'`)).rows[0].n;
  const res = await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.equal(res.tasks, 0);
  const after = (await db.pool.query(`SELECT count(*)::int n FROM outbox WHERE kind = 'tasks_auto_archived'`)).rows[0].n;
  assert.equal(after, before);
});

test('the grace window is a flag, so finding the right number is not a deploy', async () => {
  const t = await withClient(async (c) => (await tasks.addTask(c, ana.id, {
    title: 'תור לפיזיותרפיה', dueAt: at(-1),
  })).data.task);
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.equal((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id])).rows[0].archived_at, null);

  await withClient((c) => flags.setFlag(c, 'task_auto_archive_grace_hours', 0));
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.notEqual((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id])).rows[0].archived_at, null);
  await withClient((c) => flags.setFlag(c, 'task_auto_archive_grace_hours', 3));
});

test('a blocked or eval user is never swept', async () => {
  const ghost = await makeUser(db.pool, '+972501000083', { firstName: 'Ghost' });
  const t = await withClient(async (c) => (await tasks.addTask(c, ghost.id, {
    title: 'תור שאסור לגעת בו', dueAt: at(-8),
  })).data.task);
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [ghost.id]);
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  const { rows } = await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(rows[0].archived_at, null);
});
