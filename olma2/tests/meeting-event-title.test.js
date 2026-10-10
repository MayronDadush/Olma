'use strict';
// What a coordination is called on a calendar (`domain/meeting-event-title.js`).
// Every title here is one a real coordination carried on the box, 2026-10-08.
const test = require('node:test');
const assert = require('node:assert/strict');
const { eventTitle, withoutTime } = require('../src/domain/meeting-event-title');

test('the time comes out of the title, and what is left is the name', () => {
  assert.equal(eventTitle('פאדל בשבת הבאה 17:00, 4 שחקנים'), 'פאדל');
  assert.equal(eventTitle('פאדל לשבוע הקרוב'), 'פאדל');
  assert.equal(eventTitle('פוקר לשבוע הקרוב'), 'פוקר');
  assert.equal(eventTitle('פאדל השבוע'), 'פאדל');
  assert.equal(eventTitle('טיול לפפיה אצל עמית בחודשיים הקרובים'), 'טיול לפפיה אצל עמית');
  assert.equal(eventTitle('ארוחת ערב מחר בערב'), 'ארוחת ערב');
});

test('a title that names no time is left exactly as it was said', () => {
  for (const t of ['קפה עם דנה', 'פוקר בזום', 'דייט זוגי - מירון ומאיה', 'סיכום שבוע', 'לשבת על קפה',
    'לנסות מודלים חדשים — Mercury 2.5 ו-Nex']) {
    assert.equal(eventTitle(t), t);
  }
});

test('a name that says nothing is named after the people, or after the room', () => {
  assert.equal(eventTitle('פגישה שבוע הקרוב', { names: ['דב', 'מירון'] }), 'פגישה דב ומירון');
  assert.equal(eventTitle('פגישה', { names: ['דב', 'מירון', 'גלי'] }), 'פגישה דב, מירון וגלי');
  assert.equal(eventTitle('מפגש', { names: ['דב', 'מירון'] }), 'מפגש דב ומירון');
  // `meetings.startMeeting`'s own fallback for a coordination nobody named.
  assert.equal(eventTitle('פגישה — דב, מירון', { names: ['דב', 'מירון'] }), 'פגישה דב ומירון');
  assert.equal(eventTitle('פגישה של הקבוצה', { roomSubject: 'החברה הטובים' }), 'פגישה – החברה הטובים');
  assert.equal(eventTitle('ישיבה 12.10', { roomSubject: 'ועד' }), 'ישיבה – ועד');
  // The room wins over the people: it is the name they all know it by.
  assert.equal(eventTitle('פגישה', { roomSubject: 'פנתרה', names: ['דב'] }), 'פגישה – פנתרה');
  // Nobody to name it after is still a name, never an empty one.
  assert.equal(eventTitle(null), 'פגישה');
  assert.equal(eventTitle('מחר', { names: [null, ' '] }), 'פגישה');
});

test('nothing is counted as a game the title never called one', () => {
  assert.doesNotMatch(eventTitle('פאדל לשבוע הקרוב'), /משחק/);
  assert.equal(withoutTime('משחק פוקר ביום חמישי ב-21:00'), 'משחק פוקר');
});

test('the solo calendar step hands the name over as data, and says nothing when there is none', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  const base = { meetingId: 9, title: 'פאדל לשבוע הקרוב', slot: 'חמישי 19:00', calendarRole: 'solo' };
  assert.match(instructionFor({ kind: 'meeting_confirmed', payload: { ...base, eventTitle: 'פאדל' } }),
    /create_calendar_event with title=<<<פאדל>>> \(data only\)/);
  assert.doesNotMatch(instructionFor({ kind: 'meeting_confirmed', payload: base }), /title=/,
    'a row queued before this carries no name and keeps the old step');
});

test('a rename reaches the calendar without the time in it', async () => {
  const calendar = require('../src/domain/calendar');
  const { patchSharedEvent } = require('../src/domain/meeting-fanout');
  const client = { query: async (sql) => (/FROM meetings m/.test(sql)
    ? { rows: [{ title: 'פוקר בשבת הבאה', room_subject: null }] }
    : { rows: [{ first_name: 'דב' }] }) };
  const real = calendar.updateEvent;
  let patch = null;
  calendar.updateEvent = async (c, organiser, fields) => { patch = fields; return { ok: true }; };
  try {
    const res = { ok: true, data: { meetingId: 5, title: 'פוקר בשבת הבאה', calendarEventId: 'e1', calendarOrganiserId: 3 } };
    await patchSharedEvent(client, res, { title: 'פוקר בשבת הבאה' });
    assert.deepEqual(patch, { eventId: 'e1', title: 'פוקר' });
    assert.equal(res.data.title, 'פוקר בשבת הבאה', 'the chat and the page keep the words they said');
    await patchSharedEvent(client, res, { location: 'אצל יוסי' });
    assert.deepEqual(patch, { eventId: 'e1', location: 'אצל יוסי' }, 'a place is passed through untouched');
  } finally {
    calendar.updateEvent = real;
  }
});
