'use strict';
// The bug these cover: meeting #4 ("פוקר") stored "יום שני 20:00" as a Tuesday
// and "יום שלישי 20:00" as a Wednesday. Nothing errored — the words and the
// timestamp simply disagreed, and every later thing (expiry, nudges, the
// calendar event) read the timestamp while both men read the words.
//
// Pure vocabulary tests, no DB: this is the one place the rule lives, the same
// way reminders.normalizeRepeatRule is for repeat rules.
const test = require('node:test');
const assert = require('node:assert');
const { weekdaysInText, weekdayInZone, weekdayClash } = require('../src/domain/datetime');

const IL = 'Asia/Jerusalem';

test('reads the Hebrew weekday names people actually write', () => {
  assert.deepEqual(weekdaysInText('יום ראשון 20:00'), [0]);
  assert.deepEqual(weekdaysInText('יום שני 20:00'), [1]);
  assert.deepEqual(weekdaysInText('יום שלישי 20:00'), [2]);
  assert.deepEqual(weekdaysInText('יום רביעי בערב'), [3]);
  assert.deepEqual(weekdaysInText('יום חמישי 13:00 בקפה'), [4]);
  assert.deepEqual(weekdaysInText('שישי 20:00 אצל דני'), [5]);
  assert.deepEqual(weekdaysInText('ששי בערב'), [5]);
  assert.deepEqual(weekdaysInText('בשבת בבוקר'), [6]);
  assert.deepEqual(weekdaysInText('ביום שלישי בטלפון'), [2]);
  assert.deepEqual(weekdaysInText("יום א' 09:00"), [0]);
  assert.deepEqual(weekdaysInText('יום ו׳ 20:00'), [5]);
});

test('reads English weekdays and their abbreviations', () => {
  assert.deepEqual(weekdaysInText('Tuesday 17:00, cafe'), [2]);
  assert.deepEqual(weekdaysInText('wednesday-ish, 18:00'), [3]);
  assert.deepEqual(weekdaysInText('Sat 20:00'), [6]);
  assert.deepEqual(weekdaysInText('thurs 9am, zoom'), [4]);
});

// A false positive REFUSES a proposal a person really made, so the reader is
// deliberately narrow: only day words, only at word edges.
test('does not invent a weekday out of a word that merely looks like one', () => {
  assert.deepEqual(weekdaysInText('המשימה השנייה'), []);   // שנייה, not שני
  assert.deepEqual(weekdaysInText('שלושה אנשים'), []);
  assert.deepEqual(weekdaysInText('לשבת בקפה ב-20:00'), []); // "to sit", not Saturday
  assert.deepEqual(weekdaysInText('ראשונה מבין השתיים'), []);
  assert.deepEqual(weekdaysInText('a sunny terrace, 18:00'), []);
  assert.deepEqual(weekdaysInText('next month'), []);
  assert.deepEqual(weekdaysInText('מחר 10:00'), []);
  assert.deepEqual(weekdaysInText('הערב 20:00'), []);
  assert.deepEqual(weekdaysInText('whenever'), []);
  assert.deepEqual(weekdaysInText(''), []);
  assert.deepEqual(weekdaysInText(null), []);
});

test('the weekday is the one the USER sees, in their own timezone', () => {
  // 2026-08-24T22:00Z is still Monday in UTC and already Tuesday in Israel.
  assert.equal(weekdayInZone('2026-08-24T22:00:00Z', 'UTC'), 1);
  assert.equal(weekdayInZone('2026-08-24T22:00:00Z', IL), 2);
  // No timezone on file (or an unusable one) → the offset the model itself
  // wrote, which is its own claim about the local wall clock. Never silently UTC.
  assert.equal(weekdayInZone('2026-08-25T00:30:00+03:00', null), 2);
  assert.equal(weekdayInZone('2026-08-25T00:30:00+03:00', 'Mars/Olympus'), 2);
  assert.equal(weekdayInZone('not a time', IL), null);
});

test('the live meeting #4 mismatch is refused, not stored', () => {
  // What actually happened: both men were discussing Monday and Tuesday.
  const monday = weekdayClash('slot_description', 'יום שני 20:00', '2026-08-25T20:00:00+03:00', IL);
  assert.equal(monday.ok, false);
  assert.equal(monday.error.reason, 'weekday_mismatch');
  assert.match(monday.error.message, /Monday/);
  assert.match(monday.error.message, /Tuesday/);

  const tuesday = weekdayClash('slot_description', 'יום שלישי 20:00', '2026-08-26T20:00:00+03:00', IL);
  assert.equal(tuesday.ok, false);

  // …and the one that was right stays right.
  assert.equal(weekdayClash('slot_description', 'יום ראשון 20:00', '2026-08-23T20:00:00+03:00', IL), null);
});

test('text naming no weekday is left exactly as it was', () => {
  assert.equal(weekdayClash('slot_description', 'מחר ב-20:00', '2026-08-25T20:00:00+03:00', IL), null);
  assert.equal(weekdayClash('slot_description', 'whenever suits you', '2026-08-25T20:00:00+03:00', IL), null);
  // Unparseable timestamps are somebody else's refusal (hasOffset/badTime);
  // this rule must not turn them into a weekday complaint.
  assert.equal(weekdayClash('slot_description', 'יום שני', 'garbage', IL), null);
});

test('a text offering two days is checked against both', () => {
  const iso = '2026-08-25T20:00:00+03:00'; // Tuesday
  assert.equal(weekdayClash('slot_description', 'ראשון או שלישי ב-20:00', iso, IL), null);
  const clash = weekdayClash('slot_description', 'Sunday or Monday, 20:00', iso, IL);
  assert.equal(clash.ok, false);
  assert.deepEqual(clash.error.namedWeekdays, [0, 1]);
  assert.equal(clash.error.actualWeekday, 2);
});

// Timezone matters at the edges and only at the edges: 20:00 Israel time is
// still the same day in UTC, but a late-evening slot written in UTC is not.
test('a slot near midnight is judged where the person lives', () => {
  const bad = weekdayClash('slot_description', 'יום שני 23:30', '2026-08-24T21:30:00Z', IL);
  assert.equal(bad.ok, false, 'Monday 23:30 UTC is already Tuesday 00:30 in Israel');
  assert.equal(weekdayClash('slot_description', 'יום שני 23:30', '2026-08-24T20:30:00Z', IL), null);
});
