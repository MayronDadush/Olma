'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tc = require('../src/domain/task-calendar');
const calendar = require('../src/domain/calendar');
const tasksDomain = require('../src/domain/tasks');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const withClient = async (fn) => {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

const SOON = '2027-01-15T09:00:00+02:00';

// A stand-in Google: records what it was asked to do and hands back the same
// deterministic ids the real one would.
function fakeGoogle() {
  const calls = [];
  return {
    calls,
    createEvent: async (client, userId, { title, start }) => {
      calls.push({ op: 'create', userId, title, start });
      return { ok: true, data: { eventId: calendar.eventIdFor(userId, title, start), created: true } };
    },
    deleteEvent: async (client, userId, { eventId }) => {
      calls.push({ op: 'delete', userId, eventId });
      return { ok: true, data: { deleted: true, eventId } };
    },
  };
}

async function syncingUser(phone) {
  const u = await makeUser(db.pool, phone, { timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_write')`, [u.id]);
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = TRUE WHERE id = $1`, [u.id]);
  return u;
}

test('a dated task lands on the calendar; an undated one never does', async () => {
  const u = await syncingUser('+972594000001');
  const g = fakeGoogle();
  await withClient(async (c) => {
    const dated = await tasksDomain.addTask(c, u.id, { title: 'רופא שיניים', dueAt: SOON });
    await tasksDomain.addTask(c, u.id, { title: 'לקנות חלב' });

    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.equal(out.added.length, 1);
    assert.equal(out.added[0], dated.data.task.id);
    assert.equal(g.calls.filter((x) => x.op === 'create').length, 1, 'an undated task is not an appointment');

    const { rows } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [dated.data.task.id]);
    assert.ok(rows[0].calendar_event_id);
  });
});

test('a second tick does nothing — the sweep is not a rewriter', async () => {
  const u = await syncingUser('+972594000002');
  await withClient(async (c) => {
    await tasksDomain.addTask(c, u.id, { title: 'טסט', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });
    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.equal(out.added.length, 0);
    assert.equal(g.calls.length, 0, 'a steady state costs zero Google calls');
  });
});

test('completing a task takes it off the calendar', async () => {
  const u = await syncingUser('+972594000003');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'להגיש דוח', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });

    await c.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [t.data.task.id]);
    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.deepEqual(out.removed, [t.data.task.id]);
    assert.equal(g.calls[0].op, 'delete');
    const { rows } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.equal(rows[0].calendar_event_id, null);
  });
});

test('rescheduling moves the entry rather than leaving a ghost at the old time', async () => {
  const u = await syncingUser('+972594000004');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'פגישה', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });
    const { rows: before } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);

    await c.query(`UPDATE tasks SET due_at = '2027-01-16T11:00:00+02:00' WHERE id = $1`, [t.data.task.id]);
    const g = fakeGoogle();
    await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });

    assert.deepEqual(g.calls.map((x) => x.op), ['delete', 'create'], 'old entry goes before the new one arrives');
    const { rows: after } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.notEqual(after[0].calendar_event_id, before[0].calendar_event_id);
  });
});

test('renaming a task is noticed too — the id is the fingerprint', async () => {
  const u = await syncingUser('+972594000005');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'שם ישן', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });
    await c.query(`UPDATE tasks SET title = 'שם חדש' WHERE id = $1`, [t.data.task.id]);
    const g = fakeGoogle();
    await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.deepEqual(g.calls.map((x) => x.op), ['delete', 'create']);
    assert.equal(g.calls[1].title, 'שם חדש');
  });
});

test('nobody gets their calendar written to without asking', async () => {
  const u = await makeUser(db.pool, '+972594000006', { timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_write')`, [u.id]);
  await withClient(async (c) => {
    await tasksDomain.addTask(c, u.id, { title: 'לא לסנכרן', dueAt: SOON });
    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.equal(out.added.length, 0);
    assert.equal(g.calls.length, 0, 'a connected calendar is not consent to write to it');
  });
});

test('turning it on needs edit access, and says which half is missing', async () => {
  const u = await makeUser(db.pool, '+972594000007', { timezone: 'Asia/Jerusalem' });
  await withClient(async (c) => {
    const none = await tc.setSync(c, u.id, true);
    assert.equal(none.ok, false);
    assert.match(none.error.message, /not connected/);

    await c.query(
      `INSERT INTO integrations (user_id, provider, status, access_level)
       VALUES ($1, 'google_calendar', 'connected', 'read_only')`, [u.id]);
    const ro = await tc.setSync(c, u.id, true);
    assert.equal(ro.ok, false);
    assert.equal(ro.error.reason, 'read_only');

    await c.query(`UPDATE integrations SET access_level = 'read_write' WHERE user_id = $1`, [u.id]);
    const on = await tc.setSync(c, u.id, true);
    assert.equal(on.ok, true);
  });
});

test('turning it off stops new entries and LEAVES the old ones unless asked', async () => {
  const u = await syncingUser('+972594000008');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'קיים', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });

    // "stop adding new ones" is not "delete the fortnight I have been reading"
    const off = await tc.setSync(c, u.id, false);
    assert.equal(off.ok, true);
    assert.equal(off.data.removed, 0);
    const { rows } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.ok(rows[0].calendar_event_id, 'still on their calendar, because they did not ask');
  });
});

test('turning it off WITH their answer clears them out', async () => {
  const u = await syncingUser('+972594000009');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'למחוק', dueAt: SOON });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });

    const g = fakeGoogle();
    const off = await tc.setSync(c, u.id, false, { removeExisting: true, ...g });
    assert.equal(off.ok, true);
    const { rows } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.equal(rows[0].calendar_event_id, null);
  });
});

test('one broken connection does not stop everybody else syncing', async () => {
  const a = await syncingUser('+972594000010');
  const b = await syncingUser('+972594000011');
  await withClient(async (c) => {
    await tasksDomain.addTask(c, a.id, { title: 'שלי', dueAt: SOON });
    const good = await tasksDomain.addTask(c, b.id, { title: 'שלו', dueAt: SOON });
    const out = await tc.sweepTaskCalendar(c, {
      now: '2026-09-04T00:00:00Z',
      createEvent: async (client, userId, { title, start }) => {
        if (Number(userId) === Number(a.id)) throw new Error('token revoked');
        return { ok: true, data: { eventId: calendar.eventIdFor(userId, title, start) } };
      },
      deleteEvent: async () => ({ ok: true, data: {} }),
    });
    assert.deepEqual(out.added, [good.data.task.id]);
    assert.equal(out.failed.length, 1);
  });
});

test('a task already in the past is not put on the calendar', async () => {
  const u = await syncingUser('+972594000012');
  await withClient(async (c) => {
    await tasksDomain.addTask(c, u.id, { title: 'עבר', dueAt: '2026-01-01T09:00:00+02:00' });
    // Scoped to this user on purpose: earlier tests share the database and one
    // of them deliberately leaves a task whose sync failed, which is pending
    // again here. A global count would be asserting about their rows, not ours.
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });
    const { rows } = await c.query(
      'SELECT calendar_event_id FROM tasks WHERE owner_id = $1', [u.id]);
    assert.equal(rows[0].calendar_event_id, null, 'a moment that has passed is not an appointment');
  });
});

test('the paused and the eval user are never written to', async () => {
  const p = await syncingUser('+972594000013');
  const e = await syncingUser('+972594000014');
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [p.id]);
  await db.pool.query(`UPDATE users SET is_eval = TRUE WHERE id = $1`, [e.id]);
  await withClient(async (c) => {
    await tasksDomain.addTask(c, p.id, { title: 'מושהה', dueAt: SOON });
    await tasksDomain.addTask(c, e.id, { title: 'eval', dueAt: SOON });
    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.equal(out.added.length, 0);
    assert.equal(g.calls.length, 0);
  });
});
