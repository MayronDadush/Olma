'use strict';
// digest_times was reachable only by hand-written SQL until this tool existed,
// so nobody could actually choose when their digest arrives.
const test = require('node:test');
const assert = require('node:assert');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const digest = require('../src/domain/digest');
const sweeps = require('../src/jobs/sweeps');

test('sets times and scope, normalised and sorted', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972500000010');

  const res = await withTx(pool, (c) =>
    digest.setPreferences(c, u.id, ['20:00', '09:00', '09:00'], 'full'));
  assert.equal(res.ok, true);
  assert.equal(res.data.digestTimes, '09:00,20:00');   // sorted + deduped
  assert.equal(res.data.digestScope, 'full');
  assert.equal(res.data.enabled, true);
});

test('an empty array turns the digest off; omitting times leaves it alone', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972500000011');

  await withTx(pool, (c) => digest.setPreferences(c, u.id, ['08:00'], null));
  // scope only — times must survive
  const keep = await withTx(pool, (c) => digest.setPreferences(c, u.id, undefined, 'today'));
  assert.equal(keep.data.digestTimes, '08:00', 'omitting times must not clear them');
  assert.equal(keep.data.digestScope, 'today');

  const off = await withTx(pool, (c) => digest.setPreferences(c, u.id, [], undefined));
  assert.equal(off.data.digestTimes, null);
  assert.equal(off.data.enabled, false);
});

test('rejects bad times, too many times, and internal scopes', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972500000012');
  const bad = (times, scope) => withTx(pool, (c) => digest.setPreferences(c, u.id, times, scope));

  assert.equal((await bad(['25:00'], null)).ok, false);
  assert.equal((await bad(['9:00'], null)).ok, false);      // must be zero-padded
  assert.equal((await bad(['noon'], null)).ok, false);
  assert.equal((await bad(['01:00','02:00','03:00','04:00','05:00'], null)).ok, false);
  // block_view is assembled by turn_start; a user must not be able to select it
  assert.equal((await bad(null, 'block_view')).ok, false);
  assert.equal((await bad(undefined, undefined)).ok, false); // nothing to change
});

test('what the tool sets is what the sweep fires on', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await makeUser(pool, '+972500000013', { timezone: 'Asia/Jerusalem' });
  await withTx(pool, (c) => digest.setPreferences(c, u.id, ['09:00'], 'summary'));
  await pool.query(`UPDATE users SET onboarded_at = now() WHERE id = $1`, [u.id]);

  // 06:00Z is 09:00 in Asia/Jerusalem (UTC+3 in August)
  const fired = await withTx(pool, (c) =>
    sweeps.sweepDigests(c, new Date('2026-08-18T06:00:30Z')));
  assert.equal(fired.length, 1, 'the digest must fire at the local time the user chose');

  const quiet = await withTx(pool, (c) =>
    sweeps.sweepDigests(c, new Date('2026-08-18T12:00:00Z')));
  assert.equal(quiet.length, 0);
});
