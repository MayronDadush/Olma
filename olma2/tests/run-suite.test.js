'use strict';
// run-suite.sh retries the suite when node's test runner wedges. That makes it
// the one thing in CI that can turn a red into a green, so its rules are
// pinned here rather than trusted: a HANG retries, an EXIT never does, and it
// says out loud when it papered over a wedge.
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
      env: { ...process.env, SUITE_CMD: full, SUITE_TIMEOUT: '2', SUITE_ATTEMPTS: '3', ...env },
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
      env: { ...process.env, SUITE_CMD: full, SUITE_TIMEOUT: '2', SUITE_ATTEMPTS: '3', ...env },
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
  // Whoever reads this in a CI log at midnight should not have to work out
  // whether their own branch broke something.
  assert.match(r.stderr, /Not a test failure/);
  assert.match(r.stderr, /stopped talking/);
  assert.match(r.stderr, /a healthy run is 30-45s/);
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

test('SUITE_ATTEMPTS is honoured, so one attempt means no retry at all', () => {
  const r = run('sleep 60', { SUITE_ATTEMPTS: '1' });
  assert.equal(r.attempts, 1);
  assert.equal(r.status, 1);
});

test('it kills the hung run rather than leaving it behind', () => {
  // The runner will not reap its children in this state. Leaking them into
  // the next attempt means leaked databases and a second, confusing failure.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-suite-'));
  const marker = path.join(dir, 'still-alive');
  // A "suite" that keeps writing until something kills it.
  run(`bash -c 'while true; do printf y >> ${marker}; sleep 0.2; done'`, { SUITE_ATTEMPTS: '1' });
  const sizeAfterKill = fs.statSync(marker).size;
  execFileSync('bash', ['-c', 'sleep 1.5']);
  assert.equal(fs.statSync(marker).size, sizeAfterKill, 'the hung process should be dead, not still writing');
  fs.rmSync(dir, { recursive: true, force: true });
});
