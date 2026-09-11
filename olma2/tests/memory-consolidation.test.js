'use strict';
// Nothing folds the daily notes without this job, so MEMORY.md stays exactly
// as provisioning wrote it while memory/ grows forever.
//
// Since 2026-09-10 the job thinks over a direct model call and does its own
// writing, so the tests cover two things they did not before: what the server
// refuses to write, and that a quiet week still stamps the schedule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const mem = require('../src/jobs/memory-consolidation');

const QUIET = new Date('2026-08-18T00:30:00Z').getTime();  // 03:30 Asia/Jerusalem
const DAYTIME = new Date('2026-08-18T11:00:00Z').getTime(); // 14:00 Asia/Jerusalem

// The model half of a run that succeeds, for the tests that are about
// something else. `answer` is whatever the model said.
function answering(answer, calls) {
  return async (opts) => {
    if (calls) calls.push(opts);
    return {
      ok: true, text: JSON.stringify(answer), model: 'test-model',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    };
  };
}

// File deps that never touch a disk, for the same reason.
const NOTES = [{ name: '2026-08-17.md', text: 'went to the dentist' }];
function fileDeps(overrides = {}) {
  return {
    hasRecentNotes: () => true,
    readNotes: () => NOTES,
    readMemory: () => '# Long-term memory\n\n(Nothing yet.)\n',
    writeMemory: () => ({ ok: true }),
    ...overrides,
  };
}

async function activeUser(pool, phone, workspace) {
  const u = await makeUser(pool, phone, { timezone: 'Asia/Jerusalem' });
  await pool.query(
    `UPDATE users SET agent_id = $2, workspace_path = $3, onboarded_at = now() WHERE id = $1`,
    [u.id, `u-${u.id}`, workspace || `/tmp/ws-${u.id}`]);
  return u;
}

test('one model call per due user, in their small hours', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await activeUser(pool, '+972500000020');

  const calls = [];
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps(), now: QUIET,
    complete: answering({ changed: true, memory: 'dentist on the 17th' }, calls),
  }));

  assert.deepEqual(res.consolidated, [Number(u.id)]);
  assert.equal(calls.length, 1);
  // The week's notes and the current file both have to reach the model — it is
  // rewriting one from the other, and cannot do it having seen only one.
  assert.match(calls[0].user, /went to the dentist/);
  assert.match(calls[0].user, /Nothing yet/);
  // the instruction must still forbid putting contacts in prose memory
  assert.match(calls[0].user, /Never write a phone number/);
  // no session, no tools: the answer shape is the whole contract
  assert.match(calls[0].system, /"changed"/);
});

test('does not run during the user\'s day', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000021');
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps(), now: DAYTIME,
    complete: () => { throw new Error('must not run in the middle of their day'); },
  }));
  assert.equal(res.considered, 0);
});

test('a user with no new notes costs no model call', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000022');
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps({ hasRecentNotes: () => false }), now: QUIET,
    complete: () => { throw new Error('must not spend a call on an empty week'); },
  }));
  assert.equal(res.skipped, 1);
  assert.equal(res.consolidated.length, 0);
});

test('a consolidated user is not due again for a week', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000023');
  const deps = { ...fileDeps(), now: QUIET,
                 complete: answering({ changed: true, memory: 'a durable fact' }) };

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

test('a failed call stays due rather than being marked done', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000024');
  const deps = { ...fileDeps(), now: QUIET,
                 complete: async () => ({ ok: false, error: 'provider unreachable' }) };

  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, deps));
  assert.equal(res.consolidated.length, 0);
  assert.equal(res.failed.length, 1);

  const rows = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'memory.consolidated'`);
  assert.equal(rows.rows.length, 0, 'a failure must not count as a run');

  // still due on the next tick
  const retry = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...deps, complete: answering({ changed: true, memory: 'a durable fact' }),
  }));
  assert.equal(retry.consolidated.length, 1);
});

test('per-tick cap bounds model calls', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  for (let i = 0; i < mem.MAX_PER_TICK + 2; i++) await activeUser(pool, `+9725000001${10 + i}`);
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps(), now: QUIET,
    complete: answering({ changed: true, memory: 'a durable fact' }),
  }));
  assert.equal(res.consolidated.length, mem.MAX_PER_TICK);
});

test('a quiet week writes nothing and still stamps the schedule', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000030');

  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps({ writeMemory: () => { throw new Error('nothing to write'); } }),
    now: QUIET, complete: answering({ changed: false }),
  }));

  assert.equal(res.unchanged, 1);
  assert.equal(res.consolidated.length, 0);
  assert.equal(res.failed.length, 0, 'an empty week is a normal outcome, not a failure');

  // Stamped, or the same quiet week is re-read on every tick for ever.
  const rows = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'memory.consolidated'`);
  assert.equal(rows.rows.length, 1);
});

test('a quiet week still counts against the per-tick cap', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  for (let i = 0; i < mem.MAX_PER_TICK + 2; i++) await activeUser(pool, `+9725000002${10 + i}`);
  let calls = 0;
  await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps(), now: QUIET,
    complete: async () => {
      calls++;
      return { ok: true, text: '{"changed": false}', model: 'm', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  }));
  assert.equal(calls, mem.MAX_PER_TICK, 'the cap bounds calls, whatever they answer');
});

test('the server refuses to write a phone number into prose memory', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await activeUser(pool, '+972500000031');

  let wrote = false;
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    ...fileDeps({ writeMemory: () => { wrote = true; return { ok: true }; } }),
    now: QUIET,
    complete: answering({ changed: true, memory: 'call Dana on 0501234567 about the move' }),
  }));

  assert.equal(wrote, false, 'the instruction is a request; this check is the rule');
  assert.equal(res.consolidated.length, 0);
  assert.equal(res.failed.length, 1);
  assert.match(res.failed[0].error, /phone number/);

  // refused means unstamped: the week is retried, not silently lost
  const rows = await pool.query(`SELECT 1 FROM audit_log WHERE event = 'memory.consolidated'`);
  assert.equal(rows.rows.length, 0);
});

test('usableMemory keeps ordinary prose and refuses what must not be written', () => {
  assert.equal(mem.usableMemory('Moving flat in October.').ok, true);
  // a trailing newline is added rather than demanded of the model
  assert.equal(mem.usableMemory('one line').text, 'one line\n');

  assert.equal(mem.usableMemory('').ok, false);
  assert.equal(mem.usableMemory('   ').ok, false);
  assert.equal(mem.usableMemory(null).ok, false);
  assert.equal(mem.usableMemory(undefined).ok, false);
  assert.equal(mem.usableMemory('x'.repeat(mem.MAX_MEMORY_CHARS + 1)).ok, false);

  // phones, in the two shapes a model actually writes
  assert.equal(mem.usableMemory('reach her on +972 50 123 4567').ok, false);
  assert.equal(mem.usableMemory('reach her on 0501234567').ok, false);

  // ...and the near-misses that must survive, or the check eats real memory
  assert.equal(mem.usableMemory('Lease ends 2026-09-10.').ok, true);
  assert.equal(mem.usableMemory('Booked flight LY315 for the 2nd.').ok, true);
  assert.equal(mem.usableMemory('Saving 2000 a month.').ok, true);
});

test('the fold lands in the real MEMORY.md, and usage is written down', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-mem-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'memory'));
  fs.writeFileSync(path.join(ws, 'memory', '2026-08-17.md'), 'started a new job');
  fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# Long-term memory\n\n(Nothing yet.)\n');
  const u = await activeUser(pool, '+972500000032', ws);

  const calls = [];
  const res = await withTx(pool, (c) => mem.sweepMemoryConsolidation(c, {
    now: QUIET,
    complete: answering({ changed: true, memory: '# Long-term memory\n\nStarted a new job in August.' }, calls),
  }));

  assert.deepEqual(res.consolidated, [Number(u.id)]);
  // The real readers ran: the note reached the prompt off the disk.
  assert.match(calls[0].user, /started a new job/);
  assert.equal(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8'),
    '# Long-term memory\n\nStarted a new job in August.\n');

  // A direct call leaves no transcript, so a run that skipped this would be
  // spend no page could ever show.
  const led = await pool.query(`SELECT total_tokens FROM usage_ledger WHERE user_id = $1`, [u.id]);
  assert.equal(led.rows.length, 1);
  assert.equal(Number(led.rows[0].total_tokens), 150);
});

test('readNotes takes the week newest-first and leaves older files behind the cap', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-mem-'));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ws, 'memory'));
  const now = Date.now();
  for (const [name, age] of [['2026-08-17.md', 1], ['2026-08-16.md', 2], ['2026-07-01.md', 40]]) {
    const f = path.join(ws, 'memory', name);
    fs.writeFileSync(f, `notes from ${name}`);
    const t0 = (now - age * 24 * 3600_000) / 1000;
    fs.utimesSync(f, t0, t0);
  }
  fs.writeFileSync(path.join(ws, 'memory', 'not-a-note.txt'), 'ignored');

  const notes = mem.readNotes(ws, now);
  assert.deepEqual(notes.map((n) => n.name), ['2026-08-16.md', '2026-08-17.md'],
    'the week only, in chronological order for the model');

  // a workspace with no memory/ dir is empty, never an exception
  assert.deepEqual(mem.readNotes(path.join(ws, 'nope'), now), []);
});
