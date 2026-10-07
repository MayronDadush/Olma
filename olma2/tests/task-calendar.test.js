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
    createEvent: async (client, userId, { title, start, location, allDay }) => {
      calls.push({ op: 'create', userId, title, start, location, allDay });
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
    // A to-do. An EVENT is the one exception, below.
    await tasksDomain.addTask(c, u.id, { title: 'לא לסנכרן', dueAt: SOON, kind: 'todo' });
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

// ---------------------------------------------------------------------------
// One task, its own answer (migration 029). The switch in the task sheet is
// about the row somebody is looking at, so it has to be able to disagree with
// the standing one in both directions.

test('a task opted in reaches the calendar with the standing switch off', async () => {
  const u = await syncingUser('+972539000101');
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = FALSE WHERE id = $1`, [u.id]);
  const t = await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'רופא שיניים', dueAt: SOON }));
  await db.pool.query(`UPDATE tasks SET calendar_opt_in = TRUE WHERE id = $1`, [t.data.task.id]);
  const g = fakeGoogle();
  const out = await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  assert.equal(out.added.map(String).includes(String(t.data.task.id)), true,
    'the task said yes and the standing switch answered for it');
});

test('a task opted out stays off the calendar with the standing switch on', async () => {
  const u = await syncingUser('+972539000102');
  const t = await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'לא ליומן', dueAt: SOON }));
  await db.pool.query(`UPDATE tasks SET calendar_opt_in = FALSE WHERE id = $1`, [t.data.task.id]);
  const g = fakeGoogle();
  const out = await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  assert.equal(out.added.map(String).includes(String(t.data.task.id)), false,
    'a task turned off individually came back on the next tick');
});

// ---- an event follows a calendar they let Olma write to (owner, 2026-10-01)

async function writableUser(phone, access = 'read_write', status = 'connected') {
  const u = await makeUser(db.pool, phone, { timezone: 'Asia/Jerusalem' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', $2, $3)`, [u.id, status, access]);
  return u;
}

test('an event reaches Google with the to-do switch off, when the calendar is writable', async () => {
  const u = await writableUser('+972539000201');
  const { ev, todo } = await withClient(async (c) => ({
    ev: (await tasksDomain.addTask(c, u.id, { title: 'תור לספר', dueAt: SOON, kind: 'event' })).data.task,
    todo: (await tasksDomain.addTask(c, u.id, { title: 'להתקשר לספר', dueAt: SOON, kind: 'todo' })).data.task,
  }));
  const g = fakeGoogle();
  const out = await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  const added = out.added.map(String);
  assert.equal(added.includes(String(ev.id)), true, 'the appointment goes to Google');
  assert.equal(added.includes(String(todo.id)), false, 'the to-do still waits for the switch');

  // A steady state: the next tick neither adds it again nor takes it off.
  const g2 = fakeGoogle();
  await withClient((c) => tc.sweepTaskCalendar(c, { ...g2, now: '2027-01-01T00:00:00Z' }));
  assert.equal(g2.calls.length, 0);
});

test('an event the person switched off stays off, calendar or no calendar', async () => {
  const u = await writableUser('+972539000202');
  const ev = await withClient(async (c) =>
    (await tasksDomain.addTask(c, u.id, { title: 'תור לרופא', dueAt: SOON, kind: 'event' })).data.task);
  await withClient((c) => tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2027-01-01T00:00:00Z' }));
  const off = await withClient((c) => tc.setTaskSync(c, u.id, ev.id, false, fakeGoogle()));
  assert.equal(off.data.removed, true);
  const g = fakeGoogle();
  const out = await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  assert.equal(out.added.map(String).includes(String(ev.id)), false, 'it came back on the next tick');
});

test('a read-only or broken calendar is never tried, so an event does not fail every tick', async () => {
  const ro = await writableUser('+972539000203', 'read_only');
  const broken = await writableUser('+972539000204', 'read_write', 'needs_reauth');
  const ids = await withClient(async (c) => [
    (await tasksDomain.addTask(c, ro.id, { title: 'תור לספר', dueAt: SOON, kind: 'event' })).data.task.id,
    (await tasksDomain.addTask(c, broken.id, { title: 'תור לספר', dueAt: SOON, kind: 'event' })).data.task.id,
  ]);
  const g = fakeGoogle();
  await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  assert.equal(ids.length, 2);
  const theirs = [ro.id, broken.id].map(String);
  assert.equal(g.calls.filter((x) => theirs.includes(String(x.userId))).length, 0);
});

test("the page's switch reads the same rule the sweep acts on", async () => {
  const w = await writableUser('+972539000205');
  const ro = await writableUser('+972539000206', 'read_only');
  const none = await makeUser(db.pool, '+972539000207', { timezone: 'Asia/Jerusalem' });
  await withClient(async (c) => {
    assert.equal(await tc.canWrite(c, w.id), true);
    assert.equal(await tc.canWrite(c, ro.id), false);
    assert.equal(await tc.canWrite(c, none.id), false);
  });
  const ev = { kind: 'event', calendar_opt_in: null };
  const todo = { kind: 'todo', calendar_opt_in: null };
  assert.equal(tc.wantedFor(ev, { syncTasks: false, writable: true }), true);
  assert.equal(tc.wantedFor(ev, { syncTasks: false, writable: false }), false);
  assert.equal(tc.wantedFor(todo, { syncTasks: false, writable: true }), false);
  assert.equal(tc.wantedFor(todo, { syncTasks: true, writable: false }), true);
  assert.equal(tc.wantedFor({ ...ev, calendar_opt_in: false }, { syncTasks: true, writable: true }), false);
  assert.equal(tc.wantedFor({ ...todo, calendar_opt_in: true }, { syncTasks: false, writable: false }), true);
  // A row nothing has judged is a job, as everywhere else.
  assert.equal(tc.wantedFor({ kind: null, calendar_opt_in: null }, { syncTasks: false, writable: true }), false);
});

test('a to-do with no kind, switched off, is still taken off the calendar', async () => {
  // The NULL-kind trap: `NULL = 'event'` would make the wanted question NULL,
  // and `NOT NULL` would never reach the remove arm.
  const u = await syncingUser('+972539000208');
  const t = await withClient(async (c) =>
    (await tasksDomain.addTask(c, u.id, { title: 'בלי סוג', dueAt: SOON })).data.task);
  await db.pool.query(`UPDATE tasks SET kind = NULL WHERE id = $1`, [t.id]);
  await withClient((c) => tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2027-01-01T00:00:00Z' }));
  // The task says nothing; the standing switch goes off; the calendar is
  // still writable. Only the event clause could keep it, and it is not one.
  await db.pool.query(`UPDATE users SET calendar_sync_tasks = FALSE WHERE id = $1`, [u.id]);
  const g = fakeGoogle();
  const out = await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  assert.equal(out.removed.map(String).includes(String(t.id)), true);
});

test('turning one task off removes the event it already had', async () => {
  const u = await syncingUser('+972539000103');
  const t = await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'להסיר', dueAt: SOON }));
  const g = fakeGoogle();
  await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: '2027-01-01T00:00:00Z' }));
  const before = await db.pool.query(`SELECT calendar_event_id FROM tasks WHERE id = $1`, [t.data.task.id]);
  assert.notEqual(before.rows[0].calendar_event_id, null, 'nothing was synced, so nothing is being removed');
  const off = await withClient((c) => tc.setTaskSync(c, u.id, t.data.task.id, false, g));
  assert.equal(off.ok, true, off.ok ? '' : JSON.stringify(off.error));
  assert.equal(off.data.removed, true);
  const after = await db.pool.query(`SELECT calendar_event_id FROM tasks WHERE id = $1`, [t.data.task.id]);
  assert.equal(after.rows[0].calendar_event_id, null);
});

test('turning one task on is refused without edit access, and stores nothing', async () => {
  const u = await syncingUser('+972539000104');
  await db.pool.query(
    `UPDATE integrations SET access_level = 'read_only' WHERE user_id = $1`, [u.id]);
  const t = await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'קריאה בלבד', dueAt: SOON }));
  const r = await withClient((c) => tc.setTaskSync(c, u.id, t.data.task.id, true, fakeGoogle()));
  assert.equal(r.ok, false);
  assert.equal(r.error.reason, 'read_only');
  const { rows } = await db.pool.query(`SELECT calendar_opt_in FROM tasks WHERE id = $1`, [t.data.task.id]);
  assert.equal(rows[0].calendar_opt_in, null, 'a refusal was stored as a yes');
});

test('a task with no date has no moment to put on a calendar', async () => {
  const u = await syncingUser('+972539000105');
  const t = await withClient((c) => tasksDomain.addTask(c, u.id, { title: 'בלי תאריך' }));
  const r = await withClient((c) => tc.setTaskSync(c, u.id, t.data.task.id, true, fakeGoogle()));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'invalid');
});

test('one person cannot switch another person\'s task', async () => {
  const mine = await syncingUser('+972539000106');
  const yours = await syncingUser('+972539000107');
  const t = await withClient((c) => tasksDomain.addTask(c, yours.id, { title: 'שלהם', dueAt: SOON }));
  const r = await withClient((c) => tc.setTaskSync(c, mine.id, t.data.task.id, true, fakeGoogle()));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test("an event's place goes out with it to Google", async () => {
  const u = await syncingUser('+972501000086');
  const g = fakeGoogle();
  const t = await withClient(async (c) => (await tasksDomain.addTask(c, u.id, {
    title: 'פגישה עם תמר', kind: 'event', location: 'ביהס קרית חינוך דרור', dueAt: SOON,
  })).data.task);
  await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: "2026-09-04T00:00:00Z" }));
  const created = g.calls.find((x) => x.op === 'create' && x.title === 'פגישה עם תמר');
  assert.ok(created, 'the event was written out');
  assert.equal(created.location, 'ביהס קרית חינוך דרור');
  const plain = await withClient(async (c) => (await tasksDomain.addTask(c, u.id, { title: 'לשלם חשמל', dueAt: SOON })).data.task);
  await withClient((c) => tc.sweepTaskCalendar(c, { ...g, now: "2026-09-04T00:00:00Z" }));
  const job = g.calls.find((x) => x.op === 'create' && x.title === 'לשלם חשמל');
  assert.equal(job.location, undefined, 'no place, no location field');
  assert.ok(t.id && plain.id);
});

// An appointment that HAPPENED is part of the person's calendar, not a row we
// own. The expired-events sweep archives "תור לספר" three hours after it
// passes — and until 2026-10-01 the next tick read "archived" as "take it off
// the calendar", so the haircut vanished from Google the evening it happened.
// Leaving the LIST is not leaving the calendar.
test('an appointment that passed and was archived STAYS on the calendar', async () => {
  const sweeps = require('../src/jobs/sweeps');
  const u = await syncingUser('+972594000031');
  await withClient(async (c) => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const t = await tasksDomain.addTask(c, u.id, { title: 'תור לספר', dueAt: at, kind: 'event' });
    const id = t.data.task.id;
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: new Date().toISOString() });

    // Six hours after it: past the auto-archive grace. The real sweep, not a
    // hand-written UPDATE, so the state is the one production reaches.
    const later = new Date(Date.now() + 7 * 3600_000).toISOString();
    await sweeps.sweepFinishedTasks(c, later);
    const { rows } = await c.query('SELECT status, archived_at FROM tasks WHERE id = $1', [id]);
    assert.ok(rows[0].archived_at, 'the sweep did archive it — the premise of this test');

    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: later });
    assert.deepEqual(g.calls, [], 'no Google call at all for a moment that is over');
    assert.deepEqual(out.removed, []);
  });
});

// The other side of the same line: a plan cancelled BEFORE it happens is gone
// from the calendar too, or the calendar keeps a haircut nobody is going to.
test('an appointment archived while still AHEAD is taken off the calendar', async () => {
  const u = await syncingUser('+972594000032');
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'תור לספר', dueAt: SOON, kind: 'event' });
    await tc.sweepTaskCalendar(c, { ...fakeGoogle(), now: '2026-09-04T00:00:00Z' });
    await tasksDomain.archiveTask(c, u.id, t.data.task.id);
    const g = fakeGoogle();
    const out = await tc.sweepTaskCalendar(c, { ...g, now: '2026-09-04T00:00:00Z' });
    assert.deepEqual(out.removed, [t.data.task.id]);
  });
});

// A task saved for a DAY is stored as local midnight. Written to Google as a
// timed block it became a 00:00-00:30 entry in the middle of the night, so a
// birthday looked like it had not been added (owner, 2026-10-01).
test('a day-shaped event goes to Google as an ALL-DAY entry on the right date', async () => {
  const u = await syncingUser('+972594000041');
  const g = fakeGoogle();
  await withClient(async (c) => {
    // 30 Oct 2026, local midnight in Asia/Jerusalem (UTC+2 after DST ends).
    const t = await tasksDomain.addTask(c, u.id, {
      title: 'יום הולדת לליאם', kind: 'event', dueAt: '2026-10-30T00:00:00+02:00',
    });
    await tc.sweepTaskCalendar(c, { ...g, now: '2026-10-01T00:00:00Z' });
    const made = g.calls.find((x) => x.op === 'create');
    assert.ok(made, 'the entry was written');
    assert.equal(made.allDay, true);
    assert.equal(made.start.slice(0, 10), '2026-10-30', 'the date they meant, not the UTC day before');

    // Same id as before, so the re-check sees a steady state and writes nothing.
    const again = fakeGoogle();
    await tc.sweepTaskCalendar(c, { ...again, now: '2026-10-01T00:00:00Z' });
    assert.deepEqual(again.calls, []);
    assert.ok(t.data.task.id);
  });
});

test('a stated hour stays a timed block, and a stated end beats the day', () => {
  const tz = 'Asia/Jerusalem';
  const timed = tc.windowFor('2026-10-30T07:00:00.000Z', null, tz);
  assert.equal(timed.allDay, false);
  const shift = tc.windowFor('2026-10-29T22:00:00.000Z', '2026-10-30T05:00:00.000Z', tz);
  assert.equal(shift.allDay, false, 'a task that says where it stops is not a banner');
});

// ---- a repeating event is ONE series on Google (owner, 2026-10-05) ------------
// A stand-in Google that keeps the events it holds, so "this id is taken" and
// "this series was ended" are real states rather than scripted answers.
function seriesGoogle() {
  const held = new Map();
  const calls = [];
  return {
    calls, held,
    createEvent: async (client, userId, ev) => {
      calls.push({ op: 'create', ...ev });
      if (held.has(ev.eventId)) return { ok: true, data: { alreadyExisted: true, eventId: ev.eventId } };
      held.set(ev.eventId, { id: ev.eventId, recurrence: ev.recurrence, start: ev.start });
      return { ok: true, data: { created: true, eventId: ev.eventId } };
    },
    endSeries: async (client, userId, { eventId, at }) => {
      calls.push({ op: 'end', eventId, at: new Date(at).toISOString() });
      const ev = held.get(eventId);
      if (ev) ev.recurrence = ev.recurrence.map((l) => `${l};UNTIL=cut`);
      return { ok: true, data: { ended: true, eventId } };
    },
    getEvent: async (client, userId, { eventId }) => ({ ok: true, data: { event: held.get(eventId) || null } }),
    deleteEvent: async (client, userId, { eventId }) => { calls.push({ op: 'delete', eventId }); return { ok: true, data: {} }; },
  };
}
const MON = '2030-10-14T17:30:00+03:00';
const MON_END = '2030-10-14T21:30:00+03:00';
const before14 = '2030-10-10T09:00:00Z';

test('a weekly course goes up as one series, and moving on to next week costs Google nothing', async () => {
  const u = await syncingUser('+972594000101');
  const g = seriesGoogle();
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'קורס', dueAt: MON, endsAt: MON_END, repeat: 'weekly', now: new Date(before14) });
    await tc.sweepTaskCalendar(c, { ...g, now: before14 });
    const made = g.calls.filter((x) => x.op === 'create');
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    assert.equal(made[0].timeZone, 'Asia/Jerusalem');

    // The class ends; the row moves to 21.10. Google already holds 21.10.
    await require('../src/jobs/sweeps').sweepFinishedTasks(c, '2030-10-14T19:00:00Z');
    const { rows: [row] } = await c.query('SELECT due_at, calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.equal(new Date(row.due_at).toISOString(), '2030-10-21T14:30:00.000Z');
    assert.equal(row.calendar_event_id, made[0].eventId, 'the series is kept, not re-made per class');
    g.calls.length = 0;
    await tc.sweepTaskCalendar(c, { ...g, now: '2030-10-15T09:00:00Z' });
    assert.equal(g.calls.length, 0, 'an advance is not a change');
  });
});

test('new hours split the series: the old one is cut at now, a new one starts at the next class', async () => {
  const u = await syncingUser('+972594000102');
  const g = seriesGoogle();
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'קורס', dueAt: MON, endsAt: MON_END, repeat: 'weekly', now: new Date(before14) });
    await tc.sweepTaskCalendar(c, { ...g, now: before14 });
    const first = g.calls[0].eventId;
    await tasksDomain.editTask(c, u.id, t.data.task.id, { dueAt: '2030-10-14T18:00:00+03:00', endsAt: '2030-10-14T22:00:00+03:00' });
    g.calls.length = 0;
    await tc.sweepTaskCalendar(c, { ...g, now: '2030-10-11T09:00:00Z' });
    assert.deepEqual(g.calls.map((x) => x.op), ['end', 'create']);
    assert.equal(g.calls[0].eventId, first);
    assert.equal(g.calls[0].at, '2030-10-11T09:00:00.000Z');
    assert.notEqual(g.calls[1].eventId, first);
    assert.equal(g.calls[1].start, '2030-10-14T15:00:00.000Z');

    // Moving the day re-pins the rule, and the new series says so.
    await tasksDomain.editTask(c, u.id, t.data.task.id, { dueAt: '2030-10-15T18:00:00+03:00', endsAt: '2030-10-15T22:00:00+03:00' });
    g.calls.length = 0;
    await tc.sweepTaskCalendar(c, { ...g, now: '2030-10-11T10:00:00Z' });
    assert.deepEqual(g.calls.map((x) => x.op), ['end', 'create']);
    assert.deepEqual(g.calls[1].recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU']);
  });
});

test('deleting or archiving a series ENDS it — the classes that happened stay', async () => {
  const u = await syncingUser('+972594000103');
  const g = seriesGoogle();
  await withClient(async (c) => {
    const a = await tasksDomain.addTask(c, u.id, { title: 'קורס', dueAt: MON, endsAt: MON_END, repeat: 'weekly', now: new Date(before14) });
    const b = await tasksDomain.addTask(c, u.id, { title: 'חוג', dueAt: '2030-10-16T18:00:00+03:00', repeat: 'weekly', now: new Date(before14) });
    await tc.sweepTaskCalendar(c, { ...g, now: before14 });
    g.calls.length = 0;

    const off = await tc.removeEventsFor(c, u.id, a.data.task.id, { ...g, now: '2030-10-20T09:00:00Z' });
    assert.ok(off.ok);
    assert.deepEqual(g.calls.map((x) => x.op), ['end']);
    await tasksDomain.deleteTask(c, u.id, a.data.task.id);

    await tasksDomain.archiveTask(c, u.id, b.data.task.id);
    g.calls.length = 0;
    await tc.sweepTaskCalendar(c, { ...g, now: '2030-10-11T09:00:00Z' });
    assert.deepEqual(g.calls.map((x) => x.op), ['end'], 'never a delete');
  });
});

test('a retried write adopts its own series, and never one it has already ended', async () => {
  const u = await syncingUser('+972594000104');
  const g = seriesGoogle();
  await withClient(async (c) => {
    const t = await tasksDomain.addTask(c, u.id, { title: 'קורס', dueAt: MON, endsAt: MON_END, repeat: 'weekly', now: new Date(before14) });
    const row = (await c.query('SELECT * FROM tasks WHERE id = $1', [t.data.task.id])).rows[0];
    const key = tc.seriesKey(row);
    const id0 = tc.seriesIdFor(u.id, null, key, 0);

    // Google took our first write and the answer never came back.
    g.held.set(id0, { id: id0, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    await tc.sweepTaskCalendar(c, { ...g, now: before14 });
    let { rows: [r] } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]);
    assert.equal(r.calendar_event_id, id0, 'the same series, not a second one');

    // Off and on again: the id it would choose names a series we ended.
    await tc.setTaskSync(c, u.id, t.data.task.id, false, { ...g, now: before14 });
    await c.query('UPDATE tasks SET calendar_opt_in = NULL WHERE id = $1', [t.data.task.id]);
    g.calls.length = 0;
    await tc.sweepTaskCalendar(c, { ...g, now: before14 });
    ({ rows: [r] } = await c.query('SELECT calendar_event_id FROM tasks WHERE id = $1', [t.data.task.id]));
    assert.notEqual(r.calendar_event_id, id0);
    assert.equal(r.calendar_event_id, tc.seriesIdFor(u.id, null, key, 1));
  });
});

test('every rule Google is given matches the row\'s own arithmetic', () => {
  const tz = { allDay: false, timezone: 'Asia/Jerusalem' };
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'daily' }, tz), ['RRULE:FREQ=DAILY']);
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'monthly:12' }, tz), ['RRULE:FREQ=MONTHLY;BYMONTHDAY=12']);
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'monthly:last' }, tz), ['RRULE:FREQ=MONTHLY;BYMONTHDAY=-1']);
  // The 31st in a 30-day month is the 30th, as reminders.nextOccurrence clamps it.
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'monthly:31' }, tz),
    ['RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1']);
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'weekly:TH', repeat_until: '2031-01-31T21:59:00Z' }, tz),
    ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20310131T215900Z']);
  assert.deepEqual(tc.seriesRecurrence({ repeat_rule: 'weekly:TH', repeat_until: '2031-01-31T21:59:00Z' }, { allDay: true, timezone: 'Asia/Jerusalem' }),
    ['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20310131']);
  assert.equal(tc.seriesRecurrence({ repeat_rule: 'weekly:MO,TH' }, tz), null, 'never a rule a row cannot hold');
});
