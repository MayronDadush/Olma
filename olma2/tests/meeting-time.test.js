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

// ---- a day word that has gone stale (2026-10-06) --------------------------------
// The poker room's option 127, proposed on Monday 5.10: "מחר (שלישי) בערב",
// 19:00 in Israel on Tuesday 6.10. Read at 09:00 on the Tuesday, "מחר" is wrong.
const TUE_EVENING = { startsAt: '2026-10-06T16:00:00Z', daypart: 'evening' };
const MON_NOON = new Date('2026-10-05T10:00:00Z');
const TUE_MORNING = new Date('2026-10-06T06:00:00Z');
const THU_MORNING = new Date('2026-10-08T06:00:00Z');

test('a day word still true on the day it is said is left exactly as written', () => {
  assert.equal(mt.freshDayWords('מחר (שלישי) בערב', TUE_EVENING, IL, MON_NOON), 'מחר (שלישי) בערב');
  assert.equal(mt.freshDayWords('הערב ב-19:00', TUE_EVENING, IL, TUE_MORNING), 'הערב ב-19:00');
});

test('a stale day word is said again, from the instant, and the rest of the words stay', () => {
  assert.equal(mt.freshDayWords('מחר (שלישי) בערב', TUE_EVENING, IL, TUE_MORNING), 'היום (שלישי) בערב');
  assert.equal(mt.freshDayWords('מחר ב-19:00 אצל יוסי', TUE_EVENING, IL, TUE_MORNING), 'היום (שלישי) ב-19:00 אצל יוסי');
  // two days before: "היום" said on the Sunday is the Tuesday's own word only on the Tuesday
  const SUN = new Date('2026-10-04T08:00:00Z');
  assert.equal(mt.freshDayWords('היום בערב', TUE_EVENING, IL, SUN), 'יום שלישי 6.10 בערב');
  // a word that names the part of the day too keeps the part
  assert.equal(mt.freshDayWords('הערב', TUE_EVENING, IL, MON_NOON), 'מחר (שלישי) בערב');
  // the prefix stays; ל is how a slot often starts
  assert.equal(mt.freshDayWords('למחר בערב', TUE_EVENING, IL, TUE_MORNING), 'להיום (שלישי) בערב');
  // a day already gone is a date, never "אתמול" invented on top of their words
  assert.equal(mt.freshDayWords('מחר בערב', TUE_EVENING, IL, THU_MORNING), 'יום שלישי 6.10 בערב');
});

test('the small hours of "הלילה" belong to the evening before them', () => {
  const late = { startsAt: '2026-10-06T22:30:00Z' }; // 01:30 Wednesday in Israel
  assert.equal(mt.freshDayWords('הלילה ב-01:30', late, IL, TUE_MORNING), 'הלילה ב-01:30');
  assert.equal(mt.freshDayWords('הלילה ב-01:30', late, IL, MON_NOON), 'מחר (שלישי) בלילה ב-01:30');
});

test('the day is read on the clock the words were written on', () => {
  // 01:00 Wednesday in Israel is still Tuesday evening in New York.
  const ny = { startsAt: '2026-10-07T01:00:00Z' };
  const nyMonday = new Date('2026-10-05T16:00:00Z');
  assert.equal(mt.freshDayWords('מחר ב-21:00', ny, NY, nyMonday), 'מחר ב-21:00');
  assert.equal(mt.freshDayWords('מחר ב-21:00', ny, IL, nyMonday), 'יום רביעי 7.10 ב-21:00');
});

test('anything it cannot be sure of comes back untouched', () => {
  const words = 'מחר בערב';
  assert.equal(mt.freshDayWords(words, null, IL, TUE_MORNING), words);
  assert.equal(mt.freshDayWords(words, { startsAt: null }, IL, TUE_MORNING), words);
  assert.equal(mt.freshDayWords(words, TUE_EVENING, 'Not/AZone', TUE_MORNING), words);
  assert.equal(mt.freshDayWords(words, TUE_EVENING, null, TUE_MORNING), words);
  // two moving words: which one the instant belongs to is a guess
  assert.equal(mt.freshDayWords('היום או מחר בערב', TUE_EVENING, IL, THU_MORNING), 'היום או מחר בערב');
  // no moving word at all
  assert.equal(mt.freshDayWords('יום שלישי 6.10 בערב', TUE_EVENING, IL, THU_MORNING), 'יום שלישי 6.10 בערב');
  // a word that only CONTAINS one is not one: "מחרתיים" is read whole, not as "מחר"
  assert.equal(mt.freshDayWords('מחרתיים בערב', TUE_EVENING, IL, MON_NOON), 'מחר (שלישי) בערב');
  assert.equal(mt.freshDayWords('בהמחרה', TUE_EVENING, IL, THU_MORNING), 'בהמחרה');
  assert.equal(mt.freshDayWords('', TUE_EVENING, IL, THU_MORNING), '');
});

test('"היום" that is a noun or a duration is not a day that goes stale', () => {
  // a whole day: "כל היום" is how long, and "מחר" is the only moving word
  assert.equal(mt.freshDayWords('מחר כל היום', TUE_EVENING, IL, TUE_MORNING), 'היום (שלישי) כל היום');
  assert.equal(mt.freshDayWords('היום הראשון של החג', TUE_EVENING, IL, THU_MORNING), 'היום הראשון של החג');
  // a weekday after it is the day it names
  assert.equal(mt.freshDayWords('היום שלישי בערב', TUE_EVENING, IL, MON_NOON), 'מחר (שלישי) בערב');
});
