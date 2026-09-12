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

// ---- the calendar ----------------------------------------------------------
// Every date below is a literal, verified against hebcal's own tables, so these
// mean the same thing whenever the suite runs — the rule that keeps the clock-
// drift workflow honest. The pinned year is 2026/27 because Rosh Hashana 5787
// begins the evening of Friday 11 September 2026, which is the week this
// shipped.

test('yom tov is quiet and nothing else is — the whole list, for one year', async () => {
  // Israel: eight days. That IS the owner's answer of 2026-09-11 ("רק ימי טוב"),
  // written down as data rather than as prose, so a later widening has to
  // change a test that says what it is widening.
  const il = [];
  for (const d of [
    '2026-09-12', '2026-09-13', // Rosh Hashana I, II
    '2026-09-21',               // Yom Kippur
    '2026-09-26',               // Sukkot I
    '2026-10-03',               // Shmini Atzeret / Simchat Torah
    '2027-04-22', '2027-04-28', // Pesach I, VII
    '2027-06-11',               // Shavuot
  ]) {
    const on = await holidays.holidaysOn('jewish', d, { il: true });
    il.push([d, on.length ? on[0].tier : 'none']);
  }
  assert.deepEqual(il.map(([, t]) => t), Array(8).fill('quiet'));

  // Chanukah, Purim, Lag BaOmer, a fast and Chol HaMoed are mentioned and
  // never quiet: they are real days AND ordinary working days, and a product
  // that goes silent on them is broken rather than respectful.
  for (const d of ['2026-12-05', '2027-03-23', '2026-09-28', '2026-09-14', '2027-05-25']) {
    const on = await holidays.holidaysOn('jewish', d, { il: true });
    assert.ok(on.length, `${d} should be a day she can mention`);
    assert.ok(on.every((e) => e.tier === 'mention'), `${d} must never be quiet`);
  }

  // An ordinary Tuesday is nothing at all, and that is most of the year: a
  // hint that fires on ordinary input is worse than no hint.
  assert.deepEqual(await holidays.holidaysOn('jewish', '2026-11-17', { il: true }), []);
});

test('the diaspora keeps the second day, and Israel does not', async () => {
  const second = async (d, il) => (await holidays.holidaysOn('jewish', d, { il })).map((e) => e.tier);
  assert.deepEqual(await second('2027-04-23', false), ['quiet'], 'Pesach II is yom tov abroad');
  assert.ok(!(await second('2027-04-23', true)).includes('quiet'), 'and Chol HaMoed in Israel');
  assert.deepEqual(await second('2026-10-04', false), ['quiet'], 'Simchat Torah is its own day abroad');
  assert.deepEqual(await second('2026-10-04', true), [], 'and is Shmini Atzeret in Israel');
});

test('a fast or a memorial day is marked solemn, so nothing wishes it happy', async () => {
  const solemn = async (d) => (await holidays.holidaysOn('jewish', d, { il: true }))[0].solemn;
  assert.equal(await solemn('2026-09-21'), true, 'Yom Kippur is yom tov AND a fast');
  assert.equal(await solemn('2027-05-04'), true, 'Yom HaShoah');
  assert.equal(await solemn('2027-05-11'), true, 'Yom HaZikaron');
  assert.equal(await solemn('2026-09-12'), false, 'Rosh Hashana is not');
  assert.equal((await holidays.holidaysOn('christian', '2027-03-26'))[0].solemn, true, 'Good Friday');
});

test('Christian dates: Easter is computed, the rest are fixed', async () => {
  // Western Easter, checked against the published table.
  const easter = (y) => holidays.easterSunday(y).toISOString().slice(0, 10);
  assert.equal(easter(2026), '2026-04-05');
  assert.equal(easter(2027), '2027-03-28');
  assert.equal(easter(2030), '2030-04-21');

  const tier = async (d) => (await holidays.holidaysOn('christian', d)).map((e) => e.tier);
  assert.deepEqual(await tier('2026-12-25'), ['quiet'], 'Christmas Day');
  assert.deepEqual(await tier('2026-12-24'), ['mention'], 'Christmas Eve is not');
  assert.deepEqual(await tier('2027-03-28'), ['quiet'], 'Easter Sunday');
  assert.deepEqual(await tier('2027-03-26'), ['quiet'], 'Good Friday');
  assert.deepEqual(await tier('2027-01-01'), ['mention'], 'New Year\'s Day');
  assert.deepEqual(await tier('2026-11-17'), []);

  // And a Jewish chag is not a Christian one, in either direction.
  assert.deepEqual(await tier('2026-09-21'), []);
  assert.deepEqual(await holidays.holidaysOn('jewish', '2026-12-25', { il: true }), []);
  assert.deepEqual(await holidays.holidaysOn('none', '2026-12-25'), []);
});

test('the name is what a person calls the day, not what a calendar app prints', async () => {
  const rh = (await holidays.holidaysOn('jewish', '2026-09-12', { il: true }))[0];
  // No nikud: Olma writes without it everywhere else, and one vowelled word in
  // an otherwise plain sentence reads as a quotation from somewhere.
  assert.equal(rh.name.he, 'ראש השנה');
  assert.doesNotMatch(rh.name.he, /[֑-ׇ]/);
  // And no Hebrew year, which hebcal appends to this one day.
  assert.doesNotMatch(rh.name.he, /5787/);
  assert.equal(rh.name.en, 'Rosh Hashana');

  // The roman numeral stays — which day of Sukkot it is changes their week —
  // and the calendar's "(CH''M)" annotation does not.
  const chm = (await holidays.holidaysOn('jewish', '2026-09-28', { il: true }))[0];
  assert.equal(chm.name.en, 'Sukkot III');
  assert.equal(chm.name.he, 'סכות ג׳');

  assert.equal(holidays.nameFor(rh, 'he'), 'ראש השנה');
  assert.equal(holidays.nameFor(rh, 'en'), 'Rosh Hashana');
  assert.equal(holidays.nameFor(null, 'he'), null);
});

test('the quiet window is read in THEIR zone, and covers a run of days', async () => {
  // 21:30 UTC on 11 September is already the 12th in Jerusalem — Rosh Hashana.
  const evening = new Date('2026-09-11T21:30:00Z');
  assert.equal(holidays.localDate('Asia/Jerusalem', evening), '2026-09-12');
  assert.equal(holidays.localDate('America/New_York', evening), '2026-09-11');

  const dates = await holidays.quietDates('jewish', {
    tz: 'Asia/Jerusalem', from: new Date('2026-09-10T09:00:00Z'), days: 30, il: true,
  });
  assert.deepEqual(dates, ['2026-09-12', '2026-09-13', '2026-09-21', '2026-09-26', '2026-10-03']);

  // Abroad the same month has more of them, which is the whole reason `il` is
  // a parameter rather than a constant.
  const chul = await holidays.quietDates('jewish', {
    tz: 'America/New_York', from: new Date('2026-09-10T09:00:00Z'), days: 30, il: false,
  });
  assert.ok(chul.includes('2026-09-27'), 'Sukkot II is yom tov abroad');
  assert.ok(chul.length > dates.length);
});

test('nextQuietHoliday answers in their language, or answers nothing', async () => {
  const soon = await holidays.nextQuietHoliday('jewish', {
    tz: 'Asia/Jerusalem', from: new Date('2026-09-08T09:00:00Z'), il: true, locale: 'he',
  });
  assert.equal(soon.date, '2026-09-12');
  assert.equal(soon.name, 'ראש השנה');
  assert.equal(soon.inDays, 4);

  // Nothing within the window is `null`, never an empty-ish object: the ladder
  // reads this to decide whether to spend a rung at all.
  const quietMonth = await holidays.nextQuietHoliday('jewish', {
    tz: 'Asia/Jerusalem', from: new Date('2026-11-01T09:00:00Z'), days: 14, il: true,
  });
  assert.equal(quietMonth, null);
  assert.equal(await holidays.nextQuietHoliday('none', { tz: 'UTC' }), null);
});
