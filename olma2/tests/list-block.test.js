'use strict';
// The two on-demand lists, drawn (src/domain/list-block.js).
//
// Everything here is pure and pinned: a block that says "מחר" is describing a
// relationship between two moments, so the test that reads it has to own both.
// The clock rule from CLAUDE.md — never let a test depend on the hour it runs.
const test = require('node:test');
const assert = require('node:assert');
const lb = require('../src/domain/list-block');

// A Thursday morning in Jerusalem, chosen so "tomorrow" is a Friday and the
// named-weekday branch has somewhere to land.
const NOW = Date.parse('2026-09-10T06:00:00Z');
const HE = { locale: 'he', timezone: 'Asia/Jerusalem', channelType: 'whatsapp', now: NOW };
const EN = { ...HE, locale: 'en' };
const iso = (s) => new Date(s).toISOString();

test('the calendar and the plate are two lists and cannot be one', () => {
  const block = lb.renderTaskListBlock({
    tasks: [
      { title: 'פגישה עם דנה', kind: 'event', due_at: iso('2026-09-10T13:00:00Z'), ends_at: iso('2026-09-10T14:00:00Z'), location: 'הקפה ליד המשרד' },
      { title: 'לשלם ארנונה', kind: 'todo', due_at: iso('2026-09-11T05:00:00Z') },
      { title: 'לתקן את הדוד', kind: 'todo' },
    ],
  }, HE);
  assert.equal(block,
    '*ביומן*\n- 16:00-17:00 — פגישה עם דנה, הקפה ליד המשרד\n\n'
    + '*על הרשימה*\n- מחר 08:00 — לשלם ארנונה\n- לתקן את הדוד');
  // The order is the point, not an accident of the input: a meeting read out
  // as a task is the fault `tasks.kind` exists to prevent.
  assert.ok(block.indexOf('ביומן') < block.indexOf('על הרשימה'));
});

test('one line is not a list, and nothing at all is null rather than an empty heading', () => {
  assert.equal(lb.renderTaskListBlock({ tasks: [{ title: 'לתקן את הדוד', kind: 'todo' }] }, HE), null,
    'a heading over a single line is heavier than the sentence it replaces');
  assert.equal(lb.renderTaskListBlock({ tasks: [] }, HE), null);
  assert.equal(lb.renderTaskListBlock({}, HE), null);
  assert.equal(lb.renderReminderListBlock({ reminders: [] }, HE), null);
  // null and '' are different answers and the caller must be able to tell
  // them apart — an empty list is a real answer, and the sentence about it is
  // the model's.
  assert.notEqual(lb.renderTaskListBlock({ tasks: [] }, HE), '');
});

test('a subtask stays out of the list, exactly as it does in the digest', () => {
  const block = lb.renderTaskListBlock({
    tasks: [
      { id: 1, title: 'לארגן את הטיול', kind: 'todo' },
      { id: 2, parent_id: 1, title: 'להביא מטען', kind: 'todo' },
      { id: 3, title: 'לקנות חלב', kind: 'todo' },
    ],
  }, HE);
  assert.ok(!block.includes('להביא מטען'), 'out of its parent it reads as an orphan');
  assert.ok(block.includes('לארגן את הטיול') && block.includes('לקנות חלב'));
});

test('what is finished is one list, because a past event is not "on your calendar"', () => {
  const done = { tasks: [
    { title: 'פגישה עם דנה', kind: 'event', due_at: iso('2026-09-09T13:00:00Z') },
    { title: 'לשלם ארנונה', kind: 'todo' },
  ] };
  const block = lb.renderTaskListBlock(done, { ...HE, status: 'done' });
  assert.match(block, /^\*הושלמו\*\n/);
  assert.ok(!block.includes('ביומן'), 'one heading, not two tenses arguing');
  assert.equal(lb.renderTaskListBlock(done, { ...EN, status: 'done' }).split('\n')[0], '*Completed*');
});

test('the language is the prefix rule, and a channel that renders nothing gets no markers', () => {
  const data = { tasks: [
    { title: 'call the accountant', kind: 'todo', due_at: iso('2026-09-11T09:00:00Z') },
    { title: 'fix the boiler', kind: 'todo' },
  ] };
  assert.match(lb.renderTaskListBlock(data, EN), /^\*On your list\*/);
  // he-IL is ordinary — `set_my_language` stores any ISO code lowercased —
  // and it is Hebrew, like everything that is not English.
  assert.match(lb.renderTaskListBlock(data, { ...HE, locale: 'he-il' }), /^\*על הרשימה\*/);
  assert.match(lb.renderTaskListBlock(data, { ...EN, locale: 'en-GB' }), /^\*On your list\*/);
  // A channel the table has never heard of gets PLAIN — never WhatsApp's
  // markup on the assumption that it probably renders it. The bullet becomes a
  // character, because "- " is a real list only where something reads it as
  // one; the heading keeps its words and loses its markers.
  assert.equal(lb.renderTaskListBlock(data, { ...EN, channelType: 'sms' }),
    'On your list\n• Tomorrow 12:00 — call the accountant\n• fix the boiler');
});

// ---- reminders --------------------------------------------------------------

test('a reminder says the hour in THEIR clock, and always says it', () => {
  const block = lb.renderReminderListBlock({
    reminders: [
      { title: 'להתקשר לרואה החשבון', remind_at: iso('2026-09-10T16:00:00Z') },
      { title: 'לקחת את הרכב לטסט', remind_at: iso('2026-09-11T05:30:00Z') },
      // Local midnight. A task saved for a DAY says only its day; a reminder
      // armed for 00:00 has to say 00:00 or the one fact it carries is gone.
      { title: 'לצאת לשדה התעופה', remind_at: iso('2026-09-11T21:00:00Z') },
    ],
  }, HE);
  assert.equal(block,
    '*תזכורות*\n- 19:00 — להתקשר לרואה החשבון\n- מחר 08:30 — לקחת את הרכב לטסט\n'
    + '- יום שבת 00:00 — לצאת לשדה התעופה');
});

test('a cadence is said in words, from the canonical form and never from a guess', () => {
  const say = (rule, k) => lb.repeatLabel(rule, k);
  assert.equal(say('daily', 'he'), 'כל יום');
  assert.equal(say('weekly', 'he'), 'כל שבוע');
  assert.equal(say('weekly:MO', 'he'), 'כל יום שני');
  assert.equal(say('weekly:MO,TH', 'he'), 'כל שני וחמישי');
  assert.equal(say('weekly:SU,TU,WE', 'he'), 'כל ראשון, שלישי ורביעי');
  assert.equal(say('monthly:16', 'he'), 'כל 16 בחודש');
  assert.equal(say('monthly:last', 'he'), 'בסוף כל חודש');
  assert.equal(say('weekly:MO,TH', 'en'), 'every Monday and Thursday');
  // "the 1th of every month" is what a number formatted by nobody looks like.
  assert.equal(say('monthly:1', 'en'), 'the 1st of every month');
  assert.equal(say('monthly:2', 'en'), 'the 2nd of every month');
  assert.equal(say('monthly:11', 'en'), 'the 11th of every month');
  // The rule is normalised first, because the live database has held
  // RRULE-style rows before (incidents, 2026-08-18) and may still.
  assert.equal(say('FREQ=WEEKLY;BYDAY=MO,TH', 'he'), 'כל שני וחמישי');
  // And anything the normaliser refuses says nothing at all. A wrong cadence
  // said out loud is worse than a missing one; the next occurrence is on the
  // line either way.
  for (const bad of ['', null, undefined, 'nonsense', 'yearly', 'monthly']) {
    assert.equal(say(bad, 'he'), '', `${bad} is not a cadence anybody can stand behind`);
  }
});

test('the cadence rides the line it belongs to', () => {
  const block = lb.renderReminderListBlock({
    reminders: [
      { title: 'לקחת תרופה', remind_at: iso('2026-09-11T05:00:00Z'), repeat_rule: 'daily' },
      { title: 'לשלוח דוח', remind_at: iso('2026-09-11T06:00:00Z'), repeat_rule: 'nonsense' },
    ],
  }, HE);
  assert.equal(block, '*תזכורות*\n- מחר 08:00 — לקחת תרופה, כל יום\n- מחר 09:00 — לשלוח דוח');
});

test('what is still CHASING is never drawn, because a line is an hour someone will read out', () => {
  const block = lb.renderReminderListBlock({
    reminders: [
      { title: 'לשלם ארנונה', remind_at: iso('2026-09-11T05:00:00Z') },
      { title: 'לקנות חלב', remind_at: iso('2026-09-11T07:00:00Z') },
    ],
    chasing: [{ id: 9, taskId: 4, title: 'להתקשר לאבא', askedFor: iso('2026-09-09T16:00:00Z'), rungsSent: 1 }],
  }, HE);
  assert.ok(!block.includes('להתקשר לאבא'),
    'the ladder\'s next rung depends on when the last one landed — it is not an hour to promise');
  assert.equal(block.split('\n').length, 3);
});

test('emphasis the person typed is cleaned out of a drawn line, and a marker inside a word is not', () => {
  const block = lb.renderReminderListBlock({
    reminders: [
      { title: 'לקנות חלב *דל לקטוז*', remind_at: iso('2026-09-11T05:00:00Z') },
      { title: 'לשלוח את report_final_v2', remind_at: iso('2026-09-11T06:00:00Z') },
    ],
  }, HE);
  assert.ok(block.includes('לקנות חלב דל לקטוז'), 'their markers go');
  assert.ok(block.includes('report_final_v2'), 'a marker glued inside a token is part of the token');
  // The heading's own pair is the only markup left in the block.
  assert.equal((block.match(/\*/g) || []).length, 2);
});

// ── Through the real tools ───────────────────────────────────────────────────
// Everything above is pure. What a block is FOR is what a tool hands over, and
// the one thing no unit test can see is the pair of hints that must not travel
// with it.
const { before, after } = require('node:test');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const soon = (h) => new Date(Date.now() + h * 3600_000).toISOString();

test('list_my_reminders draws the list, and says what each reminder is about', async () => {
  const u = await makeUser(db.pool, '+972501000201', { firstName: 'Vered', timezone: 'Asia/Jerusalem' });
  const add = BY_NAME.get('add_task');
  const setReminder = BY_NAME.get('set_task_reminder');
  const list = BY_NAME.get('list_my_reminders');

  const a = await withTx(db.pool, (c) => add.handler(c, u, { title: 'לקחת את הרכב לטסט', kind: 'todo' }));
  const b = await withTx(db.pool, (c) => add.handler(c, u, { title: 'לקחת תרופה', kind: 'todo' }));
  await withTx(db.pool, (c) => setReminder.handler(c, u, { task_id: a.data.task.id, remind_at: soon(20) }));
  await withTx(db.pool, (c) => setReminder.handler(c, u, {
    task_id: b.data.task.id, remind_at: soon(22), repeat_rule: 'daily',
  }));

  const res = await withTx(db.pool, (c) => list.handler(c, u, {}));
  assert.equal(res.ok, true);
  // The title is the fix, not the decoration: before this the result was ids
  // and instants, so anything that wanted to SAY what a reminder was about
  // had to go and fetch the tasks and match them up.
  assert.ok(res.data.reminders.every((r) => r.title), 'every row knows what it is about');
  assert.ok(res.data.reminders.every((r) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(r.at)),
    'and the hour to say, in their own clock, beside the instant');
  assert.match(res.data.block, /^\*תזכורות\*\n/);
  assert.match(res.data.block, /לקחת את הרכב לטסט/);
  assert.match(res.data.block, /לקחת תרופה, כל יום/);
  assert.match(res.data.hints.block, /already in their clock/);
  assert.equal(res.data.hints.layout, undefined, 'the block laid it out; asking again is the fault');
});

test('one reminder is a sentence, not a block — and the result still carries what to say', async () => {
  const u = await makeUser(db.pool, '+972501000202', { firstName: 'Guy', timezone: 'Asia/Jerusalem' });
  const a = await withTx(db.pool, (c) => BY_NAME.get('add_task').handler(c, u, { title: 'לשלם ארנונה', kind: 'todo' }));
  await withTx(db.pool, (c) => BY_NAME.get('set_task_reminder').handler(c, u, {
    task_id: a.data.task.id, remind_at: soon(5),
  }));
  const res = await withTx(db.pool, (c) => BY_NAME.get('list_my_reminders').handler(c, u, {}));
  assert.equal(res.data.block, undefined, 'a heading over one line is heavier than the line');
  assert.equal(res.data.reminders[0].title, 'לשלם ארנונה');
  assert.ok(res.data.reminders[0].at);
});
