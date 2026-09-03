'use strict';
// Correcting a guessed timezone must also correct what was written under it —
// and must NOT touch anything that was written correctly. Both halves are
// load-bearing; the second is why this is gated on the old zone having been a
// guess rather than running on every zone change.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const users = require('../src/domain/users');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const { shiftInstant } = require('../src/domain/timezone-repair');
const { partsInZone, instantInZone } = require('../src/domain/datetime');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

let seq = 0;
// A user carrying a zone nobody confirmed — the state 9 of 10 live users were
// in when this was written.
async function guessedUser(tz) {
  seq += 1;
  return makeUser(db.pool, `+1516000${String(1000 + seq).slice(-4)}`, { timezone: tz });
}

// The wall clock a stored instant shows in a zone, as "YYYY-MM-DD HH:MM".
function wallClock(instant, tz) {
  const p = partsInZone(tz, instant instanceof Date ? instant : new Date(instant));
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}`;
}

// An instant whose wall clock in `tz` is exactly these local parts.
function localTime(tz, y, m, d, hh, mi = 0) {
  return instantInZone(tz, { y, m, d, hh, mi, ss: 0 });
}

function futureYear() {
  return new Date().getUTCFullYear() + 1;   // every fixture must stay in the future
}

test('shiftInstant preserves the wall clock, not the offset', () => {
  const noonNY = localTime('America/New_York', 2027, 6, 15, 12, 0);
  const moved = shiftInstant(noonNY, 'America/New_York', 'America/Los_Angeles');
  assert.equal(wallClock(moved, 'America/Los_Angeles'), '2027-06-15 12:00');
  assert.equal(moved.getTime() - noonNY.getTime(), 3 * 3600 * 1000);
});

test('Sarah: a task saved under a guessed zone is corrected to the hour she said', async () => {
  const u = await guessedUser('America/New_York');
  const y = futureYear();
  // She said "noon". The model read her stored zone and wrote noon-in-New-York,
  // which is 09:00 where she actually is.
  const asStored = localTime('America/New_York', y, 9, 8, 12, 0);
  assert.equal(wallClock(asStored, 'America/Los_Angeles'), `${y}-09-08 09:00`);

  const res = await withClient(async (c) => {
    const t = await tasks.addTask(c, u.id, { title: 'nails', dueAt: asStored });
    assert.ok(t.ok);
    await reminders.setReminder(c, u.id, t.data.task.id, localTime('America/New_York', y, 9, 8, 11, 0), null);
    return users.setTimezone(c, u.id, 'America/Los_Angeles', true);
  });

  assert.ok(res.ok);
  assert.equal(res.data.previousTimezone, 'America/New_York');
  assert.equal(res.data.movedTasks.length, 1);
  assert.equal(res.data.movedReminders.length, 1);

  const { rows } = await db.pool.query(
    `SELECT t.due_at, r.remind_at FROM tasks t
       JOIN task_reminders r ON r.task_id = t.id WHERE t.owner_id = $1`, [u.id]);
  assert.equal(wallClock(rows[0].due_at, 'America/Los_Angeles'), `${y}-09-08 12:00`);
  assert.equal(wallClock(rows[0].remind_at, 'America/Los_Angeles'), `${y}-09-08 11:00`);
});

test('a zone the person CONFIRMED is never repaired — that is travel, not a correction', async () => {
  const u = await guessedUser('Asia/Jerusalem');
  const y = futureYear();
  const at = localTime('Asia/Jerusalem', y, 6, 10, 15, 0);

  const res = await withClient(async (c) => {
    // They confirm Jerusalem first. Everything after this is written correctly.
    await users.setTimezone(c, u.id, 'Asia/Jerusalem', true);
    const t = await tasks.addTask(c, u.id, { title: 'meeting', dueAt: at });
    assert.ok(t.ok);
    // Then they travel and say they are in Berlin.
    return users.setTimezone(c, u.id, 'Europe/Berlin', true);
  });

  assert.ok(res.ok);
  assert.deepEqual(res.data.movedTasks, []);
  const { rows } = await db.pool.query(`SELECT due_at FROM tasks WHERE owner_id = $1`, [u.id]);
  assert.equal(rows[0].due_at.getTime(), at.getTime(), 'a correct instant must survive a move');
});

test('each row gets the offset in force at its own moment, not one global delta', async () => {
  // Southern hemisphere: London→Sydney is 11h apart in January and 9h in July.
  // Both rows still have to come out reading 08:00 local.
  const u = await guessedUser('Europe/London');
  const y = futureYear();
  const jan = localTime('Europe/London', y + 1, 1, 15, 8, 0);
  const jul = localTime('Europe/London', y + 1, 7, 15, 8, 0);

  const res = await withClient(async (c) => {
    for (const [title, at] of [['jan', jan], ['jul', jul]]) {
      assert.ok((await tasks.addTask(c, u.id, { title, dueAt: at })).ok);
    }
    return users.setTimezone(c, u.id, 'Australia/Sydney', true);
  });
  assert.equal(res.data.movedTasks.length, 2);

  const { rows } = await db.pool.query(
    `SELECT title, due_at FROM tasks WHERE owner_id = $1 ORDER BY title`, [u.id]);
  const byTitle = Object.fromEntries(rows.map((r) => [r.title, r.due_at]));
  assert.equal(wallClock(byTitle.jan, 'Australia/Sydney'), `${y + 1}-01-15 08:00`);
  assert.equal(wallClock(byTitle.jul, 'Australia/Sydney'), `${y + 1}-07-15 08:00`);
  // ...and the two shifts really were different sizes, or this proves nothing.
  // (Negative: Sydney is ahead, so the same wall clock is an earlier instant.)
  const janShift = byTitle.jan.getTime() - jan.getTime();
  const julShift = byTitle.jul.getTime() - jul.getTime();
  assert.notEqual(janShift, julShift);
  assert.equal(janShift, -11 * 3600 * 1000);
  assert.equal(julShift, -9 * 3600 * 1000);
});

test('the past is left alone — a reminder that already fired cannot un-fire', async () => {
  const u = await guessedUser('America/New_York');
  const past = new Date(Date.now() - 48 * 3600 * 1000);

  const res = await withClient(async (c) => {
    const t = await tasks.addTask(c, u.id, { title: 'brunch', dueAt: past });
    assert.ok(t.ok);
    await c.query(
      `INSERT INTO task_reminders (task_id, remind_at) VALUES ($1, $2)`, [t.data.task.id, past]);
    return users.setTimezone(c, u.id, 'America/Los_Angeles', true);
  });

  assert.deepEqual(res.data.movedTasks, []);
  assert.deepEqual(res.data.movedReminders, []);
  const { rows } = await db.pool.query(
    `SELECT due_at FROM tasks WHERE owner_id = $1`, [u.id]);
  assert.equal(rows[0].due_at.getTime(), past.getTime());
});

test('a reminder mid-escalation is not shifted — its rung is an interval, not a wall clock', async () => {
  const u = await guessedUser('America/New_York');
  const y = futureYear();
  const at = localTime('America/New_York', y, 5, 5, 9, 0);

  const res = await withClient(async (c) => {
    const t = await tasks.addTask(c, u.id, { title: 'rent', dueAt: at });
    const r = await c.query(
      `INSERT INTO task_reminders (task_id, remind_at, attempts) VALUES ($1, $2, 1) RETURNING id`,
      [t.data.task.id, at]);
    assert.ok(r.rows[0].id);
    return users.setTimezone(c, u.id, 'America/Los_Angeles', true);
  });

  assert.equal(res.data.movedTasks.length, 1, 'the task itself still moves');
  assert.deepEqual(res.data.movedReminders, []);
  const { rows } = await db.pool.query(
    `SELECT remind_at FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1`, [u.id]);
  assert.equal(rows[0].remind_at.getTime(), at.getTime());
});

test('a meeting is reported, never moved — the other person agreed to that instant', async () => {
  const her = await guessedUser('America/New_York');
  const him = await makeUser(db.pool, '+972509000077', { timezone: 'Asia/Jerusalem' });
  const y = futureYear();
  const startsAt = localTime('America/New_York', y, 4, 9, 14, 0);

  const meetingId = await withClient(async (c) => {
    const req = await connections.requestConnection(c, her.id, him.phone, {});
    assert.ok(req.ok, JSON.stringify(req.error || {}));
    const conn = (await connections.respondToConnection(
      c, him.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, her.id, conn.id, 'meetings');
    await grants.grantFeature(c, him.id, conn.id, 'meetings');
    const m = await meetings.startMeeting(c, her.id, 'lunch', [him.id]);
    assert.ok(m.ok, JSON.stringify(m.error || {}));
    // No weekday in the slot text: domain/datetime.weekdayClash cross-checks
    // one against the instant, and this fixture's date is arbitrary.
    const p = await meetings.proposeSlot(c, her.id, m.data.meeting.id, 'lunch, 14:00', startsAt);
    assert.ok(p.ok, JSON.stringify(p.error || {}));
    return m.data.meeting.id;
  });

  const res = await withClient((c) => users.setTimezone(c, her.id, 'America/Los_Angeles', true));
  assert.equal(res.data.meetingsToRecheck.length, 1);
  assert.equal(res.data.meetingsToRecheck[0].id, meetingId);

  const { rows } = await db.pool.query(
    `SELECT proposed_start_at FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(rows[0].proposed_start_at.getTime(), startsAt.getTime(),
    'shifting this would silently move the meeting for the other participant');
});

test('setting the same zone again changes nothing and reports nothing', async () => {
  const u = await guessedUser('Asia/Jerusalem');
  const y = futureYear();
  const at = localTime('Asia/Jerusalem', y, 3, 3, 10, 0);
  const res = await withClient(async (c) => {
    assert.ok((await tasks.addTask(c, u.id, { title: 'x', dueAt: at })).ok);
    return users.setTimezone(c, u.id, 'Asia/Jerusalem', true);
  });
  assert.deepEqual(res.data.movedTasks, []);
  const { rows } = await db.pool.query(`SELECT due_at FROM tasks WHERE owner_id = $1`, [u.id]);
  assert.equal(rows[0].due_at.getTime(), at.getTime());
});

test('a repair that moved something leaves an audit row naming both zones', async () => {
  const u = await guessedUser('America/New_York');
  const y = futureYear();
  await withClient(async (c) => {
    assert.ok((await tasks.addTask(c, u.id, {
      title: 'audited', dueAt: localTime('America/New_York', y, 8, 8, 8, 0),
    })).ok);
    return users.setTimezone(c, u.id, 'America/Los_Angeles', true);
  });
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.timezone_repaired'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.fromTz, 'America/New_York');
  assert.equal(rows[0].detail.toTz, 'America/Los_Angeles');
  assert.equal(rows[0].detail.tasks.length, 1);
});

test('a user who had no zone at all is not repaired — there is no old wall clock to read', async () => {
  const u = await guessedUser(null);
  const y = futureYear();
  const at = localTime('UTC', y, 2, 2, 10, 0);
  const res = await withClient(async (c) => {
    assert.ok((await tasks.addTask(c, u.id, { title: 'no-zone', dueAt: at })).ok);
    return users.setTimezone(c, u.id, 'Asia/Jerusalem', true);
  });
  assert.ok(res.ok);
  assert.deepEqual(res.data.movedTasks, []);
  const { rows } = await db.pool.query(`SELECT due_at FROM tasks WHERE owner_id = $1`, [u.id]);
  assert.equal(rows[0].due_at.getTime(), at.getTime());
});
