'use strict';
// One table of how often each job SHOULD run (seconds). Shared by the
// dashboard's colouring and /health so the two can never disagree.
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
  config_guard: 600,
  checkin_ladder: 300,
  usage_sweep: 3600,
  metrics_sweep: 3600,
  retention_sweep: 86400,
};

const STALE_MULTIPLIER = 3;

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

module.exports = { JOB_INTERVAL_SECONDS, STALE_MULTIPLIER, isStale, assessJobs };
