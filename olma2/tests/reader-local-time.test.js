'use strict';
// A private message about a meeting time says it in the READER's clock too
// (owner, 2026-09-25, פנתרה: "יום שבת 26.9 20:00" reached a man in Los
// Angeles, for whom it was ten in the morning). And the calendar step hands the
// agent the exact instant in the reader's offset: until this, each agent was
// told to re-read the words "20:00" in its own offset, which put an Israeli
// evening on an American calendar at 20:00 American time.
//
// Pure: no database, no gateway, and every instant is a literal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { instructionFor } = require('../src/channels/openclaw');

const SAT = {
  byName: 'Miron', title: 'שיחת וידאו', meetingId: 46,
  slot: 'יום שבת 26.9 20:00', startsAtUtc: '2026-09-26T17:00:00Z', authorTz: 'Asia/Jerusalem',
};

test('a proposed time reaches a reader abroad with their own hour, and a reader at home with nothing new', () => {
  const far = instructionFor({ kind: 'meeting_slot_proposed', timezone: 'America/Los_Angeles', payload: SAT });
  assert.match(far, /in THIS user's own time \(לוס אנג׳לס\) it is <<<יום שבת 26\.9 10:00>>>/);
  const home = instructionFor({ kind: 'meeting_slot_proposed', timezone: 'Asia/Jerusalem', payload: SAT });
  assert.doesNotMatch(home, /another clock/);
});

test('a time the words never pinned is not converted, and an unknown author clock is never guessed', () => {
  const fuzzy = instructionFor({ kind: 'meeting_slot_proposed', timezone: 'America/Los_Angeles',
    payload: { ...SAT, slot: 'שבת בערב' } });
  assert.doesNotMatch(fuzzy, /another clock/);
  const old = instructionFor({ kind: 'meeting_slot_proposed', timezone: 'America/Los_Angeles',
    payload: { ...SAT, authorTz: undefined } });
  assert.doesNotMatch(old, /another clock/, 'a row queued before payloads carried the author clock');
});

test('the confirmed calendar step carries the exact start in the reader\'s offset, never a recompute from the words', () => {
  const far = instructionFor({ kind: 'meeting_confirmed', timezone: 'America/Los_Angeles',
    payload: { ...SAT, calendarRole: 'solo' } });
  assert.match(far, /start at exactly 2026-09-26T10:00:00-07:00/);
  assert.match(far, /never recompute it from the slot text/);
  assert.match(far, /<<<יום שבת 26\.9 10:00>>>/);

  const home = instructionFor({ kind: 'meeting_confirmed', timezone: 'Asia/Jerusalem',
    payload: { ...SAT, calendarRole: 'organiser' } });
  assert.match(home, /Start at exactly 2026-09-26T20:00:00\+03:00/);

  // A daypart keeps the old wording: there is no exact instant to hand over.
  const fuzzy = instructionFor({ kind: 'meeting_confirmed', timezone: 'America/Los_Angeles',
    payload: { ...SAT, slot: 'שבת בערב', daypart: 'evening' } });
  assert.match(fuzzy, /work out the real start and end from the slot text/);
});
