'use strict';
// Miron's own ask, walking his onboarding (2026-09-04): if he goes quiet right
// after the opening message, don't make him wait for the day-one ladder's
// first rung — 15 minutes, an eternity next to how fast the silence itself
// was noticed. Ask about his name within a minute instead.
//
// Anchored on `first_turn_at` (set once, only where turn_start actually hands
// the model the opening copy — see registry.js) rather than `onboarded_at`
// (set at provisioning, which can be well before anyone has written a word).
// The silence test is `last_inbound_at = first_turn_at`: both are stamped by
// the SAME transaction in turn_start, so they can only still be equal if no
// later message has moved `last_inbound_at` on its own.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const sweeps = require('../src/jobs/sweeps');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Leaves the row exactly the shape turn_start leaves behind `seconds` after
// the opening: first_turn_at and last_inbound_at equal (nobody has replied
// since), the name column set to whatever guess (or none) the test wants.
async function openedAgo(pool, userId, seconds, { name = null, confirmed = false } = {}) {
  await pool.query(
    `UPDATE users SET
        first_turn_at = now() - ($2 || ' seconds')::interval,
        last_inbound_at = now() - ($2 || ' seconds')::interval,
        first_name = $3, name_confirmed = $4
      WHERE id = $1`,
    [userId, String(seconds), name, confirmed]);
}

const outboxFor = (pool, userId) => pool.query(
  `SELECT payload, hold_reason, expires_at FROM outbox
    WHERE user_id = $1 AND kind = 'checkin' AND payload->>'rung' = 'name_confirm_1m'`,
  [userId]);

test('fires past 60s of silence, with the WhatsApp guess in the instruction', async () => {
  const u = await makeUser(db.pool, '+972611005001', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'M&M' });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, [u.id]);
  const { rows } = await outboxFor(db.pool, u.id);
  assert.equal(rows.length, 1);
  assert.match(rows[0].payload.checkinInstruction, /"M&M"/);
  assert.match(rows[0].payload.checkinInstruction, /is that their name/i);
});

test('fires with a plain ask when there is no name guess at all', async () => {
  const u = await makeUser(db.pool, '+972611005002', { firstName: null });
  // makeUser sets firstName 'Test' unless told otherwise; clear it here to
  // model someone whose WhatsApp profile gave us nothing.
  await openedAgo(db.pool, u.id, 75, { name: null });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, [u.id]);
  const { rows } = await outboxFor(db.pool, u.id);
  assert.match(rows[0].payload.checkinInstruction, /what you should call them/i);
  assert.doesNotMatch(rows[0].payload.checkinInstruction, /is that their name/i);
});

test('does not fire before 60 seconds', async () => {
  const u = await makeUser(db.pool, '+972611005003', { firstName: null });
  await openedAgo(db.pool, u.id, 30, { name: 'Guest' });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('expires past 10 minutes — a sweep that was down does not surface a late nudge', async () => {
  const u = await makeUser(db.pool, '+972611005004', { firstName: null });
  await openedAgo(db.pool, u.id, 700, { name: 'Guest' }); // 11m40s
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a reply since the opening cancels the nudge, whatever it said', async () => {
  const u = await makeUser(db.pool, '+972611005005', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  // They wrote back — last_inbound_at moves forward, first_turn_at does not.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a name already confirmed does not get re-asked', async () => {
  const u = await makeUser(db.pool, '+972611005006', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'מירון', confirmed: true });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a paused user is not nudged', async () => {
  const u = await makeUser(db.pool, '+972611005007', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('idempotent — a second tick within the window does not double-enqueue', async () => {
  const u = await makeUser(db.pool, '+972611005008', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  await sweeps.sweepNameConfirm(db.pool);
  const second = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(second, [], 'the idempotency key already claimed this rung');
  const { rows } = await outboxFor(db.pool, u.id);
  assert.equal(rows.length, 1);
});
