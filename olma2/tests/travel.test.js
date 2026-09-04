'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectTrip } = require('../src/domain/travel');

const NOW = new Date('2026-09-04T09:00:00Z');
const IL = 'Asia/Jerusalem';

function timed(id, start, timeZone, extra = {}) {
  return { id, title: 'x', start, end: start, timeZone, allDay: false, location: null, ...extra };
}
function allDay(id, start, end, extra = {}) {
  return { id, title: 'x', start, end, timeZone: null, allDay: true, location: null, ...extra };
}

test('one foreign-zone meeting is a video call, not a trip', () => {
  // The false positive that would have made this feature unusable: a colleague
  // in Berlin books a call, Google stamps it Europe/Berlin, and Olma asks a
  // person who never left their desk whether they are abroad.
  const events = [timed('a', '2026-09-10T08:00:00Z', 'Europe/Berlin')];
  assert.equal(detectTrip(events, IL, NOW), null);
});

test('the same foreign clock on two different days is a trip', () => {
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Europe/Berlin'),
    timed('b', '2026-09-11T08:00:00Z', 'Europe/Berlin'),
  ];
  const trip = detectTrip(events, IL, NOW);
  assert.ok(trip, 'a week of foreign mornings is not a call');
  assert.equal(trip.zone, 'Europe/Berlin');
  assert.equal(trip.startsAt, '2026-09-10T08:00:00.000Z');
  assert.equal(trip.evidence.length, 2);
});

test('two events in the same foreign clock on ONE day is still a call', () => {
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Europe/Berlin'),
    timed('b', '2026-09-10T14:00:00Z', 'Europe/Berlin'),
  ];
  assert.equal(detectTrip(events, IL, NOW), null);
});

test('a different zone NAME with the same clock is not a trip', () => {
  // Europe/Madrid and Europe/Paris are one wall clock. Comparing zone strings
  // would announce a journey to somebody whose day did not change at all.
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Europe/Paris'),
    timed('b', '2026-09-11T08:00:00Z', 'Europe/Paris'),
  ];
  assert.equal(detectTrip(events, 'Europe/Madrid', NOW), null);
});

test('a multi-day all-day block is a stay, and we do not pretend to know where', () => {
  const events = [allDay('a', '2026-09-14', '2026-09-20', { title: 'ברצלונה', location: 'Barcelona' })];
  const trip = detectTrip(events, IL, NOW);
  assert.ok(trip);
  assert.equal(trip.zone, null, 'an all-day block carries no zone — the agent asks the city');
  assert.equal(trip.evidence[0].location, 'Barcelona');
});

test('a one-day all-day event is a birthday, not a trip', () => {
  const events = [allDay('a', '2026-09-14', '2026-09-15', { title: 'יום הולדת' })];
  assert.equal(detectTrip(events, IL, NOW), null);
});

test('the past is never evidence', () => {
  const events = [
    timed('a', '2026-08-10T08:00:00Z', 'Europe/Berlin'),
    timed('b', '2026-08-11T08:00:00Z', 'Europe/Berlin'),
    allDay('c', '2026-08-01', '2026-08-09'),
  ];
  assert.equal(detectTrip(events, IL, NOW), null);
});

test('no zone for the user means no comparison to make, and never a guess', () => {
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Europe/Berlin'),
    timed('b', '2026-09-11T08:00:00Z', 'Europe/Berlin'),
  ];
  assert.equal(detectTrip(events, null, NOW), null);
  assert.equal(detectTrip([], IL, NOW), null);
  assert.equal(detectTrip(null, IL, NOW), null);
});

test('an unparseable zone is discarded, never treated as foreign', () => {
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Mars/Olympus'),
    timed('b', '2026-09-11T08:00:00Z', 'Mars/Olympus'),
  ];
  assert.equal(detectTrip(events, IL, NOW), null);
});

test('the key is stable across nights, so one trip is asked about once', () => {
  const events = [
    timed('a', '2026-09-10T08:00:00Z', 'Europe/Berlin'),
    timed('b', '2026-09-11T08:00:00Z', 'Europe/Berlin'),
  ];
  const first = detectTrip(events, IL, NOW);
  const laterTheSameWeek = detectTrip(events, IL, new Date('2026-09-06T09:00:00Z'));
  assert.equal(first.key, laterTheSameWeek.key, 'the idempotency key must not drift with the clock');
});
