'use strict';
// The eval's "first rung inside a day" check, held to the quiet-day rule the
// chase itself obeys (reminders.movesOffQuietDay). Run 96 went red asked on a
// Friday evening, with a correct first rung on Sunday morning. The clock is
// injected, so nothing here depends on the day the suite runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { firstChaseInTime } = require('../src/evals/scenarios');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

let seq = 0;
async function chaseFirstAt(firstRung) {
  seq += 1;
  const u = await makeUser(db.pool, `+97254310${String(seq).padStart(4, '0')}`, { quietDays: 'sat' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  const { rows } = await db.pool.query(
    `INSERT INTO tasks (owner_id, title) VALUES ($1, 'לקחת את המצלמה לתיקון') RETURNING id`, [u.id]);
  await db.pool.query(
    `INSERT INTO task_reminders (task_id, user_id, remind_at, repeat_rule, repeat_until)
     VALUES ($1, $2, $3, 'daily', $4)`,
    [rows[0].id, u.id, firstRung, '2026-10-25T21:00:00Z']);
  return { userId: u.id };
}

// A week with no chag in it. Friday 2026-10-16 22:00 in Israel is 19:00Z.
const FRIDAY_NIGHT = new Date('2026-10-16T19:00:00Z');
const WEDNESDAY_NIGHT = new Date('2026-10-14T19:00:00Z');

test('asked on a Friday night, a first rung on Sunday morning is on time', async () => {
  const ctx = await chaseFirstAt('2026-10-18T06:00:00Z');
  assert.equal(await firstChaseInTime(db.pool, ctx, FRIDAY_NIGHT), true);
});

test('…and one on Monday is not: the quiet day buys one day, not two', async () => {
  const ctx = await chaseFirstAt('2026-10-19T06:00:00Z');
  assert.equal(await firstChaseInTime(db.pool, ctx, FRIDAY_NIGHT), false);
});

test('with no quiet day in between, two days out is still late', async () => {
  const ctx = await chaseFirstAt('2026-10-16T06:00:00Z');
  assert.equal(await firstChaseInTime(db.pool, ctx, WEDNESDAY_NIGHT), false);
  const ok = await chaseFirstAt('2026-10-15T06:00:00Z');
  assert.equal(await firstChaseInTime(db.pool, ok, WEDNESDAY_NIGHT), true);
});

test('no chase at all is red', async () => {
  const u = await makeUser(db.pool, '+972543109999');
  assert.equal(await firstChaseInTime(db.pool, { userId: u.id }, FRIDAY_NIGHT), false);
});
