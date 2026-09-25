'use strict';
// The day they named, against the day that got written (2026-09-22).
//
// מירון: "תוסיף לי ביומן שביום הראשון הקרוב בין 14 ל18 אמור להגיע טכנאי לבר
// מים". Olma answered "רשמתי — יום רביעי 14:00–18:00" and meant it: the model
// read יום ראשון as an ordinal — "the first day that comes up" — rather than
// as Sunday, and Wednesday was the first day that came up. The row, the
// Google event and the reminder were all consistent with each other and all
// four days early, and he found it by reading the confirmation.
//
// Nothing in the system could have caught it. The guard for exactly this
// disagreement already existed — `datetime.weekdayClash`, which refuses a
// meeting slot whose text names a day its `starts_at` does not fall on — and
// the task path had never been given the one thing it needs: the WORDS. The
// title the model wrote was "טכנאי בר מים", which names no day at all, and
// the only copy of "יום ראשון" was in his own message, which no argument of
// `add_task` carried.
//
// So `add_task` takes `when_said` and checks it. What this file pins:
// the check fires on the founding case, it stays silent on the ל־ shape that
// dates the OBJECT rather than the task (`datetime.datesTheObject` — the one
// reading a meeting slot never has, and a refusal there would fire on
// ordinary input), and nothing is written when it refuses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const dt = require('../src/domain/datetime');
const { BY_NAME, toolDefinitions } = require('../src/adapters/mcp/registry');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const TZ = 'Asia/Jerusalem';
const SAID = 'ביום הראשון הקרוב בין 14 ל18 אמור להגיע טכנאי לבר מים';

// A real moment, always ahead of the real clock, on a weekday this file
// chooses. `add_task` refuses a past `due_at` before it ever reaches the
// weekday check, so a date written down today would take every assertion here
// red on the day it passed (CLAUDE.md, Testing: never let a test depend on the
// hour or the weekday it runs). One to seven days out is always the future,
// whatever hour the suite starts.
function nextWeekdayAt(weekday, hhmm) {
  for (let i = 1; i <= 7; i += 1) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(d);
    if (name !== weekday) continue;
    const ymd = d.toLocaleDateString('en-CA', { timeZone: TZ });
    const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
      .formatToParts(d).find((p) => p.type === 'timeZoneName').value.replace('GMT', '');
    return `${ymd}T${hhmm}:00${off}`;
  }
  throw new Error(`no ${weekday} in the next seven days — impossible`);
}

// ---- the rule, without a database ------------------------------------------

test('the founding case: his words name Sunday, the row says Wednesday', () => {
  const clash = dt.taskWeekdayClash('due_at', SAID, nextWeekdayAt('Wednesday', '14:00'), TZ);
  assert.ok(clash && clash.ok === false, 'the disagreement is refused');
  assert.equal(clash.error.reason, 'weekday_mismatch');
  assert.deepEqual(clash.error.namedWeekdays, [0], 'ראשון is Sunday, not "the first day coming up"');
  assert.match(clash.error.message, /ask which day they mean/);
});

test('…and the corrected row passes the same check', () => {
  assert.equal(dt.taskWeekdayClash('due_at', SAID, nextWeekdayAt('Sunday', '14:00'), TZ), null);
});

// The ל־ shape is why this is not simply `weekdayClash`. "לקנות מתנה ליום
// שישי" dates the GIFT, and the buying belongs before it — a legitimate
// earlier due date, and the rule that says so is already in the codebase
// (`.claude/rules/reminders-and-tasks.md`, "A day named with ל־ in a title
// dates the THING, not the task"). Refusing it would be a hint firing on
// ordinary input, which `.claude/rules/detectors.md` says is worse than no
// hint at all.
test('a day the words date the OBJECT to is not the task disagreeing', () => {
  const wed = nextWeekdayAt('Wednesday', '09:00');
  assert.equal(dt.taskWeekdayClash('due_at', 'לקנות מתנה ליום שישי', wed, TZ), null);
  assert.equal(dt.taskWeekdayClash('due_at', 'לארגן אימון לרביעי', nextWeekdayAt('Monday', '09:00'), TZ), null);
});

test('…but ב־ dates the task itself, and there the disagreement stands', () => {
  const wed = nextWeekdayAt('Wednesday', '09:00');
  assert.ok(dt.taskWeekdayClash('due_at', 'תקבע לי ביום שישי בבוקר', wed, TZ));
  assert.ok(dt.taskWeekdayClash('due_at', 'תשים לי בשישי בבוקר', wed, TZ));
});

test('nothing to check is a null answer, never a refusal', () => {
  const sun = nextWeekdayAt('Sunday', '14:00');
  assert.equal(dt.taskWeekdayClash('due_at', 'טכנאי בר מים', sun, TZ), null, 'no weekday in the words');
  assert.equal(dt.taskWeekdayClash('due_at', SAID, 'not a date', TZ), null, 'no moment to compare');
  assert.equal(dt.taskWeekdayClash('due_at', undefined, sun, TZ), null, 'no words at all');
  assert.equal(dt.taskWeekdayClash('due_at', SAID, null, TZ), null);
});

// Lenient on purpose, exactly as `weekdayClash` is for a slot: somebody who
// offers two days has not been contradicted by a row landing on one of them.
test('several days named, one of them matching, is agreement', () => {
  const sun = nextWeekdayAt('Sunday', '14:00');
  assert.equal(dt.taskWeekdayClash('due_at', 'ביום ראשון או ביום שלישי', sun, TZ), null);
});

test('the note says what did not happen, in the words the other refusals use', () => {
  const clash = dt.taskWeekdayClash('due_at', SAID, nextWeekdayAt('Wednesday', '14:00'), TZ,
    'no task was saved');
  assert.match(clash.error.message, /NOTHING was saved — no task was saved\./);
  assert.equal(clash.error.reason, 'weekday_mismatch', 'the machine-readable half survives the note');
});

// ---- the tool, against the real database ------------------------------------

const add = BY_NAME.get('add_task');
const openCount = async (userId) => {
  const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1', [userId]);
  return rows[0].n;
};

test('add_task refuses the founding case and writes nothing', async () => {
  const u = await makeUser(db.pool, '+972500000901', { timezone: TZ, onboardedAt: new Date().toISOString() });
  const res = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'טכנאי בר מים', kind: 'event', when_said: SAID,
    due_at: nextWeekdayAt('Wednesday', '14:00'), ends_at: nextWeekdayAt('Wednesday', '18:00'),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'weekday_mismatch');
  assert.match(res.error.message, /NOTHING was saved/);
  assert.equal(await openCount(u.id), 0, 'refused before the write, like the past-moment guard beside it');
});

test('…and saves it once the day agrees', async () => {
  const u = await makeUser(db.pool, '+972500000902', { timezone: TZ, onboardedAt: new Date().toISOString() });
  const res = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'טכנאי בר מים', kind: 'event', when_said: SAID,
    due_at: nextWeekdayAt('Sunday', '14:00'), ends_at: nextWeekdayAt('Sunday', '18:00'),
  }));
  assert.equal(res.ok, true);
  assert.equal(await openCount(u.id), 1);
});

// The honest limit of this guard, pinned so nobody reads it as more than it
// is: it can only ever check words it was given. A model that omits the
// argument gets the behaviour that shipped the bug.
test('with no words there is nothing to check, and the task is saved', async () => {
  const u = await makeUser(db.pool, '+972500000903', { timezone: TZ, onboardedAt: new Date().toISOString() });
  const res = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'טכנאי בר מים', kind: 'event', due_at: nextWeekdayAt('Wednesday', '14:00'),
  }));
  assert.equal(res.ok, true);
});

// ONE moment is checked. A reminder set for the evening before a named day
// disagrees with it deliberately — "תזכיר לי במוצ״ש על יום ראשון" — so a
// `due_at` that is there answers, and `remind_at` stands in only for a task
// with no date of its own.
test('due_at answers when it is there, so an evening-before reminder is not refused', async () => {
  const u = await makeUser(db.pool, '+972500000904', { timezone: TZ, onboardedAt: new Date().toISOString() });
  const res = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'טכנאי בר מים', kind: 'event', when_said: 'ביום ראשון',
    due_at: nextWeekdayAt('Sunday', '14:00'), remind_at: nextWeekdayAt('Saturday', '21:00'),
  }));
  assert.equal(res.ok, true);
});

test('…and remind_at stands in for a task with no date of its own', async () => {
  const u = await makeUser(db.pool, '+972500000905', { timezone: TZ, onboardedAt: new Date().toISOString() });
  const res = await withTx(db.pool, (c) => add.handler(c, u, {
    title: 'להתקשר למוסך', when_said: 'ביום ראשון', remind_at: nextWeekdayAt('Wednesday', '09:00'),
  }));
  assert.equal(res.ok, false);
  assert.match(res.error.message, /^remind_at names/);
  assert.equal(await openCount(u.id), 0);
});

test('the words are an argument the model can actually see', () => {
  const described = toolDefinitions().find((d) => d.name === 'add_task');
  const p = described.inputSchema.properties.when_said;
  assert.ok(p, 'add_task takes the words the day was read out of');
  assert.equal(described.inputSchema.required.includes('when_said'), false,
    'optional: a task nobody dated by weekday has nothing to copy');
});

// ---- the day a moment is measured FROM (2026-09-25) ------------------------
//
// set_task_reminder is where this shape lives: the reminder is almost by
// definition NOT on the day they name, because they name the thing and ask to
// hear about it before. Stripped before the check, the same way ל־ is.
// And "ערב שבת" is FRIDAY — the eve of the day, which the reader alone takes
// for Saturday; with the guard on four doors that is a refusal of ordinary
// speech waiting to happen.
test('a day the moment is anchored to is not a day it must fall on', () => {
  const sat = nextWeekdayAt('Saturday', '21:00');
  assert.equal(dt.taskWeekdayClash('remind_at', 'תזכיר לי יום לפני יום ראשון', sat, TZ), null);
  assert.equal(dt.taskWeekdayClash('remind_at', 'תנדנדי לי עד חמישי', sat, TZ), null);
  assert.equal(dt.taskWeekdayClash('remind_at', 'remind me the day before Sunday', sat, TZ), null);
  assert.equal(dt.taskWeekdayClash('remind_at', 'תזכיר לי בערב שבת', nextWeekdayAt('Friday', '18:00'), TZ), null);
});

test('…while the evening OF a day, and a day said plainly, are still compared', () => {
  const sat = nextWeekdayAt('Saturday', '21:00');
  assert.ok(dt.taskWeekdayClash('remind_at', 'בערב שישי', sat, TZ), '"ערב שישי" is Friday evening');
  assert.ok(dt.taskWeekdayClash('remind_at', 'תזכיר לי ביום ראשון', sat, TZ));
  assert.equal(dt.taskWeekdayClash('remind_at', 'במוצאי שבת', sat, TZ), null, 'Saturday night is Saturday');
});

// ---- the other three doors that date a live task ---------------------------

const snooze = BY_NAME.get('snooze_task');
const edit = BY_NAME.get('edit_task');
const remind = BY_NAME.get('set_task_reminder');

async function aTask(phone) {
  const u = await makeUser(db.pool, phone, { timezone: TZ, onboardedAt: new Date().toISOString() });
  const due = nextWeekdayAt('Tuesday', '10:00');
  const res = await withTx(db.pool, (c) => add.handler(c, u, { title: 'להתקשר למוסך', due_at: due }));
  assert.equal(res.ok, true);
  return { u, taskId: res.data.task.id, due };
}
const dueOf = async (taskId) => (await db.pool.query('SELECT due_at FROM tasks WHERE id = $1', [taskId])).rows[0].due_at;
const remindersOf = async (taskId) => (await db.pool.query(
  'SELECT remind_at FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL ORDER BY remind_at', [taskId])).rows
  .map((r) => r.remind_at.getTime());

test('snooze_task refuses words naming another day, and does not move the task', async () => {
  const { u, taskId, due } = await aTask('+972500000911');
  const res = await withTx(db.pool, (c) => snooze.handler(c, u, {
    task_id: taskId, when_said: 'תזיז את זה ליום ראשון', new_due_at: nextWeekdayAt('Wednesday', '10:00'),
  }));
  // ל־ in "ליום ראשון" is stripped, so THIS phrasing is the model's to resolve…
  assert.equal(res.ok, true, 'ל־ dates the object; a move "to Sunday" is not compared');
  const { u: u2, taskId: t2, due: due2 } = await aTask('+972500000912');
  const refused = await withTx(db.pool, (c) => snooze.handler(c, u2, {
    task_id: t2, when_said: 'תעביר את זה ליום אחר, ביום ראשון', new_due_at: nextWeekdayAt('Wednesday', '10:00'),
  }));
  // …and ב־ is not.
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'weekday_mismatch');
  assert.match(refused.error.message, /the task was not moved/);
  assert.equal((await dueOf(t2)).getTime(), new Date(due2).getTime(), 'the row is where it was');
  assert.ok(due, 'first task existed');
});

test('edit_task compares a new start, and only a new start', async () => {
  const { u, taskId, due } = await aTask('+972500000913');
  const refused = await withTx(db.pool, (c) => edit.handler(c, u, {
    task_id: taskId, when_said: 'ביום ראשון בעשר', due_at: nextWeekdayAt('Wednesday', '10:00'),
  }));
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /the task was not changed/);
  assert.equal((await dueOf(taskId)).getTime(), new Date(due).getTime());
  const renamed = await withTx(db.pool, (c) => edit.handler(c, u, {
    task_id: taskId, title: 'להתקשר לחשמלאי', when_said: 'ביום ראשון',
  }));
  assert.equal(renamed.ok, true, 'a title edit has no moment to disagree with');
});

test('set_task_reminder refuses a reminder on a day they did not name, and cancels nothing', async () => {
  const { u, taskId } = await aTask('+972500000914');
  const before = await remindersOf(taskId);
  assert.equal(before.length, 1, 'the automatic reminder an hour before');
  const refused = await withTx(db.pool, (c) => remind.handler(c, u, {
    task_id: taskId, when_said: 'תזכיר לי ביום ראשון בבוקר', remind_at: nextWeekdayAt('Monday', '09:00'),
  }));
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /no reminder was set and none was cancelled/);
  assert.deepEqual(await remindersOf(taskId), before, 'the automatic one is untouched');

  const evening = await withTx(db.pool, (c) => remind.handler(c, u, {
    task_id: taskId, when_said: 'תזכיר לי ערב לפני יום שלישי', remind_at: nextWeekdayAt('Monday', '20:00'),
  }));
  assert.equal(evening.ok, true, 'the evening before a named day is what a reminder is for');
});

test('all four doors show the model the same argument', () => {
  const defs = toolDefinitions();
  const texts = ['add_task', 'snooze_task', 'edit_task', 'set_task_reminder']
    .map((n) => defs.find((d) => d.name === n).inputSchema.properties.when_said);
  assert.ok(texts.every(Boolean), 'each takes the words');
  assert.equal(new Set(texts.map((t) => t.description)).size, 1, 'one string, paid for once per tool');
});
