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
    const r = await tasks.addTask(c, ana.id, { title: 'משמרת לילה', dueAt: at(24), endsAt: at(31) });
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
    const r = await tasks.addTask(c, ana.id, { title: 'משמרת בוקר', dueAt: at(24), endsAt: at(31) });
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
    // Four hours ago; the grace is zero now, and it would be past three too.
    passed: (await tasks.addTask(c, ana.id, { title: 'תור לרופא עיניים', dueAt: at(-4) })).data.task,
    // Same shape, same lateness, but it is a job — and staying late is what
    // being late MEANS for a job.
    late: (await tasks.addTask(c, ana.id, { title: 'לקבוע תור לרופא עיניים', dueAt: at(-4) })).data.task,
    // Still ahead: it stays until it is over.
    fresh: (await tasks.addTask(c, ana.id, { title: 'תור לספר', dueAt: at(1) })).data.task,
  }));
  assert.equal(made.passed.kind, 'event');
  assert.equal(made.late.kind, 'todo');

  const res = await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.ok(res.passed >= 1);

  const state = async (id) => (await db.pool.query(
    `SELECT status, archived_at FROM tasks WHERE id = $1`, [id])).rows[0];
  assert.equal((await state(made.passed.id)).archived_at !== null, true);
  assert.equal((await state(made.late.id)).archived_at, null, 'a late job stays on the list');
  assert.equal((await state(made.fresh.id)).archived_at, null, 'nothing ahead is swept');
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

test('a drained project is swept and SAID; an appointment that passed leaves quietly', async () => {
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

  // The list is named, because a list that leaves on its own is otherwise
  // indistinguishable from one we lost. The appointment is not: it was
  // reminded about, it happened, and it is still on their Google Calendar
  // (owner, 2026-10-01).
  const { rows: out } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'tasks_auto_archived'`, [bob.id]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].payload.tasks.map((t) => t.title), ['סופר']);
  assert.deepEqual(out[0].payload.tasks.map((t) => t.why), ['finished']);
});

test('a person whose only swept row is a passed appointment hears nothing at all', async () => {
  const dan = await makeUser(db.pool, '+972501990001', { firstName: 'Dan' });
  const ev = await withClient(async (c) => (await tasks.addTask(c, dan.id, {
    title: 'תור לספר', dueAt: at(-2),
  })).data.task);
  const res = await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.ok(res.passed >= 1);
  assert.notEqual((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [ev.id])).rows[0].archived_at, null);
  const { rows } = await db.pool.query(`SELECT 1 FROM outbox WHERE user_id = $1`, [dan.id]);
  assert.equal(rows.length, 0);
});

test('with no grace left, a reminder that is due goes out before its appointment is swept', async () => {
  const eli = await makeUser(db.pool, '+972501990002', { firstName: 'Eli' });
  const made = await withClient(async (c) => {
    const ev = (await tasks.addTask(c, eli.id, { title: 'תור לרופא', dueAt: at(2) })).data.task;
    const r = await reminders.setReminder(c, eli.id, ev.id, at(1));
    // Straight to the columns: the appointment started a minute ago, and the
    // reminder for that same minute has not been picked up yet.
    await c.query(`UPDATE tasks SET due_at = $2 WHERE id = $1`, [ev.id, at(-1 / 60)]);
    await c.query(`UPDATE task_reminders SET remind_at = $2 WHERE id = $1`, [r.data.reminder.id, at(-1 / 60)]);
    return { ev, reminderId: r.data.reminder.id };
  });
  const archived = async () => (await db.pool.query(
    `SELECT archived_at FROM tasks WHERE id = $1`, [made.ev.id])).rows[0].archived_at;

  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.equal(await archived(), null, 'the reminder has not gone out yet');
  const { rows: rem } = await db.pool.query(
    `SELECT cancelled_at FROM task_reminders WHERE id = $1`, [made.reminderId]);
  assert.equal(rem[0].cancelled_at, null);

  // Once its first rung has been handed over, nothing holds it back.
  await db.pool.query(`UPDATE task_reminders SET attempts = 1 WHERE id = $1`, [made.reminderId]);
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.notEqual(await archived(), null);
});

test('a reminder that will never go out does not pin its appointment for ever', async () => {
  const fay = await makeUser(db.pool, '+972501990003', { firstName: 'Fay' });
  const ev = await withClient(async (c) => {
    const t = (await tasks.addTask(c, fay.id, { title: 'תור לשיננית', dueAt: at(2) })).data.task;
    const r = await reminders.setReminder(c, fay.id, t.id, at(1));
    // Five hours stale and never attempted — somebody paused, say.
    await c.query(`UPDATE tasks SET due_at = $2 WHERE id = $1`, [t.id, at(-4)]);
    await c.query(`UPDATE task_reminders SET remind_at = $2 WHERE id = $1`, [r.data.reminder.id, at(-5)]);
    return t;
  });
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.notEqual((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [ev.id])).rows[0].archived_at, null);
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
  await withClient((c) => flags.setFlag(c, 'task_auto_archive_grace_hours', 3));
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.equal((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id])).rows[0].archived_at, null);

  // The default is zero: over is over.
  await withClient((c) => flags.setFlag(c, 'task_auto_archive_grace_hours', 0));
  await withClient((c) => sweeps.sweepFinishedTasks(c));
  assert.notEqual((await db.pool.query(`SELECT archived_at FROM tasks WHERE id = $1`, [t.id])).rows[0].archived_at, null);
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

// ------------------------------------------------------------- said, not guessed
//
// ג.ב, 2026-09-07, his first message: "תכניסי פגישה יום שלישי 11.45 עם תמר
// גבריאלי בביהס קרית חינוך דרור". The row came out right — kind = event,
// 11:45–12:45, a reminder at 10:45 — because "פגישה" is on the word list.
// What he read was "הנה, רשמתי." and then, in a second message, about a
// reminder he had not asked for: a to-do's sentences about a calendar entry.
// The words had decided in silence and nothing had told the model. Now the
// model says what it is, the words are the fallback, the place is a field,
// and the result says what was filed so the sentence can match it.
test("the caller's word wins over the title; a word that is not one of the two is not said", async () => {
  await withClient(async (c) => {
    const said = (await tasks.addTask(c, ana.id, { title: 'פגישה עם הבנק', kind: 'todo', dueAt: at(5) })).data.task;
    assert.equal(said.kind, 'todo', '"פגישה" in the title, but they said it is a job to do');
    const booked = (await tasks.addTask(c, ana.id, { title: 'לקבוע תור לרופא עור', kind: 'event', dueAt: at(5) })).data.task;
    assert.equal(booked.kind, 'event', 'the verb says todo, the caller says event: the caller has the conversation');
    const noWord = (await tasks.addTask(c, ana.id, { title: 'רופא שיניים', kind: 'meeting', dueAt: at(5) })).data.task;
    assert.equal(noWord.kind, 'todo', 'an unknown word is "not said", and the words fall back to the default');
    const guessed = (await tasks.addTask(c, ana.id, { title: 'רופא שיניים בתל אביב', kind: 'event', dueAt: at(5) })).data.task;
    assert.equal(guessed.kind, 'event', 'no word in the title says appointment; the model knew');
  });
});

test('an event carries where it is, apart from its title, and an edit can say either', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, ana.id, {
      title: 'פגישה עם תמר גבריאלי', kind: 'event', location: '  ביהס קרית חינוך דרור ', dueAt: at(20), endsAt: at(21),
    })).data.task;
    assert.equal(t.location, 'ביהס קרית חינוך דרור');
    assert.equal(t.title, 'פגישה עם תמר גבריאלי', 'the place is not in the title');
    const moved = (await tasks.editTask(c, ana.id, t.id, { location: 'זום' })).data.task;
    assert.equal(moved.location, 'זום');
    const cleared = (await tasks.editTask(c, ana.id, t.id, { location: null })).data.task;
    assert.equal(cleared.location, null);
    // "זה לא פגישה, זה משהו שאני צריך לעשות" — the person corrects the kind.
    const asJob = (await tasks.editTask(c, ana.id, t.id, { kind: 'todo' })).data.task;
    assert.equal(asJob.kind, 'todo');
    const untouched = (await tasks.editTask(c, ana.id, t.id, { kind: 'whatever', title: 'פגישה עם תמר' })).data.task;
    assert.equal(untouched.kind, 'todo', 'a word that is not one of the two changes nothing');
    const bulk = (await tasks.addTasksBulk(c, ana.id, [
      { title: 'ישיבת צוות', kind: 'event', location: 'משרד', dueAt: at(30) },
      { title: 'לקנות חלב' },
    ])).data.tasks;
    assert.equal(bulk[0].kind, 'event'); assert.equal(bulk[0].location, 'משרד');
    assert.equal(bulk[1].kind, 'todo'); assert.equal(bulk[1].location, null);
  });
});

test('the result says a calendar entry was filed, and the list says which rows are the calendar', async () => {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  const { withTx } = require('../src/db/pool');
  const add = BY_NAME.get('add_task');
  const list = BY_NAME.get('list_my_tasks');
  const u = await makeUser(db.pool, '+972501000084', { firstName: 'Gal', timezone: 'Asia/Jerusalem' });

  // Nothing on the calendar yet: the list has no kinds hint to give.
  const job = await withTx(db.pool, (c) => add.handler(c, u, { title: 'לקנות חלב', kind: 'todo' }));
  assert.equal(job.ok, true);
  assert.equal(job.data.hints && job.data.hints.event, undefined, 'a to-do says nothing about the calendar');
  const before = await withTx(db.pool, (c) => list.handler(c, u, {}));
  assert.equal(before.data.hints, undefined, 'no calendar entry, no hint');

  const meet = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'פגישה עם תמר גבריאלי', kind: 'event', location: 'ביהס קרית חינוך דרור', due_at: at(20), ends_at: at(21),
  }));
  assert.equal(meet.ok, true, JSON.stringify(meet.error));
  assert.equal(meet.data.task.kind, 'event');
  assert.match(meet.data.hints.event, /CALENDAR/);
  assert.match(meet.data.hints.event, /פגישה עם תמר גבריאלי/);
  assert.match(meet.data.hints.event, /never "רשמתי משימה"/);
  assert.match(meet.data.hints.event, /If you say anything/, 'conditional, like markPlaced — never an order to write');

  const after = await withTx(db.pool, (c) => list.handler(c, u, {}));
  assert.ok(after.data.tasks.some((t) => t.kind === 'event' && t.location === 'ביהס קרית חינוך דרור'));
  // The split is DRAWN now (domain/list-block.js) rather than asked for: the
  // calendar first under its own heading, the to-dos after, the place beside
  // the meeting. What used to be a paragraph of instructions is a shape the
  // code cannot produce wrongly.
  assert.match(after.data.block, /\*ביומן\*\n- .*פגישה עם תמר גבריאלי, ביהס קרית חינוך דרור/);
  assert.match(after.data.block, /\*על הרשימה\*\n- לקנות חלב/);
  assert.ok(after.data.block.indexOf('ביומן') < after.data.block.indexOf('על הרשימה'));
  // And the instruction hints are GONE, not merely redundant. A block handed
  // over with "lay these out as a list" beside it is the markPlaced fault —
  // a conditional result outvoted by an unconditional sentence on the same
  // result — and here it asks for work that has already been done.
  assert.equal(after.data.hints.kinds, undefined);
  assert.equal(after.data.hints.layout, undefined);
  assert.match(after.data.hints.block, /EXACTLY as it is/);
});

test('the digest hands over the calendar and the plate as two lists, and counts them apart', async () => {
  const digest = require('../src/domain/digest');
  const u = await makeUser(db.pool, '+972501000085', { firstName: 'Dana' });
  await withClient(async (c) => {
    await tasks.addTask(c, u.id, { title: 'ישיבת צוות', kind: 'event', location: 'משרד', dueAt: at(2), endsAt: at(3) });
    await tasks.addTask(c, u.id, { title: 'לשלם חשמל', dueAt: at(4) });
    await tasks.addTask(c, u.id, { title: 'לנקות את הבית' });
    const full = (await digest.assemble(c, u.id, 'full')).data;
    assert.deepEqual(full.events.map((e) => e.title), ['ישיבת צוות']);
    assert.equal(full.events[0].location, 'משרד');
    assert.ok(full.events[0].ends_at, 'an event knows when it ends');
    assert.deepEqual(full.tasks.map((e) => e.title), ['לשלם חשמל', 'לנקות את הבית']);
    assert.ok(!('kind' in full.tasks[0]) && !('location' in full.tasks[0]), 'a to-do carries no calendar fields');
    assert.equal(full.counts.openTasks, 2, 'open tasks are the jobs');
    assert.equal(full.counts.openEvents, 1);
    // Owner, 2026-10-06: every scope a person holds carries the whole list;
    // only the quota-block notice stays counts-only.
    const summary = (await digest.assemble(c, u.id, 'summary')).data;
    assert.deepEqual(summary.tasks.map((e) => e.title), ['לשלם חשמל', 'לנקות את הבית']);
    const blocked = (await digest.assemble(c, u.id, 'block_view')).data;
    assert.equal(blocked.events, undefined, 'the block notice stays counts-only');
  });
});

test('a checklist item is not a task anybody has to do, and the counts say so', async () => {
  const digest = require('../src/domain/digest');
  const u = await makeUser(db.pool, '+972501000086', { firstName: 'Maya' });
  // מאיה's own shape: one thing to do, with the packing list inside it. Her
  // digest counted the list as six separate jobs she had not done, over a
  // block that listed one — every renderer drops `parent_id` rows and the
  // counts did not (incidents.md, "התיק לבית חולים").
  const yesterday = at(-30);
  await withClient(async (c) => {
    const bag = (await tasks.addTask(c, u.id, { title: 'לארוז תיק לבית חולים', dueAt: yesterday })).data.task;
    for (const item of ['תעודת זהות', 'מטען', 'בגדים', 'מסמכים']) {
      await tasks.addTask(c, u.id, { title: item, parentId: bag.id, dueAt: yesterday });
    }
    await tasks.addTask(c, u.id, { title: 'להתקשר למכבי' });

    const full = (await digest.assemble(c, u.id, 'full')).data;
    assert.equal(full.counts.openTasks, 2, 'the bag and the phone call — not the four things in the bag');
    assert.equal(full.counts.dueOrOverdue, 1, 'one overdue thing, not five');
    // The ROWS still carry the items: the count is filtered at the source,
    // the list keeps them so a renderer can nest them under their parent.
    assert.equal(full.tasks.length, 6);
    assert.equal(full.tasks.filter((t) => t.parent_id).length, 4);

    const summary = (await digest.assemble(c, u.id, 'summary')).data;
    assert.equal(summary.counts.openTasks, 2, 'the counts-only scope reads the same number');
  });
});

// Miron's birthday entry for Liam was told back as "ביומן" while the Google
// connection behind it was VIEW-ONLY: it sat on Olma's list and never reached
// Google (2026-10-01). The result has to say so, and only when it is true.
test('an event saved against a view-only Google Calendar says it is NOT on Google', async () => {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  const { withTx } = require('../src/db/pool');
  const add = BY_NAME.get('add_task');
  const u = await makeUser(db.pool, '+972501000187', { firstName: 'Miron', timezone: 'Asia/Jerusalem' });

  const none = await withTx(db.pool, (c) => add.handler(c, u, { title: 'אירוע בלי יומן', kind: 'event', due_at: at(20), ends_at: at(21) }));
  assert.equal(none.data.hints.googleCalendar, undefined, 'no calendar connected, nothing to warn about');

  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);
  const viewOnly = await withTx(db.pool, (c) => add.handler(c, u, { title: 'יום הולדת לליאם', kind: 'event', due_at: at(22), ends_at: at(23) }));
  assert.match(viewOnly.data.hints.googleCalendar, /VIEW-ONLY/);
  assert.match(viewOnly.data.hints.googleCalendar, /no permission to write there/);
  assert.match(viewOnly.data.hints.googleCalendar, /Never say it is on their calendar/);

  // The other two doors that can put an event on the calendar say the same.
  const bulk = BY_NAME.get('add_tasks_bulk');
  const many = await withTx(db.pool, (c) => bulk.handler(c, u, { items: [
    { title: 'חתונה של דנה', kind: 'event', due_at: at(26), ends_at: at(27) }, { title: 'לקנות כרטיס' }] }));
  assert.match(many.data.hints.googleCalendar, /VIEW-ONLY/);
  const edit = BY_NAME.get('edit_task');
  const plan = await withTx(db.pool, (c) => add.handler(c, u, { title: 'ארוחה עם אבא', kind: 'todo' }));
  const made = await withTx(db.pool, (c) => edit.handler(c, u, { task_id: plan.data.task.id, kind: 'event', due_at: at(28) }));
  assert.match(made.data.hints.googleCalendar, /VIEW-ONLY/, 'turning it into an event is the same claim');
  const renamed = await withTx(db.pool, (c) => edit.handler(c, u, { task_id: plan.data.task.id, title: 'ארוחת ערב עם אבא' }));
  assert.equal(renamed.data.hints, undefined, 'a rename says nothing about the calendar');
  const todo = await withTx(db.pool, (c) => add.handler(c, u, { title: 'לקנות מתנה', kind: 'todo' }));
  assert.equal(todo.data.hints && todo.data.hints.googleCalendar, undefined, 'a to-do never claimed Google');

  await db.pool.query(`UPDATE integrations SET access_level = 'read_write' WHERE user_id = $1`, [u.id]);
  const writable = await withTx(db.pool, (c) => add.handler(c, u, { title: 'אירוע עם יומן', kind: 'event', due_at: at(24), ends_at: at(25) }));
  assert.equal(writable.data.hints.googleCalendar, undefined, 'a writable calendar gets the sweep, not a caveat');
});

// A day-shaped event sits at local midnight, which is when its day STARTS. It
// used to be archived at that midnight, so a birthday was gone from the list
// on the birthday itself. It now leaves at the NEXT local midnight.
test('an event saved for a day stays on the list through that whole day', async () => {
  const sweeps = require('../src/jobs/sweeps');
  const u = await makeUser(db.pool, '+972501000188', { timezone: 'Asia/Jerusalem' });
  const c = await db.pool.connect();
  try {
    // 30 Oct 2026 in Jerusalem is UTC+2 (DST ended on the 25th).
    const t = await tasks.addTask(c, u.id, { title: 'יום הולדת לליאם', kind: 'event', dueAt: '2026-10-30T00:00:00+02:00' });
    const id = t.data.task.id;
    const archived = async () => (await c.query('SELECT archived_at FROM tasks WHERE id = $1', [id])).rows[0].archived_at;

    await sweeps.sweepFinishedTasks(c, '2026-10-30T08:00:00+02:00');
    assert.equal(await archived(), null, 'the morning of the birthday it is still there');
    await sweeps.sweepFinishedTasks(c, '2026-10-30T23:30:00+02:00');
    assert.equal(await archived(), null, 'and late that evening');
    await sweeps.sweepFinishedTasks(c, '2026-10-31T00:30:00+02:00');
    assert.ok(await archived(), 'gone once its day is over');
  } finally { c.release(); }
});
