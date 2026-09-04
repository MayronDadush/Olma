'use strict';
// The calendar half of /me. Google is stubbed here on purpose: what is being
// pinned is the bucketing — which day an event lands on, in whose zone — and
// that a calendar we cannot see is never reported as an empty one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const events = require('../src/domain/user-dashboard-events');

let db, me;
const tx = (fn) => withTx(db.pool, fn);

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531930001', { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [me.id]);
});
after(async () => { if (db) await db.teardown(); });

// A stub that answers with exactly the projection calendar.listEvents makes.
const google = (items) => async () => ({ ok: true, data: { days: 28, events: items } });
const refuses = (error) => async () => ({ ok: false, error });

// Today, in the user's zone, as the module itself computes it — so these tests
// do not go red at 23:00 Israel time, which is a whole class of failure this
// suite has been through before.
function todayInZone(zone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}
const plusDays = (isoDate, n) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

test('a timed event lands on the day it happens in THEIR zone', async () => {
  const day = plusDays(todayInZone('Asia/Jerusalem'), 2);
  const res = await tx((c) => events.loadEvents(c, me.id, {
    listEvents: google([{ id: 'a', title: 'צילומים', start: `${day}T13:00:00+03:00`, end: `${day}T14:00:00+03:00`, allDay: false, location: 'המלאכה 6' }]),
  }));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.connected, true);
  assert.deepEqual(res.data.days['2'], [
    { id: 'a', title: 'צילומים', at: '13:00', end: '14:00', allDay: false, where: 'המלאכה 6' },
  ]);
});

test('an all-day event is read as a DATE, not as midnight UTC', async () => {
  // The classic off-by-one: Google states an all-day event as "2027-03-04",
  // and parsing that as an instant puts it at 00:00Z — which is the day before
  // in every zone behind UTC and reads as the wrong day for half the world.
  const u = await makeUser(db.pool, '+972531930002');
  await db.pool.query(`UPDATE users SET timezone = 'America/Los_Angeles' WHERE id = $1`, [u.id]);
  const day = plusDays(todayInZone('America/Los_Angeles'), 5);
  const res = await tx((c) => events.loadEvents(c, u.id, {
    listEvents: google([{ id: 'b', title: 'Birthday', start: day, end: day, allDay: true, location: null }]),
  }));
  assert.equal(res.ok, true);
  assert.equal(res.data.days['5'].length, 1, 'an all-day event moved a day');
  assert.equal(res.data.days['5'][0].allDay, true);
  assert.equal(res.data.days['5'][0].at, '', 'an all-day event was given an hour it does not have');
});

test('a calendar we cannot see is not an empty calendar', async () => {
  const res = await tx((c) => events.loadEvents(c, me.id, {
    listEvents: refuses({ code: 'invalid', message: 'not connected', reason: 'not_connected' }),
  }));
  assert.equal(res.ok, true, 'a disconnected calendar broke the page instead of saying so');
  assert.equal(res.data.connected, false);
  assert.equal(res.data.reason, 'not_connected');
  assert.deepEqual(res.data.days, {});
});

test('an event outside the window is dropped, never bucketed onto today', async () => {
  const today = todayInZone('Asia/Jerusalem');
  const res = await tx((c) => events.loadEvents(c, me.id, {
    listEvents: google([
      { id: 'past', title: 'אתמול', start: `${plusDays(today, -3)}T10:00:00+03:00`, end: null, allDay: false },
      { id: 'far', title: 'בעוד שנה', start: `${plusDays(today, 400)}T10:00:00+03:00`, end: null, allDay: false },
      { id: 'junk', title: 'שבור', start: 'not-a-date', end: null, allDay: false },
    ]),
  }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.days, {}, 'something outside the window was shown as happening today');
});

test('a day sorts all-day first, then by the clock', async () => {
  const day = plusDays(todayInZone('Asia/Jerusalem'), 1);
  const res = await tx((c) => events.loadEvents(c, me.id, {
    listEvents: google([
      { id: 'pm', title: 'אחה״צ', start: `${day}T17:00:00+03:00`, end: null, allDay: false },
      { id: 'all', title: 'כל היום', start: day, end: day, allDay: true },
      { id: 'am', title: 'בוקר', start: `${day}T08:00:00+03:00`, end: null, allDay: false },
    ]),
  }));
  assert.deepEqual(res.data.days['1'].map((e) => e.id), ['all', 'am', 'pm']);
});

test('nothing about other people rides along', async () => {
  const day = plusDays(todayInZone('Asia/Jerusalem'), 1);
  const res = await tx((c) => events.loadEvents(c, me.id, {
    listEvents: google([{ id: 'c', title: 'פגישה', start: `${day}T09:00:00+03:00`, end: null, allDay: false }]),
  }));
  const keys = Object.keys(res.data.days['1'][0]).sort();
  assert.deepEqual(keys, ['allDay', 'at', 'end', 'id', 'title', 'where'],
    'a field nobody asked for reached the browser');
});

test('a blocked or unknown user gets nothing at all', async () => {
  const res = await tx((c) => events.loadEvents(c, 9_000_002, { listEvents: google([]) }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_found');
});
