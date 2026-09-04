'use strict';
// The two guards in helpers.js that only ever run when something has already
// gone wrong — so they are the two most likely to rot into decoration.
//
// Both exist because of the CI wedge (incidents.md, "A test file poisoned
// every other one"): a test child that cannot exit is INVISIBLE. `node --test`
// waits on `once(child, 'exit')` for ever and never flushes the file's output,
// so the whole suite stops with no message at all. Each guard converts one
// route into that state into a loud, named failure.
//
// Driven as real child processes against real fixture files, because that is
// the only way to observe "the process did not exit".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPERS = path.join(__dirname, 'helpers.js').replace(/\\/g, '\\\\');

// Fixtures are staged in a temp dir, never in tests/ — a stray *.test.js in
// the real directory would be picked up by everyone else's run, which is the
// very failure mode this file documents.
function runFixture(t, source, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.test.js');
  fs.writeFileSync(file, source);

  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID are set by the runner in OUR
    // process. Inherited, they make the grandchild believe it is already a
    // test child, and it exits 0 in ~30ms having run nothing — which reads
    // exactly like "the guard did not fire".
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;
    const child = spawn(process.execPath, ['--test', file], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // If a guard fails to fire, the child hangs for ever — exactly the bug.
    // Bound it so this test reports that as a failure instead of joining it.
    const kill = setTimeout(() => { child.kill('SIGKILL'); }, 30_000);
    child.on('exit', (code, signal) => { clearTimeout(kill); resolve({ code, signal, out }); });
  });
}

test('a client checked out and never released fails teardown by name, and does not hang', async (t) => {
  const { code, signal, out } = await runFixture(t, `
    const { test, before, after } = require('node:test');
    const { freshDb } = require('${HELPERS}');
    let db;
    before(async () => { db = await freshDb(); });
    after(async () => { await db.teardown(); });
    test('leaks a client on purpose', async () => {
      await db.pool.connect();   // no release, no finally
    });
  `, { OLMA_TEST_POOL_END_MS: '1000', OLMA_TEST_EXIT_WATCHDOG_MS: '20000' });

  assert.equal(signal, null, 'the child had to be SIGKILLed — the guard did not fire');
  assert.notEqual(code, 0, 'a leaked checkout must fail the file');
  assert.match(out, /checked out and never released/);
  // and it must say WHERE, or the next person still has to go hunting
  assert.match(out, /client checked out here/);
  assert.match(out, /fixture\.test\.js/);
});

test('the exit watchdog kills a child that finishes its tests but cannot exit', async (t) => {
  const { code, signal, out } = await runFixture(t, `
    const { test, before, after } = require('node:test');
    const net = require('node:net');
    const { freshDb } = require('${HELPERS}');
    let db;
    before(async () => { db = await freshDb(); });
    after(async () => { await db.teardown(); });
    test('passes, but leaves a socket open for ever', () => {
      net.createServer().listen(0);   // never closed
    });
  `, { OLMA_TEST_EXIT_WATCHDOG_MS: '1500' });

  assert.equal(signal, null, 'the child had to be SIGKILLed — the watchdog did not fire');
  // The watchdog exits 7 in the process running the FILE; what we observe here
  // is the runner above it, which reports that file as failed and exits 1.
  assert.notEqual(code, 0, out);
  assert.match(out, /\[exit-watchdog\]/);
  assert.match(out, /still alive/);
  // it has to name what is holding the loop open, not just that something is
  assert.match(out, /ServerHandle|TCPSERVERWRAP|Server/i);
});

test('an ordinary file still exits cleanly, with both guards armed', async (t) => {
  const { code, signal, out } = await runFixture(t, `
    const { test, before, after } = require('node:test');
    const { freshDb } = require('${HELPERS}');
    let db;
    before(async () => { db = await freshDb(); });
    after(async () => { await db.teardown(); });
    test('releases what it takes', async () => {
      const c = await db.pool.connect();
      try { await c.query('SELECT 1'); } finally { c.release(); }
    });
  `, { OLMA_TEST_POOL_END_MS: '1000', OLMA_TEST_EXIT_WATCHDOG_MS: '1500' });

  assert.equal(signal, null);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /\[exit-watchdog\]/);
});
