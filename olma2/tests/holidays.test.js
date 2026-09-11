'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const holidays = require('../src/domain/holidays');
const { DAY_NAMES } = require('../src/domain/preferences');

const dayName = (calendar) => {
  const d = holidays.defaultQuietDay(calendar);
  return d === null ? null : DAY_NAMES[d];
};

test('language picks the calendar, and the calendar picks the day', () => {
  assert.equal(holidays.calendarFor({ locale: 'he' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'he-IL' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'en' }), 'christian');
  assert.equal(holidays.calendarFor({ locale: 'en-US' }), 'christian');

  assert.equal(dayName('jewish'), 'sat');
  assert.equal(dayName('christian'), 'sun');
  assert.equal(dayName('none'), null);
});

test('geography overrules language, because Sunday is a working day in Israel', () => {
  // The expensive mistake in this pair: guessing a Christian calendar for an
  // English speaker in Tel Aviv silences an ordinary working Sunday for them,
  // while guessing Jewish for an English speaker abroad costs a Saturday they
  // can correct in one sentence.
  assert.equal(holidays.calendarFor({ locale: 'en', timezone: 'Asia/Jerusalem' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'ru', timezone: 'Asia/Tel_Aviv' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'en', timezone: 'America/New_York' }), 'christian');
  assert.equal(holidays.calendarFor({ locale: 'he', timezone: 'America/New_York' }), 'jewish');
});

test('a calendar they stated is never guessed about again', () => {
  assert.equal(holidays.calendarFor({ locale: 'he', preference: 'christian' }), 'christian');
  assert.equal(holidays.calendarFor({ locale: 'en', preference: 'jewish' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'he', timezone: 'Asia/Jerusalem', preference: 'none' }), 'none');
  // Garbage in that column is not an answer, so the guess stands rather than
  // the whole default disappearing.
  assert.equal(holidays.calendarFor({ locale: 'he', preference: 'שבת' }), 'jewish');
  assert.equal(holidays.calendarFor({ locale: 'he', preference: '' }), 'jewish');
});

test('nothing at all still answers, and answers the same way every time', () => {
  // The gate reads this on every row: undefined, null and an empty object must
  // never throw and must never disagree with each other.
  assert.equal(holidays.calendarFor(), 'christian');
  assert.equal(holidays.calendarFor({}), 'christian');
  assert.equal(holidays.calendarFor({ locale: null, timezone: null }), 'christian');
  assert.equal(holidays.defaultQuietDay(undefined), null);
});

test('the day is named in their language, off the same table the gate reads', () => {
  assert.equal(holidays.quietDayWord(6, 'he'), 'בשבת');
  assert.equal(holidays.quietDayWord(6, 'en'), 'on Saturdays');
  assert.equal(holidays.quietDayWord(0, 'he'), 'בימי ראשון');
  assert.equal(holidays.quietDayWord(0, 'en'), 'on Sundays');
  // A weekday nothing defaults to has no word, and callers must get null
  // rather than an invented one — the check-in copy is built from this.
  assert.equal(holidays.quietDayWord(3, 'he'), null);
  assert.equal(holidays.quietDayWord(null, 'he'), null);
});
