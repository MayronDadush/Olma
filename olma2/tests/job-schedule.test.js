'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  JOB_INTERVAL_SECONDS, KICK_MIN_SECONDS,
  intervalSeconds, shouldKickOnStart, kickDelayMs, isStale,
} = require('../src/jobs/expectations');

const BROKERD = fs.readFileSync(path.join(__dirname, '..', 'bin', 'olma-brokerd.js'), 'utf8');
const armedJobs = [...BROKERD.matchAll(/\barm\('([a-z_]+)'/g)].map((m) => m[1]);

test('every job brokerd arms has a declared interval', () => {
  assert.ok(armedJobs.length >= 12, `expected the full sweep set, found ${armedJobs.length}`);
  for (const job of armedJobs) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(JOB_INTERVAL_SECONDS, job),
      `${job} is armed but absent from JOB_INTERVAL_SECONDS — it would silently ` +
      'inherit the 3600s default and /health would judge it against a cadence ' +
      'it does not actually run at'
    );
  }
});

test('brokerd no longer carries its own copy of any interval', () => {
  // The bug this guards: two tables describing one fact. An interval changed
  // in one place and not the other makes /health call a healthy job late (or,
  // worse, call a dead one healthy). `alive` and the flood sweep are the two
  // deliberate exceptions — the first must beat before anything else is armed,
  // the second writes no heartbeat at all. `arm` itself is the one place a
  // setInterval is allowed, and it is where the table is read.
  const strays = [...BROKERD.matchAll(/setInterval\(([^\n]*)/g)]
    .map((m) => m[1])
    .filter((s) => !s.includes('alive') && !s.includes('flood.sweep')
      && !s.includes('intervalSeconds(job)'));
  assert.deepEqual(strays, [], 'a raw setInterval reintroduces the second table');
});

test('a job slower than the gap between deploys is kicked at startup', () => {
  // Observed live 2026-08-22: CI restarts brokerd on every merge to main, and
  // setInterval starts counting from process start — so retention (24h) had
  // last run 13 hours earlier with expired card PNGs already on disk, and the
  // 10-minute config_guard and fact_extraction were starved by three deploys
  // inside half an hour. Being "armed" is not the same as ever running.
  assert.equal(shouldKickOnStart('retention_sweep'), true);
  assert.equal(shouldKickOnStart('fact_extraction'), true);
  assert.equal(shouldKickOnStart('config_guard'), true);
  assert.equal(shouldKickOnStart('checkin_ladder'), true);
  // Fast jobs need no kick — they fire within a minute of boot anyway, and a
  // kick would only add work to the moment the box is busiest.
  assert.equal(shouldKickOnStart('intake_sweep'), false);
  assert.equal(shouldKickOnStart('outbox_worker'), false);
  assert.equal(shouldKickOnStart('minute_sweeps'), false);
});

test('kicks are staggered, not a thundering herd on a 1-vCPU box', () => {
  const kicked = armedJobs.filter(shouldKickOnStart);
  assert.ok(kicked.length >= 5, 'expected several slow jobs to be kicked');
  const delays = kicked.map((_, i) => kickDelayMs(i));
  assert.ok(delays[0] >= 15_000, 'the first kick waits for the process to settle');
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] - delays[i - 1] >= 10_000,
      'two kicks landing within 10s of each other defeats the point');
  }
  // And the whole herd must be through well inside the shortest kicked
  // interval, or the kick and the first real tick start racing.
  const shortestKicked = Math.min(...kicked.map(intervalSeconds)) * 1000;
  assert.ok(delays[delays.length - 1] < shortestKicked,
    `last kick at ${delays[delays.length - 1]}ms must precede ${shortestKicked}ms`);
});

test('card refreshes happen after the sweep transaction, never inside it', () => {
  // refreshUserCard reads on its own pool connection, which cannot see rows a
  // still-open transaction wrote. Wired inside the tx, every card rendered
  // WITHOUT the facts/plan the run had just produced — caught live on the
  // planning pass's first real run: five plans written, zero cards showing
  // them. The refresh must be sequenced after withTx resolves.
  assert.doesNotMatch(BROKERD, /sweepFactExtraction\(c, \{\s*refreshCard/,
    'fact_extraction must not refresh cards from inside its transaction');
  assert.doesNotMatch(BROKERD, /sweepPlanning\(c, \{\s*refreshCard/,
    'planning must not refresh cards from inside its transaction');
  assert.match(BROKERD, /refreshAfter\(out\.extracted/);
  assert.match(BROKERD, /refreshAfter\(out\.planned/);
});

test('a kicked job is not immediately stale, and a starved one is', () => {
  const now = Date.parse('2026-08-22T10:00:00Z');
  const minsAgo = (m) => new Date(now - m * 60_000).toISOString();
  // The live reading that exposed this: retention 13h old on a 24h interval
  // reads healthy (3x = 72h), which is exactly why nobody noticed it had not
  // run. The kick is the fix; the health check cannot be.
  assert.equal(isStale('retention_sweep', minsAgo(13 * 60), now), false);
  // config_guard at 36 minutes on a 10-minute interval is the alarm that did
  // fire, and it was telling the truth.
  assert.equal(isStale('config_guard', minsAgo(36), now), true);
  assert.equal(isStale('config_guard', minsAgo(20), now), false);
  assert.ok(KICK_MIN_SECONDS <= intervalSeconds('config_guard'));
});
