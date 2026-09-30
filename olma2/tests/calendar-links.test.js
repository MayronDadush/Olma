'use strict';
// A WhatsApp reminder hung on an event already on the person's calendar
// (domain/calendar-links.js) — nothing copied, and the reminder follows the
// event. Founding case: מירון's monthly "העברות + סיבוב bit", saved as a
// one-off task that archived itself after the first month (2026-09-30).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const links = require('../src/domain/calendar-links');
const tasksDomain = require('../src/domain/tasks');
const sweeps = require('../src/jobs/sweeps');
const listBlock = require('../src/domain/list-block');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const withClient = async (fn) => {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

// Every moment is fixed and in the future relative to an injected `now`, so
// nothing here depends on the hour or the weekday the suite runs.
const NOW = new Date('2027-01-10T10:00:00Z');
const ev = (id, start, end, extra = {}) => ({
  id, title: extra.title || 'פגישה עם דני', start, end, location: null,
  allDay: false, timeZone: 'Asia/Jerusalem', recurringEventId: null, isSeries: false, ...extra,
});

// A stand-in Google calendar: a map of events and, per series, its instances.
function fakeGoogle() {
  const events = new Map();
  const series = new Map();
  const reads = [];
  return {
    events, series, reads, failing: false,
    getEvent: async function getEvent(client, userId, id) {
      reads.push(id);
      if (this.failing) return { ok: false, error: { code: 'conflict', message: 'google down' } };
      const e = events.get(id);
      return { ok: true, data: e ? { gone: false, event: e } : { gone: true, id } };
    },
    nextInstance: async function nextInstance(client, userId, seriesId, { after }) {
      if (this.failing) return { ok: false, error: { code: 'conflict', message: 'google down' } };
      const list = series.get(seriesId) || [];
      const next = list.find((i) => new Date(i.end) > new Date(after)) || null;
      return { ok: true, data: next ? { next } : { next: null, seriesGone: true } };
    },
  };
}

function deps(g) {
  return { getEvent: g.getEvent.bind(g), nextInstance: g.nextInstance.bind(g) };
}

async function connectedUser(phone, access = 'read_only') {
  const u = await makeUser(db.pool, phone, { timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', $2)`, [u.id, access]);
  return u;
}

const pending = async (c, taskId) => (await c.query(
  `SELECT * FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
    ORDER BY remind_at`, [taskId])).rows;
const openRows = async (c, userId) => (await c.query(
  `SELECT * FROM tasks WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL ORDER BY id`,
  [userId])).rows;

test('a one-off event gets a reminder and ONE row that stands for it — nothing is copied', async () => {
  const u = await connectedUser('+972500001001');
  const g = fakeGoogle();
  g.events.set('e1', ev('e1', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const res = await links.linkEvent(c, u.id, { eventId: 'e1', now: NOW }, deps(g));
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.data.adopted, false);
    assert.equal(res.data.linked.followsSeries, false);
    const t = res.data.task;
    assert.equal(t.kind, 'event');
    assert.equal(t.source, 'calendar');
    assert.equal(t.linked_event_id, 'e1');
    assert.equal(t.calendar_event_id, null, 'a link is never a copy');
    const r = await pending(c, t.id);
    assert.equal(r.length, 1);
    assert.equal(r[0].auto, true);
    assert.equal(new Date(r[0].remind_at).toISOString(), '2027-01-14T15:00:00.000Z', 'an hour before');
    assert.ok(res.data.remindersAt.length === 1);
  });
});

test('the same thing already on Olma\'s list is ADOPTED, not joined by a second row', async () => {
  const u = await connectedUser('+972500001002');
  const g = fakeGoogle();
  g.events.set('e2', ev('e2', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00', { title: 'רופא שיניים' }));
  await withClient(async (c) => {
    const saved = (await tasksDomain.addTask(c, u.id, { title: 'רופא שיניים', dueAt: '2027-01-14T09:00:00+02:00' })).data.task;
    const res = await links.linkEvent(c, u.id, { eventId: 'e2', now: NOW }, deps(g));
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.data.adopted, true);
    assert.equal(Number(res.data.task.id), Number(saved.id));
    const rows = await openRows(c, u.id);
    assert.equal(rows.length, 1, 'one entry, not two');
    assert.equal(new Date(rows[0].due_at).toISOString(), '2027-01-14T16:00:00.000Z', 'the event\'s time wins');
    // The reminder for the old 09:00 went; one for the real hour replaced it.
    const r = await pending(c, saved.id);
    assert.equal(r.length, 1);
    assert.equal(new Date(r[0].remind_at).toISOString(), '2027-01-14T15:00:00.000Z');
  });
});

test('a task on ANOTHER day is not adopted — same words, different thing', async () => {
  const u = await connectedUser('+972500001003');
  const g = fakeGoogle();
  g.events.set('e3', ev('e3', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00', { title: 'אימון' }));
  await withClient(async (c) => {
    await tasksDomain.addTask(c, u.id, { title: 'אימון', dueAt: '2027-01-12T18:00:00+02:00' });
    const res = await links.linkEvent(c, u.id, { eventId: 'e3', now: NOW }, deps(g));
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.data.adopted, false);
  });
});

test('linking the same event twice changes the reminder and never adds a row', async () => {
  const u = await connectedUser('+972500001004');
  const g = fakeGoogle();
  g.events.set('e4', ev('e4', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    await links.linkEvent(c, u.id, { eventId: 'e4', now: NOW }, deps(g));
    const again = await links.linkEvent(c, u.id,
      { eventId: 'e4', remindAt: '2027-01-14T09:00:00+02:00', now: NOW }, deps(g));
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(again.data.alreadyLinked, true);
    assert.equal((await openRows(c, u.id)).length, 1);
    const r = await pending(c, again.data.task.id);
    assert.deepEqual(r.map((x) => [new Date(x.remind_at).toISOString(), x.auto]),
      [['2027-01-14T07:00:00.000Z', false]], 'the named hour replaced the automatic one on the same day');
    assert.equal(again.data.task.linked_lead_minutes, 540);
  });
});

test('a monthly event is reminded EVERY month: the sweep advances it to the next one', async () => {
  const u = await connectedUser('+972500001005');
  const g = fakeGoogle();
  const jan = ev('s1_20270116', '2027-01-16', '2027-01-17',
    { title: 'העברות + סיבוב bit', allDay: true, recurringEventId: 's1' });
  const feb = ev('s1_20270216', '2027-02-16', '2027-02-17',
    { title: 'העברות + סיבוב bit', allDay: true, recurringEventId: 's1' });
  g.events.set(jan.id, jan);
  g.events.set(feb.id, feb);
  g.series.set('s1', [jan, feb]);
  await withClient(async (c) => {
    // 20:00 on the day, as מירון asked: twenty hours AFTER the all-day start.
    const res = await links.linkEvent(c, u.id,
      { eventId: jan.id, remindAt: '2027-01-16T20:00:00+02:00', now: NOW }, deps(g));
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.data.linked.followsSeries, true);
    const t = res.data.task;
    assert.equal(t.linked_series_id, 's1');
    assert.equal(t.linked_lead_minutes, -1200);
    assert.equal(new Date(t.due_at).toISOString(), '2027-01-15T22:00:00.000Z', 'local midnight');

    // A day after January's has ended, the row moves to February, reminder and all.
    const later = new Date('2027-01-17T12:00:00Z');
    const out = await links.sweepCalendarLinks(c, { now: later, ...deps(g) });
    assert.ok(out.advanced.includes(Number(t.id)), JSON.stringify(out));
    const row = (await c.query('SELECT * FROM tasks WHERE id = $1', [t.id])).rows[0];
    assert.equal(row.linked_event_id, feb.id);
    assert.equal(row.archived_at, null);
    assert.equal(new Date(row.due_at).toISOString(), '2027-02-15T22:00:00.000Z');
    const r = await pending(c, t.id);
    assert.ok(r.some((x) => new Date(x.remind_at).toISOString() === '2027-02-16T18:00:00.000Z' && !x.auto),
      `20:00 on the 16th of February, got ${JSON.stringify(r.map((x) => x.remind_at))}`);
  });
});

test('only_this_one links a single occurrence of a series', async () => {
  const u = await connectedUser('+972500001006');
  const g = fakeGoogle();
  const one = ev('s2_1', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00', { recurringEventId: 's2' });
  g.events.set(one.id, one);
  await withClient(async (c) => {
    const res = await links.linkEvent(c, u.id, { eventId: one.id, onlyThisOne: true, now: NOW }, deps(g));
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.data.task.linked_series_id, null);
    assert.equal(res.data.linked.followsSeries, false);
  });
});

test('an event moved on the phone moves the row and the hour they named, by the same lead', async () => {
  const u = await connectedUser('+972500001007');
  const g = fakeGoogle();
  g.events.set('e7', ev('e7', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const res = await links.linkEvent(c, u.id,
      { eventId: 'e7', remindAt: '2027-01-14T17:30:00+02:00', now: NOW }, deps(g));
    const t = res.data.task;
    g.events.set('e7', ev('e7', '2027-01-15T12:00:00+02:00', '2027-01-15T13:00:00+02:00', { title: 'דני — הוזז' }));
    const out = await links.sweepCalendarLinks(c, { now: new Date(NOW.getTime() + 61 * 60_000), ...deps(g) });
    assert.ok(out.followed.includes(Number(t.id)), JSON.stringify(out));
    const row = (await c.query('SELECT * FROM tasks WHERE id = $1', [t.id])).rows[0];
    assert.equal(row.title, 'דני — הוזז');
    assert.equal(new Date(row.due_at).toISOString(), '2027-01-15T10:00:00.000Z');
    const r = await pending(c, t.id);
    assert.deepEqual(r.map((x) => new Date(x.remind_at).toISOString()), ['2027-01-15T09:30:00.000Z']);
  });
});

test('an unchanged event is left alone, and not read again within the hour', async () => {
  const u = await connectedUser('+972500001008');
  const g = fakeGoogle();
  g.events.set('e8', ev('e8', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const t = (await links.linkEvent(c, u.id, { eventId: 'e8', now: NOW }, deps(g))).data.task;
    g.reads.length = 0;
    const soon = new Date(NOW.getTime() + 20 * 60_000);
    await links.sweepCalendarLinks(c, { now: soon, ...deps(g) });
    assert.ok(!g.reads.includes('e8'), 'checked at link time; not due again yet');
    const hourLater = new Date(NOW.getTime() + 61 * 60_000);
    const out = await links.sweepCalendarLinks(c, { now: hourLater, ...deps(g) });
    assert.ok(g.reads.includes('e8'));
    assert.ok(!out.followed.includes(Number(t.id)), JSON.stringify(out));
    assert.ok(!out.retired.includes(Number(t.id)));
  });
});

test('an event deleted from the calendar retires the row QUIETLY, reminders and all', async () => {
  const u = await connectedUser('+972500001009');
  const g = fakeGoogle();
  g.events.set('e9', ev('e9', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const t = (await links.linkEvent(c, u.id, { eventId: 'e9', now: NOW }, deps(g))).data.task;
    g.events.delete('e9');
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    const out = await links.sweepCalendarLinks(c, { now: later, ...deps(g) });
    assert.ok(out.retired.includes(Number(t.id)), JSON.stringify(out));
    assert.equal((await openRows(c, u.id)).length, 0);
    assert.equal((await pending(c, t.id)).length, 0);
    const { rows } = await c.query('SELECT kind FROM outbox WHERE user_id = $1', [u.id]);
    assert.ok(!rows.some((r) => r.kind === 'tasks_auto_archived'), 'nothing is said about it');
  });
});

test('a read that FAILED is never "deleted" — the row waits for the next check', async () => {
  const u = await connectedUser('+972500001010');
  const g = fakeGoogle();
  g.events.set('e10', ev('e10', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const t = (await links.linkEvent(c, u.id, { eventId: 'e10', now: NOW }, deps(g))).data.task;
    g.failing = true;
    const later = new Date(NOW.getTime() + 2 * 3600_000);
    const out = await links.sweepCalendarLinks(c, { now: later, ...deps(g) });
    assert.ok(out.unread.includes(Number(t.id)), JSON.stringify(out));
    assert.equal((await openRows(c, u.id)).length, 1);
    assert.equal((await pending(c, t.id)).length, 1);
  });
});

test('a passed or gone event is refused at link time, by name', async () => {
  const u = await connectedUser('+972500001011');
  const g = fakeGoogle();
  g.events.set('old', ev('old', '2027-01-01T18:00:00+02:00', '2027-01-01T19:00:00+02:00'));
  await withClient(async (c) => {
    const passed = await links.linkEvent(c, u.id, { eventId: 'old', now: NOW }, deps(g));
    assert.equal(passed.ok, false);
    assert.equal(passed.error.reason, 'passed');
    const gone = await links.linkEvent(c, u.id, { eventId: 'nope', now: NOW }, deps(g));
    assert.equal(gone.ok, false);
    assert.equal(gone.error.code, 'not_found');
  });
});

test('the finished-events sweep leaves a linked row to the calendar sweep', async () => {
  const u = await connectedUser('+972500001012');
  const g = fakeGoogle();
  g.events.set('e12', ev('e12', '2027-01-14T18:00:00+02:00', '2027-01-14T19:00:00+02:00'));
  await withClient(async (c) => {
    const t = (await links.linkEvent(c, u.id, { eventId: 'e12', now: NOW }, deps(g))).data.task;
    await sweeps.sweepFinishedTasks(c, '2027-01-20T12:00:00Z');
    const row = (await c.query('SELECT archived_at FROM tasks WHERE id = $1', [t.id])).rows[0];
    assert.equal(row.archived_at, null);
    // …but only while the calendar can still be read.
    await c.query(`UPDATE integrations SET status = 'disconnected' WHERE user_id = $1`, [u.id]);
    await sweeps.sweepFinishedTasks(c, '2027-01-20T12:00:00Z');
    const after = (await c.query('SELECT archived_at FROM tasks WHERE id = $1', [t.id])).rows[0];
    assert.notEqual(after.archived_at, null);
  });
});

test('a calendar list marks the events Olma will remind them of with 🔔', () => {
  const block = listBlock.renderCalendarListBlock({
    events: [
      { id: 'a', title: 'אחד', start: '2027-01-14T18:00:00+02:00', end: '2027-01-14T19:00:00+02:00', reminded: true },
      { id: 'b', title: 'שניים', start: '2027-01-15T18:00:00+02:00', end: '2027-01-15T19:00:00+02:00' },
    ],
  }, { locale: 'he', timezone: 'Asia/Jerusalem', channelType: 'whatsapp' });
  assert.match(block, /אחד[^\n]*🔔/);
  assert.doesNotMatch(block, /שניים[^\n]*🔔/);
});
