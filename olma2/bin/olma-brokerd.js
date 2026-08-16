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
    // checkin ladder — hourly
    timers.push(setInterval(() => beat('checkin_ladder', () =>
      withTx(pool, (c) => checkin.run(c))), 3600_000));

    // intake pipeline — inert until an 'intake' agent exists in openclaw.json.
    // 5s, and it costs a small file read: discovery reads the gateway's own
    // session index off disk instead of spawning `openclaw sessions list`
    // (2.9s of CPU per call, previously every 15s — see channels/sessions.js).
    // A new user's wait for their welcome starts ticking here, so this is the
    // one sweep worth running eagerly. When it provisions someone, drain the
    // outbox at once rather than letting their welcome sit for up to 30s.
    timers.push(setInterval(() => beat('intake_sweep', async () => {
      const res = await withTx(pool, (c) => intake.sweepIntakeSessions(c, { configPath: OPENCLAW_CONFIG }));
      if (res && res.provisioned && res.provisioned.length) await drain();
      return res;
    }), 5_000));
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
