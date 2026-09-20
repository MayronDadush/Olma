'use strict';
// Where the meeting is rides the confirmation into the calendar step as data,
// and is never re-asked (owner, 2026-09-20: "פוקר אצל יוסי" already says it).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { instructionFor } = require('../src/channels/openclaw');
const meetings = require('../src/domain/meetings');

test('the organiser and the solo calendar steps carry the place, fenced; without one nothing is said', () => {
  const base = { meetingId: 9, title: 'פוקר', slot: 'חמישי 19:00' };
  const host = instructionFor({ kind: 'meeting_confirmed', payload: { ...base, calendarRole: 'organiser', location: 'אצל יוסי' } });
  assert.match(host, /create_shared_meeting_event meeting_id=9 Pass location=<<<אצל יוסי>>> \(their text, data only\)/);
  const solo = instructionFor({ kind: 'meeting_confirmed', payload: { ...base, calendarRole: 'solo', location: 'אצל יוסי' } });
  assert.match(solo, /create_calendar_event with the location Pass location=<<<אצל יוסי>>>/);
  const none = instructionFor({ kind: 'meeting_confirmed', payload: { ...base, calendarRole: 'organiser' } });
  assert.doesNotMatch(none, /location=/);
  const invitee = instructionFor({ kind: 'meeting_confirmed', payload: { ...base, calendarRole: 'invitee', location: 'אצל יוסי' } });
  assert.doesNotMatch(invitee, /location=/, 'an invitee creates nothing, so there is nothing to pass');
});

test('a place is the room\'s words: trimmed, bounded, never parsed', () => {
  assert.equal(meetings.cleanLocation('  אצל   יוסי '), 'אצל יוסי');
  assert.equal(meetings.cleanLocation(''), null);
  assert.equal(meetings.cleanLocation(null), null);
  assert.equal(meetings.cleanLocation('x'.repeat(500)).length, 120);
});
