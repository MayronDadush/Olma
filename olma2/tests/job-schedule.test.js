'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  JOB_INTERVAL_SECONDS, KICK_MIN_SECONDS,
  intervalSeconds, shouldKickOnStart, kickDelayMs, isStale, warmupBudgetMs,
} = require('../src/jobs/expectations');

const BROKERD = fs.readFileSync(path.join(__dirname, '..', 'bin', 'olma-brokerd.js'), 'utf8');
const armedJobs = [...BROKERD.matchAll(/\barm\('([a-z_]+)'/g)].map((m) => m[1]);
const DEPLOY_SH = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');

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

test('the deploy gate outlasts the startup kicks it is waiting on', () => {
  // The failure this pins: deploy.sh checked /health once, 5s after the
  // restart, while the last startup kick does not even fire until 110s. The
  // gate could therefore only pass by luck, and on 2026-08-22 it stopped
  // getting lucky — two merges with 390+ green tests each rolled themselves
  // back, then declared the (perfectly healthy) rollback broken too.
  const kicked = Object.keys(JOB_INTERVAL_SECONDS).filter(shouldKickOnStart);
  const lastKickMs = kickDelayMs(kicked.length - 1);
  assert.ok(warmupBudgetMs() > lastKickMs,
    `budget ${warmupBudgetMs()}ms must outlast the last kick at ${lastKickMs}ms`);
  // And with room for the kick to actually DO something: fact_extraction and
  // memory_consolidation spawn real agent turns, not queries.
  assert.ok(warmupBudgetMs() - lastKickMs >= 60_000,
    'a budget that expires the instant the last kick fires leaves no time to run it');
});

test('deploy.sh polls for health rather than sampling it once', () => {
  // Guards the shape, not the number — a reintroduced `sleep N; health_ok`
  // would pass the budget test above while restoring the exact bug.
  assert.ok(/wait_for_health/.test(DEPLOY_SH), 'the polling gate is gone');
  assert.ok(!/sleep 5\n\s*if .*health_ok/.test(DEPLOY_SH),
    'a single-sample health check is back');
  // The rollback path has to be as patient as the deploy path: it restarts
  // the same two services and meets the same cold start.
  const rollback = DEPLOY_SH.slice(DEPLOY_SH.indexOf('roll_back()'));
  assert.ok(/wait_for_health/.test(rollback),
    'rollback still judges itself on one impatient sample');
  // Budget comes from expectations.js, never a second number written in bash.
  assert.ok(/warmupBudgetMs/.test(DEPLOY_SH),
    'the wait must be derived from the schedule, not hardcoded beside it');
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
