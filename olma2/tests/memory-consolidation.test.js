'use strict';
// Nothing folds the daily notes without this job, so MEMORY.md stays exactly
// as provisioning wrote it while memory/ grows forever.
const test = require('node:test');
const assert = require('node:assert');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const mem = require('../src/jobs/memory-consolidation');

const QUIET = new Date('2026-08-18T00:30:00Z').getTime();  // 03:30 Asia/Jerusalem
const DAYTIME = new Date('2026-08-18T11:00:00Z').getTime(); // 14:00 Asia/Jerusalem

async function activeUser(pool, phone) {
  const u = await makeUser(pool, phone, { timezone: 'Asia/Jerusalem' });
  await pool.query(
    `UPDATE users SET agent_id = $2, workspace_path = $3, onboarded_at = now() WHERE id = $1`,
    [u.id, `u-${u.id}`, `/tmp/ws-${u.id}`]);
  return u;
}

test('runs one silent turn per due user, in their small hours', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await activeUser(pool, '+972500000020');

  const calls = [];
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    now: QUIET,
    hasRecentNotes: () => true,
    runAgent: (a) => { calls.push(a); return { ok: true }; },
  }));

  assert.deepEqual(res.consolidated, [Number(u.id)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, `u-${u.id}`);
  assert.match(calls[0].message, /MEMORY\.md/);
  // the instruction must forbid putting contacts in prose memory
  assert.match(calls[0].message, /Never write a phone number/);
});

test('does not run during the user\'s day', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000021');
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    now: DAYTIME,
    hasRecentNotes: () => true,
    runAgent: () => { throw new Error('must not run in the middle of their day'); },
  }));
  assert.equal(res.considered, 0);
});

test('a user with no new notes costs no model turn', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000022');
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    now: QUIET,
    hasRecentNotes: () => false,
    runAgent: () => { throw new Error('must not spend a turn on an empty week'); },
  }));
  assert.equal(res.skipped, 1);
  assert.equal(res.consolidated.length, 0);
});

test('a consolidated user is not due again for a week', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000023');
  const deps = { now: QUIET, hasRecentNotes: () => true, runAgent: () => ({ ok: true }) };

  const first = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, deps));
  assert.equal(first.consolidated.length, 1);

  // The audit row is stamped by the database clock while this test drives a
  // simulated one, so the two must be lined up by hand. Without this, the "a
  // week later" step below measures the distance from REAL today instead of
  // from QUIET — which is why this test started failing on its own the moment
  // the calendar caught up, having nothing to do with the code it covers.
  await pool.query(
    `UPDATE audit_log SET created_at = to_timestamp($1 / 1000.0) WHERE event = 'memory.consolidated'`,
    [QUIET]
  );

  const again = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, deps));
  assert.equal(again.considered, 0, 'the audit row is the schedule');

  // ...but a week later it is due once more
  const later = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...deps, now: QUIET + 8 * 24 * 3600_000,
  }));
  assert.equal(later.consolidated.length, 1);
});

test('a failed turn stays due rather than being marked done', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000024');
  const deps = { now: QUIET, hasRecentNotes: () => true,
                 runAgent: () => ({ ok: false, error: 'gateway unreachable' }) };

  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, deps));
  assert.equal(res.consolidated.length, 0);
  assert.equal(res.failed.length, 1);

  const rows = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'memory.consolidated'`);
  assert.equal(rows.rows.length, 0, 'a failure must not count as a run');

  // still due on the next tick
  const retry = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...deps, runAgent: () => ({ ok: true }),
  }));
  assert.equal(retry.consolidated.length, 1);
});

test('per-tick cap protects the single core', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  for (let i = 0; i < mem.MAX_PER_TICK + 2; i++) await activeUser(pool, `+9725000001${10 + i}`);
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    now: QUIET, hasRecentNotes: () => true, runAgent: () => ({ ok: true }),
  }));
  assert.equal(res.consolidated.length, mem.MAX_PER_TICK);
});
