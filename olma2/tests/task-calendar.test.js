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
    createEvent: async (client, userId, { title, start, location }) => {
      calls.push({ op: 'create', userId, title, start, location });
      return { ok: true, data: { eventId: calendar.eventIdFor(userId, title, start), created: true } };
    },
    deleteEvent: async (client, userId, { eventId }) => {
      calls.push({ op: 'delete', userId, eventId });
      return { ok: true, data: { deleted: true, eventId } };
    },
  };
}

async function connectedUser(phone, access = 'read_write') {
  const u = await makeUser(db.pool, phone, { timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', $2)`, [u.id, access]);
  return u;
}

// A copy written before 2026-09-30, the way the old sweep left it.
async function withCopy(c, userId, title, extra = {}) {
  const t = (await tasksDomain.addTask(c, userId, { title, dueAt: SOON, ...extra })).data.task;
  const id = calendar.eventIdFor(userId, title, SOON);
  await c.query('UPDATE tasks SET calendar_event_id = $2 WHERE id = $1', [t.id, id]);
  return { task: t, eventId: id };
}

const copyOf = async (c, id) =>
  (await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [id])).rows[0].calendar_event_id;


// Copying tasks onto the calendar was retired on 2026-09-30 ("5ב"). What is
// left is taking the copies already written back down, and never adding one.

test('nothing is ever copied onto the calendar any more, whatever the old switches say', async () => {
  const u = await connectedUser('+972594000001');
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = TRUE WHERE id = $1`, [u.id]);
  const g = fakeGoogle();
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'רופא שיניים', dueAt: SOON });
    await c.query('UPDATE tasks SET calendar_opt_in = TRUE WHERE id = $1', [t.data.task.id]);
    await tc.sweepTaskCalendar(c, g);
    assert.equal(g.calls.filter((x) => x.op === 'create').length, 0, 'the sweep wrote a copy');
    assert.equal(await copyOf(c, t.data.task.id), null);
  });
});

test('a copy is taken down when the connection can edit — open or done alike', async () => {
  const u = await connectedUser('+972594000002');
  const g = fakeGoogle();
  await withClient(async (c) => {
    const open = await withCopy(c, u.id, 'פגישה');
    const done = await withCopy(c, u.id, 'דוח');
    await c.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [done.task.id]);
    const out = await tc.sweepTaskCalendar(c, g);
    assert.deepEqual(out.removed.map(String).sort(), [open.task.id, done.task.id].map(String).sort());
    assert.deepEqual(g.calls.map((x) => x.eventId).sort(), [open.eventId, done.eventId].sort());
    assert.equal(await copyOf(c, open.task.id), null);
    // and a second tick has nothing to do
    const g2 = fakeGoogle();
    await tc.sweepTaskCalendar(c, g2);
    assert.equal(g2.calls.filter((x) => x.userId === u.id).length, 0);
  });
});

test('a view-only connection is never asked to delete, and the id waits for edit access', async () => {
  const u = await connectedUser('+972594000003', 'read_only');
  const g = fakeGoogle();
  await withClient(async (c) => {
    const k = await withCopy(c, u.id, 'קריאה בלבד');
    await tc.sweepTaskCalendar(c, g);
    assert.equal(g.calls.filter((x) => x.userId === u.id).length, 0,
      'the old sweep failed on this every tick, for ever');
    assert.equal(await copyOf(c, k.task.id), k.eventId, 'the copy was lost track of');
    await c.query(`UPDATE integrations SET access_level = 'read_write' WHERE user_id = $1`, [u.id]);
    await tc.sweepTaskCalendar(c, g);
    assert.equal(await copyOf(c, k.task.id), null, 'edit access came back and the copy stayed');
  });
});

test('a copy already gone from the calendar counts as taken down', async () => {
  const u = await connectedUser('+972594000004');
  await withClient(async (c) => {
    const k = await withCopy(c, u.id, 'נמחק ביד');
    const out = await tc.sweepTaskCalendar(c, {
      deleteEvent: async () => ({ ok: false, error: { code: 'not_found', message: 'gone' } }),
    });
    assert.equal(out.removed.map(String).includes(String(k.task.id)), true);
    assert.equal(await copyOf(c, k.task.id), null);
  });
});

test('one broken connection does not stop everybody else', async () => {
  const a = await connectedUser('+972594000010');
  const b = await connectedUser('+972594000011');
  await withClient(async (c) => {
    await withCopy(c, a.id, 'שלי');
    const good = await withCopy(c, b.id, 'שלו');
    const out = await tc.sweepTaskCalendar(c, {
      deleteEvent: async (client, userId, { eventId }) => {
        if (Number(userId) === Number(a.id)) throw new Error('token revoked');
        return { ok: true, data: { deleted: true, eventId } };
      },
    });
    assert.equal(out.removed.map(String).includes(String(good.task.id)), true);
    assert.equal(out.failed.length >= 1, true);
  });
});

test('the eval user is never written to', async () => {
  const e = await connectedUser('+972594000014');
  await db.pool.query(`UPDATE users SET is_eval = TRUE WHERE id = $1`, [e.id]);
  const g = fakeGoogle();
  await withClient(async (c) => {
    await withCopy(c, e.id, 'eval');
    await tc.sweepTaskCalendar(c, g);
    assert.equal(g.calls.filter((x) => x.userId === e.id).length, 0);
  });
});

test('turning the standing switch ON is refused by name; OFF still works and may clear', async () => {
  const u = await connectedUser('+972594000008');
  await withClient(async (c) => {
    const on = await tc.setSync(c, u.id, true);
    assert.equal(on.ok, false);
    assert.equal(on.error.reason, 'retired');
    const k = await withCopy(c, u.id, 'למחוק');
    const g = fakeGoogle();
    const off = await tc.setSync(c, u.id, false, { removeExisting: true, ...g });
    assert.equal(off.ok, true);
    assert.equal(await copyOf(c, k.task.id), null);
  });
});

test('one task: ON is refused, OFF takes its copy down', async () => {
  const u = await connectedUser('+972539000103');
  await withClient(async (c) => {
    const k = await withCopy(c, u.id, 'להסיר');
    const on = await tc.setTaskSync(c, u.id, k.task.id, true, fakeGoogle());
    assert.equal(on.ok, false);
    assert.equal(on.error.reason, 'retired');
    const off = await tc.setTaskSync(c, u.id, k.task.id, false, fakeGoogle());
    assert.equal(off.ok, true, off.ok ? '' : JSON.stringify(off.error));
    assert.equal(off.data.removed, true);
    assert.equal(await copyOf(c, k.task.id), null);
  });
});

test('one person cannot switch another person\'s task', async () => {
  const mine = await connectedUser('+972539000106');
  const yours = await connectedUser('+972539000107');
  const t = await withClient((c) => tasksDomain.addTask(c, yours.id, { title: 'שלהם', dueAt: SOON }));
  const r = await withClient((c) => tc.setTaskSync(c, mine.id, t.data.task.id, false, fakeGoogle()));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});
