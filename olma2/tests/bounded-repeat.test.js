'use strict';
// "תזכורת כל ערב בשבוע הקרוב לסדר קבלות" — Dov, 2026-09-27. The model armed
// set_task_reminder(daily, 20:00) and said "לשבוע הקרוב"; the row had no end
// and would have run every evening for ever. The end is read off `when_said`,
// only when a repeat_rule was given.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const cd = require('../src/domain/chase-deadline');
const { partsInZone } = require('../src/domain/datetime');
const { BY_NAME } = require('../src/adapters/mcp/registry');

const TZ = 'Asia/Jerusalem';
const dayOf = (d) => {
  const p = partsInZone(TZ, d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

test('the end of a repeat, as people say it', () => {
  const yes = [
    ['כל ערב בשבוע הקרוב', { kind: 'days', n: 7 }],          // Dov, verbatim
    ['כל צהריים בשבוע הקרוב', { kind: 'days', n: 7 }],       // Dov, verbatim
    ['כל בוקר לשבוע הקרוב', { kind: 'days', n: 7 }],
    ['כל יום במשך השבוע הקרוב', { kind: 'days', n: 7 }],
    ['כל ערב עד סוף השבוע', { kind: 'end_of_week' }],
    ['כל יום השבוע', { kind: 'end_of_week' }],
    ['כל בוקר עד יום חמישי', { kind: 'weekday', weekday: 4 }],
    ['כל ערב עד שבוע הבא', { kind: 'next_week' }],
    ['כל יום עד סוף החודש', { kind: 'end_of_month' }],
    ['כל יום עד ה-15', { kind: 'date', day: 15 }],
    ['every evening for the next week', { kind: 'days', n: 7 }],
  ];
  for (const [text, want] of yes) {
    assert.deepEqual(cd.boundedByWords(text), { ...want, namedHour: false }, text);
  }
});

test('a standing routine has no end, and "next week" is not "this week"', () => {
  for (const text of [
    'כל יום בבוקר בשעה 8 וחצי',   // Dov's pill — a routine, never ends
    'כל יום ב-7',
    'כל 16 בחודש',
    'כל שבוע',
    'בשבוע הבא ביום שני',          // a moment, not an end — and NOT "השבוע"
    'כל ערב מ-9 עד 11',            // an hour range
    '',
  ]) {
    assert.equal(cd.boundedByWords(text), null, text);
  }
});

test('set_task_reminder(daily) with "כל ערב בשבוע הקרוב" stops after seven days, and says so', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972506620001', { timezone: TZ });
  const now = Date.now();
  const tomorrow = new Date(Math.floor((now + 86400_000) / 3600_000) * 3600_000);
  const added = await withTx(pool, (c) => tasks.addTask(c, u.id, { title: 'לסדר קבלות/הוצאות 2026' }));
  const res = await withTx(pool, (c) => BY_NAME.get('set_task_reminder').handler(c, { id: u.id, timezone: TZ }, {
    task_id: added.data.task.id,
    remind_at: tomorrow.toISOString().replace('Z', '+00:00'),
    repeat_rule: 'daily',
    when_said: 'כל ערב בשבוע הקרוב',
  }, { now: () => now }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.reminder.repeat_rule, 'daily');
  assert.equal(dayOf(new Date(res.data.reminder.repeat_until)), dayOf(new Date(now + 7 * 86400_000)));
  assert.match(res.data.hints.chase, /ENDS/);
});

test('set_task_reminder(daily) with no end in the words is still for ever', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972506620002', { timezone: TZ });
  const at = new Date(Math.floor((Date.now() + 86400_000) / 3600_000) * 3600_000);
  const added = await withTx(pool, (c) => tasks.addTask(c, u.id, { title: 'לשתות מים וכדור סגול' }));
  const res = await withTx(pool, (c) => BY_NAME.get('set_task_reminder').handler(c, { id: u.id, timezone: TZ }, {
    task_id: added.data.task.id,
    remind_at: at.toISOString().replace('Z', '+00:00'),
    repeat_rule: 'daily',
    when_said: 'כל יום בבוקר בשעה 8 וחצי',
  }, { now: () => Date.now() }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.reminder.repeat_until, null);
  assert.equal((res.data.hints || {}).chase, undefined);
});
