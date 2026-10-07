'use strict';
// A slot is the proposer's words, and "מחר" in them is true on the day they
// were written (2026-10-06: the poker room heard "מחר (שלישי) בערב" on the
// Tuesday). The room's lines were fixed first; this is the private side, where
// the words reach the model inside the instruction built at DELIVERY.
//
// The instruction reads the live clock, so the moment is built off it ONCE:
// 19:00 today in Israel, whatever hour the suite runs — "מחר" about it is
// wrong by construction (.claude/rules/testing.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { instructionFor } = require('../src/channels/openclaw');
const dt = require('../src/domain/datetime');
const meetingTime = require('../src/domain/meeting-time');

const IL = 'Asia/Jerusalem';
const TODAY = (() => {
  const p = dt.partsInZone(IL, new Date());
  const at = new Date(dt.instantInZone(IL, { y: p.y, m: p.m, d: p.d, hh: 19, mi: 0, ss: 0 }));
  return { startsAtUtc: at.toISOString(), weekday: meetingTime.DAYS_HE[dt.weekdayOfParts(p)] };
})();
const FRESH = `<<<היום (${TODAY.weekday}) בערב>>>`;
const STALE = '<<<מחר בערב>>>';
const base = {
  meetingId: 74, title: 'פוקר', byName: 'מירון', slot: 'מחר בערב',
  startsAtUtc: TODAY.startsAtUtc, daypart: 'evening', authorTz: IL,
};

test('a proposal says the day as it is when it goes out, and pins the yes to the same instant', () => {
  const startsAt = '2026-10-06T19:00:00+03:00';
  const body = instructionFor({ kind: 'meeting_slot_proposed', timezone: IL, payload: { ...base, startsAt } });
  assert.ok(body.includes(FRESH), 'the day is said again');
  assert.ok(!body.includes(STALE), 'the stale word is gone');
  assert.ok(body.includes(`accepted_starts_at="${startsAt}"`), 'the instant handed back is the stored one');
});

test('a confirmation says it too', () => {
  const body = instructionFor({ kind: 'meeting_confirmed', timezone: IL, payload: base });
  assert.ok(body.includes(FRESH));
});

test('a part of a merged message says it too', () => {
  const body = instructionFor({
    kind: 'meeting_confirmed', timezone: IL, payload: {
      ...base,
      mergedParts: [
        { kind: 'meeting_confirmed', payload: base },
        { kind: 'meeting_slot_proposed', payload: { ...base, meetingId: 75, title: 'קפה' } },
      ],
    },
  });
  assert.equal(body.split(FRESH).length - 1, 2, 'both parts');
  assert.ok(!body.includes(STALE));
});

test('the reader\'s clock decides the day only when the row names no author', () => {
  const { authorTz: _gone, ...noAuthor } = base;
  assert.ok(instructionFor({ kind: 'meeting_confirmed', timezone: IL, payload: noAuthor }).includes(FRESH));
});

test('a payload with no instant says what it always said', () => {
  const { startsAtUtc: _gone, ...bare } = base;
  assert.ok(instructionFor({ kind: 'meeting_confirmed', timezone: IL, payload: bare }).includes(STALE));
  // …and so does one whose word is still true
  const tomorrow = new Date(Date.parse(TODAY.startsAtUtc) + 24 * 3600e3).toISOString();
  assert.ok(instructionFor({ kind: 'meeting_confirmed', timezone: IL, payload: { ...base, startsAtUtc: tomorrow } }).includes(STALE));
});
