#!/usr/bin/env node
// The long-lived daemon. Runs as a systemd service; everything else in the
// system is either cron or per-turn, this is the one process that stays.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const { drainOnce } = require('../src/outbox/worker');
const { makeDeliverer } = require('../src/channels/openclaw');
const checkin = require('../src/jobs/checkin');
const sweeps = require('../src/jobs/sweeps');
const intake = require('../src/jobs/intake');
const configGuard = require('../src/jobs/config-guard');
const unanswered = require('../src/jobs/unanswered');
const laneWatchdog = require('../src/jobs/lane-watchdog');
const memoryConsolidation = require('../src/jobs/memory-consolidation');
const { DEFAULT_PATH: OPENCLAW_CONFIG } = require('../src/intake/openclaw-config');

const SOCK = process.env.OLMA_SOCK || '/opt/olma2/run/brokerd.sock';
const HEARTBEAT = process.env.OLMA_HEARTBEAT !== 'off';
const WORKER = process.env.OLMA_WORKER !== 'off';

async function main() {
  const pool = createPool();
  await pool.query('SELECT 1'); // fail fast if DB is down
  const broker = createBrokerServer({ pool });
  await broker.listen(SOCK);
  console.log(`[brokerd] listening on ${SOCK}`);

  const timers = [];
  // Overlap guard: setInterval does not wait for the previous run. Without
  // this, one hung sweep (e.g. a stuck openclaw CLI child) stacks a new hung
  // child every tick until the box runs out of processes.
  const running = new Set();
  const beat = async (job, fn) => {
    if (running.has(job)) return;
    running.add(job);
    try {
      const result = await fn();
      await pool.query(
        `INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at, note)
         VALUES ($1, now(), now(), $2)
         ON CONFLICT (job_name) DO UPDATE SET last_run_at = now(), last_ok_at = now(), note = $2`,
        [job, result ? JSON.stringify(result).slice(0, 200) : null]
      );
    } catch (e) {
      console.error(`[brokerd] job ${job} failed:`, e.message);
      await pool.query(
        `INSERT INTO job_heartbeats (job_name, last_run_at, note) VALUES ($1, now(), $2)
         ON CONFLICT (job_name) DO UPDATE SET last_run_at = now(), note = $2`,
        [job, ('ERR ' + e.message).slice(0, 200)]
      ).catch(() => {});
    } finally {
      running.delete(job);
    }
  };

  if (HEARTBEAT) {
    const alive = () => beat('brokerd', async () => null);
    await alive();
    timers.push(setInterval(alive, 60_000));
  }
  timers.push(setInterval(() => broker.flood.sweep(), 300_000));

  if (WORKER) {
    const deliver = makeDeliverer(pool);
    const drain = () => beat('outbox_worker', () => drainOnce(pool, deliver));
    timers.push(setInterval(drain, 30_000));

    // One tick for all three minute-sweeps. They were three intervals firing
    // on the same second, each taking its own connection and transaction, to
    // do work that is almost always "nothing due" — three times the wake-ups
    // for one tick's worth of results.
    timers.push(setInterval(() => beat('minute_sweeps', () => withTx(pool, async (c) => ({
      reminders: await sweeps.sweepReminders(c),
      digests: await sweeps.sweepDigests(c),
      unblocks: await sweeps.sweepUnblocks(c),
    }))), 60_000));
    // checkin ladder — every 5 minutes, because day one has a 15-minute step
    // and an hourly tick would land it anywhere up to an hour late. Cheap: one
    // query plus a filter, and idempotency keys make re-runs no-ops.
    timers.push(setInterval(() => beat('checkin_ladder', () =>
      withTx(pool, (c) => checkin.run(c))), 300_000));

    // repair pass for messages the gateway dropped — see jobs/unanswered.js
    timers.push(setInterval(() => beat('unanswered_sweep', () =>
      withTx(pool, (c) => unanswered.sweepUnanswered(c))), 60_000));

    // Free lanes the gateway has classified stuck and then declined to free.
    // 30s, because this is the difference between a person waiting ~90s and a
    // person waiting until unanswered_sweep notices minutes later.
    const { abortSessionLane } = require('../src/channels/openclaw');
    timers.push(setInterval(() => beat('lane_watchdog', () =>
      withTx(pool, (c) => laneWatchdog.sweepLaneWatchdog(c, { abort: abortSessionLane }))), 30_000));

    // intake pipeline — inert until an 'intake' agent exists in openclaw.json.
    // 5s, and it costs a small file read: discovery reads the gateway's own
    // session index off disk instead of spawning `openclaw sessions list`
    // (2.9s of CPU per call, previously every 15s — see channels/sessions.js).
    // Provisioning is the whole job now — no welcome message follows it (see
    // intake/provision.js), so there is nothing left to drain eagerly; the
    // regular 30s outbox_worker tick is enough.
    timers.push(setInterval(() => beat('intake_sweep', () =>
      withTx(pool, (c) => intake.sweepIntakeSessions(c, {
        configPath: OPENCLAW_CONFIG, readFirstMessage: intake.readIntakeFirstMessage,
      }))), 5_000));
    timers.push(setInterval(() => beat('reopen_sweep', () =>
      withTx(pool, (c) => intake.sweepReopen(c))), 60_000));
    // keep the intake greeter's open/closed text in sync with the flag
    const { syncIntakeWorkspace } = require('../src/intake/intake-workspace');
    const flagsDomain = require('../src/domain/flags');
    timers.push(setInterval(() => beat('intake_template_sync', async () => {
      if (!intake.intakeConfigured(OPENCLAW_CONFIG)) return { skipped: true };
      const open = (await flagsDomain.getFlag(pool, 'registration_open')) === true;
      return syncIntakeWorkspace(open);
    }), 60_000));
    // identity-hardening watchdog — every 10 minutes
    timers.push(setInterval(() => beat('config_guard', () =>
      withTx(pool, (c) => configGuard.run(c, { configPath: OPENCLAW_CONFIG }))), 600_000));

    // Weekly per user, but ticked hourly: "the small hours" is only meaningful
    // in each person's own timezone, so the job decides who is due rather than
    // the interval deciding for it.
    const { runSilentAgentTurn } = require('../src/channels/openclaw');
    timers.push(setInterval(() => beat('memory_consolidation', () =>
      withTx(pool, (c) => memoryConsolidation.sweepMemoryConsolidation(c, {
        runAgent: runSilentAgentTurn,
      }))), 3600_000));

    // Deep memory: read a finished conversation and write down what it taught
    // us. Ticked every 10 minutes rather than on the chapter boundary itself —
    // there is no event for "they stopped replying", so the job asks who has
    // been quiet for half an hour. Cheap when there is nothing to do: the
    // common tick is one indexed query plus a file read per candidate, and
    // only a user with genuinely unread messages costs a model turn.
    const factExtraction = require('../src/jobs/fact-extraction');
    const { refreshUserCard } = require('../src/intake/user-card');
    timers.push(setInterval(() => beat('fact_extraction', () =>
      withTx(pool, (c) => factExtraction.sweepFactExtraction(c, {
        runAgent: runSilentAgentTurn,
        refreshCard: (userId) => refreshUserCard(pool, userId),
      }))), 600_000));

    // cost attribution + product analytics — hourly; retention — daily
    const usage = require('../src/jobs/usage');
    const metrics = require('../src/jobs/metrics');
    const retention = require('../src/jobs/retention');
    timers.push(setInterval(() => beat('usage_sweep', () =>
      withTx(pool, (c) => usage.sweepUsage(c))), 3600_000));
    timers.push(setInterval(() => beat('metrics_sweep', () =>
      withTx(pool, (c) => metrics.sweepMetrics(c))), 3600_000));
    timers.push(setInterval(() => beat('retention_sweep', () =>
      withTx(pool, (c) => retention.sweepRetention(c))), 24 * 3600_000));
    console.log('[brokerd] outbox worker + sweeps armed');
  }

  const shutdown = async (sig) => {
    console.log(`[brokerd] ${sig}, shutting down`);
    for (const t of timers) clearInterval(t);
    broker.server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { console.error('[brokerd] fatal:', e); process.exit(1); });
