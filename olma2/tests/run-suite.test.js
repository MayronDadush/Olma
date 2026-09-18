'use strict';
// run-suite.sh retries the suite when node's test runner wedges. That makes it
// the one thing in CI that can turn a red into a green, so its rules are
// pinned here rather than trusted: a HANG retries, an EXIT never does, and it
// says out loud when it papered over a wedge.
//
// Since 2026-09-18 the wedge is SILENCE, not elapsed time — a fixed ceiling
// killed a healthy-but-slow run on PR #407 and called it a wedge in the log.
// So two things are pinned here that were not before: a slow suite that keeps
// talking must be left alone, and a genuinely never-exiting child must still
// be caught. The second one is proved against a REAL node --test child rather
// than a `sleep`, because that is the failure this wrapper exists for and a
// proxy cannot show that node goes quiet the way the incident says it does.
//
// SUITE_CMD lets these drive it with fake commands, so the tests are about the
// retry logic rather than about the suite.
//
// Filesystem/process tests — no freshDb, no pool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'run-suite.sh');

// Short windows so this file does not become a third of the suite. SILENCE is
// the wedge detector; TIMEOUT is the far looser overall cap and is held well
// out of the way unless a test is specifically about it.
const FAST = { SUITE_SILENCE: '2', SUITE_TIMEOUT: '60', SUITE_ATTEMPTS: '3' };

// A key set to null is REMOVED from the child's environment. Used in exactly
// one place below, and deliberately spelled as "copy everything, then drop
// one" rather than as a hand-built env: isolation travels by environment here,
// and a child built from a fresh object is how a test brokerd once provisioned
// real people (see .claude/rules/testing.md).
function childEnv(extra) {
  const out = { ...process.env, ...FAST, ...extra };
  for (const [k, v] of Object.entries(out)) if (v === null) delete out[k];
  return out;
}

// Each fake command appends to a counter file, so the tests can assert how
// many attempts actually happened rather than inferring it from the output.
function run(cmd, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-'));
  const counter = path.join(dir, 'attempts');
  fs.writeFileSync(counter, '');
  const full = `printf x >> ${counter}; ${cmd}`;
  let status = 0, stdout = '', stderr = '';
  try {
    stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: childEnv({ SUITE_CMD: full, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status;
    stdout = String(err.stdout || '');
    stderr = String(err.stderr || '');
  }
  const attempts = fs.readFileSync(counter, 'utf8').length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr, attempts };
}

// execFileSync gives stderr only on failure, so the passing cases capture it
// by redirecting inside the shell instead.
function runCapturingStderr(cmd, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-'));
  const counter = path.join(dir, 'attempts');
  const errfile = path.join(dir, 'err');
  fs.writeFileSync(counter, '');
  const full = `printf x >> ${counter}; ${cmd}`;
  let status = 0;
  try {
    execFileSync('bash', ['-c', `bash "${SCRIPT}" 2> "${errfile}"`], {
      encoding: 'utf8',
      env: childEnv({ SUITE_CMD: full, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) { status = err.status; }
  const out = { status, stderr: fs.readFileSync(errfile, 'utf8'), attempts: fs.readFileSync(counter, 'utf8').length };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('a passing suite runs exactly once and exits 0', () => {
  const r = run('exit 0');
  assert.equal(r.status, 0);
  assert.equal(r.attempts, 1);
});

test('a FAILING suite is never retried — that is a real red', () => {
  // The whole risk of a retry wrapper is that it turns a genuine failure into
  // a green on the second roll of the dice. It must not.
  const r = run('exit 1');
  assert.equal(r.status, 1);
  assert.equal(r.attempts, 1, 'a non-zero exit must be final');
});

test('an unusual non-zero exit is passed through as itself, not flattened', () => {
  const r = run('exit 7');
  assert.equal(r.status, 7);
  assert.equal(r.attempts, 1);
});

test('a SLOW but talking suite is left alone and runs to completion', () => {
  // The PR #407 regression, and the reason the watchdog measures progress:
  // this runs for ~6s with a 2s window, so a fixed ceiling would have killed
  // it three times and reported a wedge. Every line it prints resets the
  // deadline, so it must finish and exit 0 on the FIRST attempt.
  const r = run('for i in 1 2 3 4 5 6; do echo "still working $i"; sleep 1; done; exit 0');
  assert.equal(r.status, 0, 'a slow suite that keeps talking is not a wedge');
  assert.equal(r.attempts, 1, 'it must not be killed and retried');
  assert.match(r.stdout, /still working 6/, 'it should have run all the way to the end');
});

test('a HANG is retried, announced each time, and still fails at the end', () => {
  // One hang proves all of it — deliberately not three tests that each sit
  // through the full timeout, which made this file a third of the suite.
  const r = run('sleep 60');
  assert.equal(r.attempts, 3, 'should have used all three attempts');
  assert.equal(r.status, 1, 'wedging every time is a failure, not a pass');
  assert.match(r.stderr, /Attempt 1 of 3/);
  assert.match(r.stderr, /Attempt 3 of 3/);
  assert.match(r.stderr, /wedged on all 3 attempts/);
  assert.match(r.stderr, /check whether the wedge has changed\s+shape/);
  // Whoever reads this in a CI log at midnight should be pointed at the thing
  // that is actually most likely wrong. These assertions used to pin the
  // ORIGINAL diagnosis — "stopped talking", "Not a test failure" — which was
  // retired on 2026-09-04 when the cause turned out to be a test of ours. A
  // banner enforced by a test is doctrine: anyone correcting it got a red and
  // could "fix" that by reverting the correction. Pin the shape, not a theory.
  // The "a healthy run is 30-45s" line was pinned here until 2026-09-18 and
  // is exactly that trap: the suite had grown to 121s and the number was a
  // fossil nobody could correct without going red.
  assert.match(r.stderr, /could not exit/);
  assert.match(r.stderr, /Look at OUR code first/);
  assert.match(r.stderr, /no output for/, 'the banner must name SILENCE as what it measured');
});

test('the summary says every attempt went silent, not merely that it ran long', () => {
  // "wedged on all N attempts" has to keep meaning what it says. On #407 it
  // did not, and the log read as a dead suite when the suite was fine.
  const r = run('sleep 60', { SUITE_ATTEMPTS: '2' });
  assert.match(r.stderr, /wedged on all 2 attempts/);
  assert.match(r.stderr, /went silent for 2s with the process still alive/);
});

test('a hang then a pass exits 0 — and SAYS it needed a retry', () => {
  // The mitigation must not hide its own frequency: a workaround nobody can
  // see the cost of is how this gets worse unnoticed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-'));
  const flag = path.join(dir, 'first');
  const r = runCapturingStderr(`if [ ! -f ${flag} ]; then touch ${flag}; sleep 60; else exit 0; fi`);
  assert.equal(r.status, 0);
  assert.equal(r.attempts, 2);
  assert.match(r.stderr, /only on attempt 2/);
  assert.match(r.stderr, /THE WEDGE/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the overall cap is a DIFFERENT verdict: not a wedge, and not retried', () => {
  // A suite still talking when it hits the cap is slow, not stuck. Retrying it
  // would buy the same wall a second time and hand the job's own
  // timeout-minutes the kill — which reports as `cancelled` with no banner at
  // all, the silent skip this wrapper exists to prevent.
  const r = run('while true; do echo chatter; sleep 1; done', { SUITE_SILENCE: '30', SUITE_TIMEOUT: '3' });
  assert.equal(r.status, 1);
  assert.equal(r.attempts, 1, 'the cap must not retry');
  assert.match(r.stderr, /THE OVERALL CAP/);
  assert.match(r.stderr, /still TALKING/);
  assert.doesNotMatch(r.stderr, /THE WEDGE/, 'a talking suite must never be called a wedge');
  assert.doesNotMatch(r.stderr, /wedged on all/);
});

test('SUITE_ATTEMPTS is honoured, so one attempt means no retry at all', () => {
  const r = run('sleep 60', { SUITE_ATTEMPTS: '1' });
  assert.equal(r.attempts, 1);
  assert.equal(r.status, 1);
});

test('it kills the hung run rather than leaving it behind', () => {
  // The runner will not reap its children in this state. Leaking them into
  // the next attempt means leaked databases and a second, confusing failure.
  // Note this "suite" is busy but SILENT on stdout — work nobody can see is
  // still a wedge, which is the whole point of measuring output.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-'));
  const marker = path.join(dir, 'still-alive');
  // A "suite" that keeps writing until something kills it.
  run(`bash -c 'while true; do printf y >> ${marker}; sleep 0.2; done'`, { SUITE_ATTEMPTS: '1' });
  const sizeAfterKill = fs.statSync(marker).size;
  execFileSync('bash', ['-c', 'sleep 1.5']);
  assert.equal(fs.statSync(marker).size, sizeAfterKill, 'the hung process should be dead, not still writing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a REAL never-exiting test child is still caught, killed and reported', () => {
  // The detector must fire for the documented failure, not just for `sleep`.
  // This is that failure exactly: a test file whose test PASSES and which then
  // cannot exit, because a ref'd handle holds its event loop open. Measured
  // 2026-09-18 — node prints the one passing line and then nothing, for ever,
  // and `--test-timeout` does not touch it (it catches a test that never
  // SETTLES; this one settled). docs/incidents.md, "A test file poisoned every
  // other one".
  //
  // The fixture lives in its own mkdtemp, never in a directory the other test
  // files read — that shared write IS the incident this wrapper came from.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-leak-'));
  const file = path.join(dir, 'leak.test.js');
  fs.writeFileSync(file, [
    "const { test } = require('node:test');",
    "test('passes, and then the child cannot exit', () => {});",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  // NODE_TEST_CONTEXT has to go, and the reason is worth knowing: a `node
  // --test` that inherits it from the runner ABOVE it behaves as a test child
  // — it runs the file in-process and force-exits, so the fixture exits 0 in a
  // second and proves nothing. Measured both ways on 2026-09-18. Without it,
  // the child hangs for ever, which is the case under test.
  const r = run(`${JSON.stringify(process.execPath)} --test --test-timeout=60000 ${JSON.stringify(file)}`,
    { SUITE_SILENCE: '4', SUITE_ATTEMPTS: '1', NODE_TEST_CONTEXT: null });

  assert.equal(r.status, 1, 'a child that cannot exit must not pass');
  assert.match(r.stderr, /THE WEDGE/);
  assert.match(r.stderr, /no output for 4s/);
  // It reported the pass and then went quiet: proof the signal is silence
  // after progress, not an absence of output from the start.
  assert.match(r.stdout, /passes, and then the child cannot exit/);

  fs.rmSync(dir, { recursive: true, force: true });
});
