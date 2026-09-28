'use strict';
// A birth date saved on the profile page that says they are under 16 files
// ONE issue for the owner and does nothing else (compliance review,
// 2026-09-28). Every "today" here is injected: a test that asks the real clock
// whether somebody is 16 yet is a test that fails on one day a year.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const users = require('../src/domain/users');
const write = require('../src/domain/user-dashboard-write');
const underAge = require('../src/domain/under-age');

let db;
const tx = (fn) => withTx(db.pool, fn);
before(async () => { db = await freshDb(); });
after(async () => { if (db) await db.teardown(); });

async function issuesFor(userId) {
  const { rows } = await db.pool.query(
    `SELECT * FROM issues WHERE title = $1 ORDER BY id`, [underAge.titleFor(userId)]);
  return rows;
}
async function userIn(phone, tz = 'Asia/Jerusalem') {
  const u = await makeUser(db.pool, phone);
  await db.pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [u.id, tz]);
  return u;
}

// ---- the pure half -----------------------------------------------------------

test('ageOn counts whole years between two calendar dates', () => {
  assert.equal(underAge.ageOn('2010-03-15', '2026-03-15'), 16, 'turning 16 today is 16');
  assert.equal(underAge.ageOn('2010-03-16', '2026-03-15'), 15, 'the day before is still 15');
  assert.equal(underAge.ageOn('2010-12-31', '2026-01-01'), 15);
  assert.equal(underAge.ageOn('1990-01-01', '2026-09-28'), 36);
  // 29 February: a year older on 1 March in a common year, the safe side.
  assert.equal(underAge.ageOn('2008-02-29', '2024-02-28'), 15);
  assert.equal(underAge.ageOn('2008-02-29', '2024-02-29'), 16);
  assert.equal(underAge.ageOn('2010-02-28', '2026-02-27'), 15);
  assert.equal(underAge.ageOn('not a date', '2026-01-01'), null);
  assert.equal(underAge.ageOn(null, '2026-01-01'), null);
});

test('isUnderAge: turning 16 today is not under; the day before is', () => {
  assert.equal(underAge.isUnderAge('2010-03-15', '2026-03-15'), false);
  assert.equal(underAge.isUnderAge('2010-03-16', '2026-03-15'), true);
  assert.equal(underAge.isUnderAge('garbage', '2026-03-15'), false, 'unreadable is never flagged');
});

test('today is read in THEIR zone, not the server\'s', () => {
  // 22:30 UTC on 14 March is already 00:30 on 15 March in Jerusalem (UTC+2)
  // and still 14 March in New York.
  const now = new Date('2026-03-14T22:30:00Z');
  assert.equal(underAge.localToday(now, 'Asia/Jerusalem'), '2026-03-15');
  assert.equal(underAge.localToday(now, 'America/New_York'), '2026-03-14');
  assert.equal(underAge.localToday(now, 'Not/AZone'), '2026-03-15', 'a bad zone falls back, never throws');
});

test('the title is deterministic and carries no birth date', () => {
  assert.equal(underAge.titleFor(42), 'Under-16 birth date saved: user 42');
  assert.equal(underAge.titleFor(42), underAge.titleFor(42));
});

// ---- through users.setPersonal, the one writer --------------------------------

test('the boundary, through the real write: 16 today files nothing, 15 files one', async () => {
  const now = new Date('2026-03-15T12:00:00Z');
  const sixteen = await userIn('+972531960001');
  const fifteen = await userIn('+972531960002');
  assert.equal((await tx((c) => users.setPersonal(c, sixteen.id, { birthDate: '2010-03-15' }, now))).ok, true);
  assert.equal((await tx((c) => users.setPersonal(c, fifteen.id, { birthDate: '2010-03-16' }, now))).ok, true);
  assert.equal((await issuesFor(sixteen.id)).length, 0);
  const rows = await issuesFor(fifteen.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'edge_case');
  assert.equal(rows[0].source, 'agent_detected');
  assert.equal(rows[0].status, 'new');
  assert.equal(Number(rows[0].related_entity_id), fifteen.id);
  assert.doesNotMatch(rows[0].title, /2010/);
  assert.doesNotMatch(rows[0].detail, /2010-03-16/, 'the date itself is not copied into the issue');
  assert.equal(JSON.parse(rows[0].detail).age, 15);
  assert.equal(JSON.parse(rows[0].detail).under13, false);
});

test('the same save judged in two zones at the same instant', async () => {
  // 22:30 UTC on 14 March: their 16th birthday has begun in Jerusalem and not
  // yet in New York.
  const now = new Date('2026-03-14T22:30:00Z');
  const il = await userIn('+972531960003', 'Asia/Jerusalem');
  const ny = await userIn('+972531960004', 'America/New_York');
  await tx((c) => users.setPersonal(c, il.id, { birthDate: '2010-03-15' }, now));
  await tx((c) => users.setPersonal(c, ny.id, { birthDate: '2010-03-15' }, now));
  assert.equal((await issuesFor(il.id)).length, 0);
  assert.equal((await issuesFor(ny.id)).length, 1);
});

test('one open row per person; a save after the owner closed it files again', async () => {
  const now = new Date('2026-06-01T09:00:00Z');
  const u = await userIn('+972531960005');
  await tx((c) => users.setPersonal(c, u.id, { birthDate: '2015-01-01' }, now));
  await tx((c) => users.setPersonal(c, u.id, { birthDate: '2015-01-02' }, now));
  await tx((c) => users.setPersonal(c, u.id, { gender: 'female' }, now));
  let rows = await issuesFor(u.id);
  assert.equal(rows.length, 1, 'three saves, one open issue');
  assert.equal(JSON.parse(rows[0].detail).under13, true);
  await db.pool.query(`UPDATE issues SET status = 'wontfix' WHERE id = $1`, [rows[0].id]);
  await tx((c) => users.setPersonal(c, u.id, { birthDate: '2015-01-01' }, now));
  rows = await issuesFor(u.id);
  assert.equal(rows.length, 2, 'a new save after closing is a new fact');
});

test('an adult, a cleared date, and the eval user file nothing', async () => {
  const now = new Date('2026-06-01T09:00:00Z');
  const adult = await userIn('+972531960006');
  await tx((c) => users.setPersonal(c, adult.id, { birthDate: '1990-06-02' }, now));
  await tx((c) => users.setPersonal(c, adult.id, { birthDate: null }, now));
  assert.equal((await issuesFor(adult.id)).length, 0);
  const evalUser = await userIn('+972531960007');
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [evalUser.id]);
  assert.equal((await tx((c) => users.setPersonal(c, evalUser.id, { birthDate: '2015-01-01' }, now))).ok, true);
  assert.equal((await issuesFor(evalUser.id)).length, 0);
});

test('flagging touches nothing about the person: no pause, no message, the date is kept', async () => {
  const now = new Date('2026-06-01T09:00:00Z');
  const u = await userIn('+972531960008');
  const before = (await db.pool.query(`SELECT status, paused_at FROM users WHERE id = $1`, [u.id])).rows[0];
  const outboxBefore = (await db.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id])).rows[0].n;
  const r = await tx((c) => users.setPersonal(c, u.id, { birthDate: '2014-05-05' }, now));
  assert.equal(r.ok, true);
  assert.equal(r.data.birthDate, '2014-05-05');
  const after = (await db.pool.query(`SELECT status, paused_at FROM users WHERE id = $1`, [u.id])).rows[0];
  assert.deepEqual(after, before);
  const outboxAfter = (await db.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id])).rows[0].n;
  assert.equal(outboxAfter, outboxBefore);
  assert.equal((await issuesFor(u.id)).length, 1);
});

// ---- the dashboard door --------------------------------------------------------

test('the profile page\'s save goes through the same check', async () => {
  // No clock can be injected through /me/act, so the date is one nobody could
  // be 16 on, whatever the day or zone the suite runs in: 1 January five
  // calendar years back is a four- or five-year-old.
  const u = await userIn('+972531960009');
  const year = new Date().getUTCFullYear() - 5;
  const r = await tx((c) => write.perform(c, u.id, 'setPersonal', { birthDate: `${year}-01-01` }));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal((await issuesFor(u.id)).length, 1);
});
