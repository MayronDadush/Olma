'use strict';
// One table of how often each job SHOULD run (seconds). Shared by the
// dashboard's colouring, /health, AND brokerd's own timers, so the three can
// never disagree. (brokerd used to carry its own copy of every interval —
// two tables describing one fact, either of which could drift.)
//
// A job is stale only if it has run before and its last run is older than
// 3× its interval — a job that has simply not had its first run since a
// restart (hourly/daily ones) is NOT a failure. Getting this wrong is how
// health checks become noise that everyone learns to ignore.
const JOB_INTERVAL_SECONDS = {
  brokerd: 60,
  outbox_worker: 30,
  minute_sweeps: 60, // reminders + digests + unblocks, one tick
  intake_sweep: 5,
  reopen_sweep: 60,
  intake_template_sync: 60,
  unanswered_sweep: 60,
  lane_watchdog: 30,
  config_guard: 600,
  checkin_ladder: 300,
  memory_consolidation: 3600,
  fact_extraction: 600,
  // Daily per user, but ticked hourly for the same reason memory_consolidation
  // is: "their own small hours" only means something in each person's zone.
  planning_sweep: 3600,
  live_updates: 3600,
  usage_sweep: 3600,
  // Nightly, but ticked hourly like planning: the job itself owns the
  // small-hours window and the once-per-night watermark.
  eval_sweep: 3600,
  metrics_sweep: 3600,
  retention_sweep: 86400,
};

const STALE_MULTIPLIER = 3;

// `setInterval` starts counting at process start, so a job only ever runs if
// the process survives a full interval — and CI restarts brokerd on every
// merge to main. A job whose interval is longer than the gap between deploys
// therefore never runs AT ALL, silently, while looking armed. Observed
// 2026-08-22: retention (24h) had last run 13 hours earlier with two expired
// card PNGs already on disk, and the 10-minute config_guard and
// fact_extraction had been starved by three deploys inside half an hour.
// So every job slow enough to be starved this way also gets one run shortly
// after startup, staggered so a 1-vCPU box does not wake to seven at once.
// Every job is idempotent (idempotency keys, high-water marks, per-user
// cadence gates), so an extra run costs a query, never a duplicate message.
const KICK_MIN_SECONDS = 300;
const KICK_FIRST_DELAY_MS = 20_000;
const KICK_SPACING_MS = 15_000;

function intervalSeconds(jobName) {
  return JOB_INTERVAL_SECONDS[jobName] || 3600;
}

function shouldKickOnStart(jobName) {
  return intervalSeconds(jobName) >= KICK_MIN_SECONDS;
}

// nth kick scheduled, 0-based → when it fires.
function kickDelayMs(index) {
  return KICK_FIRST_DELAY_MS + index * KICK_SPACING_MS;
}

function isStale(jobName, lastRunAt, now = Date.now()) {
  if (!lastRunAt) return false; // never ran yet (e.g. fresh restart) — not a failure
  const expected = JOB_INTERVAL_SECONDS[jobName] || 3600;
  return (now - new Date(lastRunAt).getTime()) / 1000 > expected * STALE_MULTIPLIER;
}

// Rows → the health verdict. Also flags jobs whose last run errored.
function assessJobs(rows, now = Date.now()) {
  const stale = rows.filter((r) => isStale(r.job_name, r.last_run_at, now)).map((r) => r.job_name);
  const failing = rows.filter((r) => r.note && String(r.note).startsWith('ERR')).map((r) => r.job_name);
  return { ok: stale.length === 0 && failing.length === 0, stale, failing };
}

module.exports = {
  JOB_INTERVAL_SECONDS, STALE_MULTIPLIER, isStale, assessJobs,
  KICK_MIN_SECONDS, intervalSeconds, shouldKickOnStart, kickDelayMs,
};
