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
    const deliver = makeDeliverer(pool);
    // The credit-out alarm rides the worker's own tick (no sweeper of its
    // own) and the raw pipe (no model, no credit needed) — see
    // jobs/credit-watch.js for why both choices are the point.
    const creditWatch = require('../src/jobs/credit-watch');
    const { runOpenclaw } = require('../src/channels/openclaw');
    const rawSend = (phone, text) => runOpenclaw([
      'message', 'send', '--channel', 'whatsapp', '--target', phone, '--message', text,
    ]);
    arm('outbox_worker', async () => {
      const out = await drainOnce(pool, deliver);
      const alert = await withTx(pool, (c) => creditWatch.checkCreditAlert(c, { send: rawSend }))
        .catch(() => ({ alerted: false }));
      // A night outage is queued rather than sent at 03:00; this is what
      // delivers it when morning comes, on the same beat.
      const flushed = await withTx(pool, (c) => creditWatch.flushPendingCreditAlert(c, { send: rawSend }))
        .catch(() => null);
      if (flushed && flushed.alerted) return { ...out, creditAlert: flushed.phone, deferred: true };
      return alert.alerted ? { ...out, creditAlert: alert.phone } : out;
    });

    // The runway warning, on the same raw pipe as the outage alarm above it but
    // NOT on the same beat: this one costs three calls to external billing APIs,
    // and a balance measured in days does not change between 30-second ticks.
    // Six-hourly is a warning that reaches you the same morning without ever
    // being a poll. Tier bookkeeping inside makes repeat ticks silent.
    arm('balance_watch', () =>
      withTx(pool, (c) => creditWatch.checkBalanceForecast(c, { send: rawSend })));

    // One tick for the minute-sweeps. They were separate intervals firing
    // on the same second, each taking its own connection and transaction, to
    // do work that is almost always "nothing due" — three times the wake-ups
    // for one tick's worth of results.
    arm('minute_sweeps', () => withTx(pool, async (c) => ({
      reminders: await sweeps.sweepReminders(c),
      digests: await sweeps.sweepDigests(c),
      unblocks: await sweeps.sweepUnblocks(c),
      staleMeetings: await sweeps.sweepStaleMeetings(c),
      mediaJobs: await sweeps.sweepMediaJobs(c),
    })));
    // checkin ladder — every 5 minutes, because day one has a 15-minute step
    // and an hourly tick would land it anywhere up to an hour late. Cheap: one
    // query plus a filter, and idempotency keys make re-runs no-ops.
    arm('checkin_ladder', () => withTx(pool, (c) => checkin.run(c)));

    // repair pass for messages the gateway dropped — see jobs/unanswered.js
    arm('unanswered_sweep', () => withTx(pool, (c) => unanswered.sweepUnanswered(c)));

    // Free lanes the gateway has classified stuck and then declined to free.
    // 30s, because this is the difference between a person waiting ~90s and a
    // person waiting until unanswered_sweep notices minutes later.
    const { abortSessionLane } = require('../src/channels/openclaw');
    arm('lane_watchdog', () =>
      withTx(pool, (c) => laneWatchdog.sweepLaneWatchdog(c, { abort: abortSessionLane })));

    // intake pipeline — inert until an 'intake' agent exists in openclaw.json.
    // 5s, and it costs a small file read: discovery reads the gateway's own
    // session index off disk instead of spawning `openclaw sessions list`
    // (2.9s of CPU per call, previously every 15s — see channels/sessions.js).
    // Provisioning is the whole job now — no welcome message follows it (see
    // intake/provision.js), so there is nothing left to drain eagerly; the
    // regular 30s outbox_worker tick is enough.
    // runIntakeSweep, not withTx directly: provisioning writes a workspace and
    // a gateway agent entry that no ROLLBACK can take back, so the sweep owns
    // its own transaction and undoes those on the way out of a failure.
    arm('intake_sweep', () => intake.runIntakeSweep(pool, {
      configPath: OPENCLAW_CONFIG, readFirstMessage: intake.readIntakeFirstMessage,
    }));
    arm('reopen_sweep', () => withTx(pool, (c) => intake.sweepReopen(c)));
    // keep the intake greeter's open/closed text in sync with the flag
    const { syncIntakeWorkspace } = require('../src/intake/intake-workspace');
    const flagsDomain = require('../src/domain/flags');
    arm('intake_template_sync', async () => {
      if (!intake.intakeConfigured(OPENCLAW_CONFIG)) return { skipped: true };
      const open = (await flagsDomain.getFlag(pool, 'registration_open')) === true;
      return syncIntakeWorkspace(open);
    });
    // identity-hardening watchdog — every 10 minutes
    // `send` is the raw pipe, same as the credit alarm: the violations that
    // earn an alert are exactly the ones that stop agents working, so the
    // alert must not itself need a working agent.
    arm('config_guard', () => withTx(pool, (c) =>
      configGuard.run(c, { configPath: OPENCLAW_CONFIG, send: rawSend })));

    // Boost mode's reconciler — the ONLY writer of agents.defaults.model.
    // Armed unconditionally: it is what ENDS a boost, so it has to be running
    // even when nobody has turned one on. A tick with the switch off is one
    // flag read and a file read.
    const boostJob = require('../src/jobs/boost');
    arm('boost_reconcile', () => withTx(pool, (c) =>
      boostJob.run(c, { configPath: OPENCLAW_CONFIG })));

    // Weekly per user, but ticked hourly: "the small hours" is only meaningful
    // in each person's own timezone, so the job decides who is due rather than
    // the interval deciding for it.
    const { runSilentAgentTurn } = require('../src/channels/openclaw');
    arm('memory_consolidation', () => withTx(pool, (c) =>
      memoryConsolidation.sweepMemoryConsolidation(c, { runAgent: runSilentAgentTurn })));

    // Deep memory: read a finished conversation and write down what it taught
    // us. Ticked every 10 minutes rather than on the chapter boundary itself —
    // there is no event for "they stopped replying", so the job asks who has
    // been quiet for half an hour. Cheap when there is nothing to do: the
    // common tick is one indexed query plus a file read per candidate, and
    // only a user with genuinely unread messages costs a model turn.
    const factExtraction = require('../src/jobs/fact-extraction');
    const { refreshUserCard } = require('../src/intake/user-card');
    // Both direct-call jobs refresh cards AFTER the sweep's transaction
    // commits — the dashboard rule ("never inside it"), and here it is not
    // style: refreshUserCard reads on its OWN pool connection, which cannot
    // see rows the still-open transaction wrote. Wired inside the tx, every
    // card rendered without the very facts/plan the run just produced —
    // caught live on the planning pass's first real run, five plans written,
    // zero cards showing them. (The agent-turn era dodged this by accident:
    // the agent's tools committed their own transactions before the refresh.)
    const refreshAfter = async (userIds) => {
      for (const id of userIds) {
        try { await refreshUserCard(pool, id); } catch { /* card lags one run; not fatal */ }
      }
    };

    // Thinks over a direct model call (adapters/llm.js), not an agent turn —
    // no runAgent dep; the job's default is the real adapter.
    arm('fact_extraction', async () => {
      const out = await withTx(pool, (c) => factExtraction.sweepFactExtraction(c, {}));
      await refreshAfter(out.extracted || []);
      return out;
    });

    // A finished phone call gets the identical treatment on its own hangup —
    // see jobs/voice-calls.js. Inert (a directory-not-found no-op) on any box
    // without the voice bridge installed.
    const voiceCalls = require('../src/jobs/voice-calls');
    arm('voice_calls', async () => {
      const out = await withTx(pool, (c) => voiceCalls.sweepVoiceCalls(c, {}));
      await refreshAfter(out.processed || []);
      return out;
    });

    // The planning pass: overnight, per user, writes a forward plan into
    // USER.md via the card refresh. Sends nothing — the plan surfaces the
    // next time Olma would have spoken anyway (digest, checkin, live turn).
    const planning = require('../src/jobs/planning');
    arm('planning_sweep', async () => {
      const out = await withTx(pool, (c) => planning.sweepPlanning(c, {}));
      await refreshAfter(out.planned || []);
      return out;
    });

    // Behavioral evals: nightly scripted conversations against the eval
    // user, hard checks + a judge model, alerts on the credit-alarm pipe.
    // Inert until scripts/setup-eval-user.js has been run once on the box.
    const evals = require('../src/jobs/evals');
    arm('eval_sweep', () => evals.sweepEvals(pool, { send: rawSend }));

    // Live-update subscriptions ("עדכן אותי על...") — hourly tick, the rows
    // decide who is due. Detection is a structured-API diff (zero tokens);
    // the one cheap model call happens only when something actually changed.
    const liveUpdates = require('../src/domain/live-updates');
    arm('live_updates', () => withTx(pool, (c) => liveUpdates.sweepLiveUpdates(c, {})));

    // cost attribution + product analytics — hourly; retention — daily
    const usage = require('../src/jobs/usage');
    const metrics = require('../src/jobs/metrics');
    const retention = require('../src/jobs/retention');
    arm('usage_sweep', () => withTx(pool, (c) => usage.sweepUsage(c)));
    // per-call voice cost, from Twilio's own pricing (see jobs/voice-usage.js)
    const voiceUsage = require('../src/jobs/voice-usage');
    arm('voice_usage_sweep', () => withTx(pool, (c) => voiceUsage.sweepVoiceUsage(c)));
    arm('metrics_sweep', () => withTx(pool, (c) => metrics.sweepMetrics(c)));
    arm('retention_sweep', () => withTx(pool, (c) => retention.sweepRetention(c)));
    console.log('[brokerd] outbox worker + sweeps armed');
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
