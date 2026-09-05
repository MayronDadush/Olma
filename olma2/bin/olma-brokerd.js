#!/usr/bin/env node
// The long-lived daemon. Runs as a systemd service; everything else in the
// system is either cron or per-turn, this is the one process that stays.
'use strict';
const { createPool } = require('../src/db/pool');
const { jobs } = require('../src/jobs/registry');
const { createBrokerServer } = require('../src/brokerd/server');
const { intervalSeconds, shouldKickOnStart, kickDelayMs } = require('../src/jobs/expectations');

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
  const kicks = [];
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

  // Arm one job. The cadence comes from jobs/expectations.js — the same table
  // /health judges staleness against, so a changed interval can never leave
  // the dashboard calling a healthy job late. Slow jobs also get one staggered
  // run at startup; see KICK_MIN_SECONDS there for why that is not optional.
  const arm = (job, fn) => {
    timers.push(setInterval(() => beat(job, fn), intervalSeconds(job) * 1000));
    if (shouldKickOnStart(job)) {
      kicks.push(setTimeout(() => beat(job, fn), kickDelayMs(kicks.length)));
    }
  };

  if (HEARTBEAT) {
    const alive = () => beat('brokerd', async () => null);
    await alive();
    timers.push(setInterval(alive, 60_000));
  }
  timers.push(setInterval(() => broker.flood.sweep(), 300_000));

  if (WORKER) {
    // The job list lives in src/jobs/registry.js; this loop is all the
    // daemon knows about it. arm() (above) supplies the cadence, the
    // heartbeat and the startup kick for every entry alike.
    const list = jobs({ pool });
    for (const job of list) arm(job.name, job.run);
    console.log(`[brokerd] outbox worker + sweeps armed (${list.length} jobs)`);
  }

  const shutdown = async (sig) => {
    console.log(`[brokerd] ${sig}, shutting down`);
    for (const t of timers) clearInterval(t);
    for (const t of kicks) clearTimeout(t);
    broker.server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => { console.error('[brokerd] fatal:', e); process.exit(1); });
