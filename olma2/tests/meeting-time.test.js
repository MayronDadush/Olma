'use strict';
// One moment, said in every zone the people hearing it live in (owner,
// 2026-09-25, off פנתרה: two members in Israel, one in the US, one in
// Australia, and the room heard only the proposer's Israeli hour).
//
// Every instant below is a literal, computed once, and every assertion is about
// a zone named in the test — nothing here depends on the hour the suite runs or
// the zone of the machine running it (.claude/rules/testing.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mt = require('../src/domain/meeting-time');

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const SYD = 'Australia/Sydney';

// פנתרה's own option 62: "יום שבת 26.9 20:00", 17:00 UTC.
const SAT_EVENING = { startsAt: '2026-09-26T17:00:00Z', slot: 'יום שבת 26.9 20:00' };

test('a room on four clocks hears the time in each, the room\'s own first and the rest west to east', () => {
  const t = mt.roomTimes(SAT_EVENING, [IL, NY, SYD, LA], IL);
  assert.equal(t.day, 'יום שבת 26.9');
  assert.deepEqual(t.lines, ['20:00 ישראל', '10:00 לוס אנג׳לס', '13:00 ניו יורק', '03:00 סידני (יום ראשון 27.9)']);
  assert.equal(t.inline, 'יום שבת 26.9 · 20:00 ישראל · 10:00 לוס אנג׳לס · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)');
});

test('a zone that lands on another calendar day says which one — both directions', () => {
  // 01:00 Sunday in Israel is still Saturday in New York.
  const late = mt.roomTimes({ startsAt: '2026-09-26T22:00:00Z', slot: 'יום ראשון 27.9 01:00' }, [IL, NY], IL);
  assert.deepEqual(late.lines, ['01:00 ישראל', '18:00 ניו יורק (יום שבת 26.9)']);
});

test('one clock is nothing to convert, and the caller keeps the words it had', () => {
  assert.equal(mt.roomTimes(SAT_EVENING, [IL, IL], IL), null);
  assert.equal(mt.roomTimes(SAT_EVENING, [], IL), null);
  assert.equal(mt.spansZones([IL], IL), false);
  assert.equal(mt.spansZones([IL, NY], IL), true);
});

test('a time that names no clock is never turned into one', () => {
  // "בערב" went into starts_at as a representative 19:00; "12:00 in New York"
  // would be precision nobody said.
  assert.equal(mt.roomTimes({ startsAt: '2026-09-29T16:00:00Z', slot: 'יום שלישי 29.9 בערב' }, [IL, NY], IL), null);
  assert.equal(mt.roomTimes({ ...SAT_EVENING, daypart: 'evening' }, [IL, NY], IL), null);
  assert.equal(mt.roomTimes({ ...SAT_EVENING, allDay: true }, [IL, NY], IL), null);
  assert.equal(mt.roomTimes({ slot: 'יום שבת 26.9 20:00' }, [IL, NY], IL), null, 'no instant, nothing to convert');
  // A day of the month is not a clock.
  assert.equal(mt.roomTimes({ startsAt: SAT_EVENING.startsAt, slot: 'ב-26 לחודש' }, [IL, NY], IL), null);
});

test('zones on the same clock at THAT moment are one line, with both cities', () => {
  const athens = mt.roomTimes(SAT_EVENING, [IL, 'Europe/Athens', NY], IL);
  assert.deepEqual(athens.lines, ['20:00 ישראל, יוון', '13:00 ניו יורק']);
  // and two spellings of one zone are one city
  const twice = mt.roomTimes(SAT_EVENING, [IL, 'Asia/Tel_Aviv', NY], IL);
  assert.equal(twice.lines.length, 2);
});

test('the merge is decided per moment, across Sydney\'s own DST change', () => {
  // Sydney moves to +11 on Sunday 4 October 2026; New York stays -4 until 1 November.
  const before = mt.roomTimes({ startsAt: '2026-10-03T09:00:00Z', slot: 'יום שבת 3.10 12:00' }, [IL, SYD], IL);
  const after = mt.roomTimes({ startsAt: '2026-10-10T09:00:00Z', slot: 'יום שבת 10.10 12:00' }, [IL, SYD], IL);
  assert.deepEqual(before.lines, ['12:00 ישראל', '19:00 סידני']);
  assert.deepEqual(after.lines, ['12:00 ישראל', '20:00 סידני'], 'same Israeli hour, an hour later in Sydney');
});

test('one reader: their own clock beside the proposer\'s words, or nothing when the clocks agree', () => {
  assert.deepEqual(mt.readerSlot(SAT_EVENING, LA, IL), { slot: 'יום שבת 26.9 10:00', short: '10:00', city: 'לוס אנג׳לס' });
  assert.deepEqual(mt.readerSlot(SAT_EVENING, SYD, IL),
    { slot: 'יום ראשון 27.9 03:00', short: 'יום ראשון 27.9 03:00', city: 'סידני' }, 'another day says the day');
  assert.equal(mt.readerSlot(SAT_EVENING, IL, IL), null);
  assert.equal(mt.readerSlot(SAT_EVENING, 'Europe/Athens', IL), null, 'same wall clock that night');
  assert.equal(mt.readerSlot({ ...SAT_EVENING, slot: 'שבת בערב' }, LA, IL), null);
  assert.equal(mt.readerSlot(SAT_EVENING, LA, null), null, 'an unknown author clock is never guessed');
});

test('a city name is never a raw offset, and a bad zone is empty rather than a throw', () => {
  for (const tz of [IL, NY, LA, SYD, 'Europe/London', 'Asia/Tokyo', 'America/Argentina/Buenos_Aires']) {
    const label = mt.zoneLabel(tz);
    assert.ok(label && !/GMT|UTC|[+-]\d/.test(label), `${tz} → ${label}`);
  }
  assert.equal(mt.zoneLabel('Not/AZone'), '');
  assert.equal(mt.zoneLabel(null), '');
  assert.equal(mt.roomTimes(SAT_EVENING, ['Not/AZone', IL], IL), null, 'a bad zone is ignored, not a second clock');
});

test('the cities for the opening line, joined the way Hebrew joins them', () => {
  assert.equal(mt.citiesPhrase([NY, SYD], IL, new Date('2026-09-26T17:00:00Z')), 'ישראל, ניו יורק וסידני');
  assert.equal(mt.citiesPhrase([NY], IL, new Date('2026-09-26T17:00:00Z')), 'ישראל וניו יורק');
});

// An English page printed the stored Hebrew words for a meeting's time (owner,
// 2026-09-26). readerLabel says the moment in English, in the reader's zone —
// and keeps the header's rule that a daypart or a whole day is never an hour.
test('readerLabel says a moment in English, and says nothing for a Hebrew page', () => {
  assert.equal(mt.readerLabel(SAT_EVENING, IL, IL, 'en'), 'Saturday, 26 September · 20:00');
  // the reader's own clock, not the proposer's
  assert.equal(mt.readerLabel(SAT_EVENING, LA, IL, 'en'), 'Saturday, 26 September · 10:00');
  assert.equal(mt.readerLabel(SAT_EVENING, SYD, IL, 'en'), 'Sunday, 27 September · 03:00');
  assert.equal(mt.readerLabel(SAT_EVENING, IL, IL, 'he'), null);
  assert.equal(mt.readerLabel(SAT_EVENING, IL, IL, null), null);
});

test('readerLabel never turns a daypart or a whole day into an hour, and dates it where it was said', () => {
  // "בערב" became 19:00 in Israel on its way into starts_at; 16:00Z.
  const evening = { startsAt: '2026-09-29T16:00:00Z', daypart: 'evening', slot: 'יום שלישי 29.9 בערב' };
  assert.equal(mt.readerLabel(evening, IL, IL, 'en'), 'Tuesday, 29 September · evening');
  // Sydney is already Wednesday at that instant; the words named Tuesday.
  assert.equal(mt.readerLabel(evening, SYD, IL, 'en'), 'Tuesday, 29 September · evening');
  const allDay = { startsAt: '2026-09-29T06:00:00Z', allDay: true, slot: 'יום שלישי 29.9 כל היום' };
  assert.equal(mt.readerLabel(allDay, IL, IL, 'en'), 'Tuesday, 29 September · all day');
  // Words with no clock in them and no daypart column: the words stay.
  assert.equal(mt.readerLabel({ startsAt: '2026-09-29T16:00:00Z', slot: 'שלישי אחרי העבודה' }, IL, IL, 'en'), null);
  assert.equal(mt.readerLabel({ slot: 'יום שבת 26.9 20:00' }, IL, IL, 'en'), null);
});
