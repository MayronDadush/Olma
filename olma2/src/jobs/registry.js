'use strict';
// Every job brokerd arms, as data: the name (its job_heartbeats row and its
// cadence in ./expectations.js) and the function one tick runs. This used
// to be two hundred lines of arm() calls inside bin/olma-brokerd.js; the
// daemon now builds this list and loops over it, and nothing else in the
// process knows the jobs by name.
//
// The cadence stays in expectations.js on purpose — /health and the
// dashboard read it too, and the incident behind that file was two tables
// describing one fact. tests/job-registry.test.js holds the two lists
// together: every job here has a cadence, every cadence names a job here
// (or is in the short list of rows written by something other than this
// daemon).
//
// The comments on each entry are the original ones, moved with the code —
// each explains why that job ticks at the rate it does and on the pipe it
// does; the stories behind them are in docs/incidents.md.
const { withTx } = require('../db/pool');
const { drainOnce } = require('../outbox/worker');
const { makeDeliverer } = require('../channels/openclaw');
const checkin = require('./checkin');
const sweeps = require('./sweeps');
const intake = require('./intake');
const configGuard = require('./config-guard');
const unanswered = require('./unanswered');
const laneWatchdog = require('./lane-watchdog');
const memoryConsolidation = require('./memory-consolidation');
const { DEFAULT_PATH: OPENCLAW_CONFIG } = require('../intake/openclaw-config');

// jobs({ pool }) -> [{ name, run }] in arming order.
function jobs({ pool }) {
  const deliver = makeDeliverer(pool);
  // The credit-out alarm rides the worker's own tick (no sweeper of its
  // own) and the raw pipe (no model, no credit needed) — see
  // jobs/credit-watch.js for why both choices are the point.
  const creditWatch = require('./credit-watch');
  const efficiencyWatch = require('./efficiency-watch');
  const { runOpenclaw } = require('../channels/openclaw');
  const rawSend = (phone, text) => runOpenclaw([
    'message', 'send', '--channel', 'whatsapp', '--target', phone, '--message', text,
  ]);
  // Free lanes the gateway has classified stuck and then declined to free.
  // 30s, because this is the difference between a person waiting ~90s and a
  // person waiting until unanswered_sweep notices minutes later.
  const { abortSessionLane } = require('../channels/openclaw');
  // keep the intake greeter's open/closed text in sync with the flag
  const { syncIntakeWorkspace } = require('../intake/intake-workspace');
  const flagsDomain = require('../domain/flags');
  // identity-hardening watchdog — every 10 minutes
  // `send` is the raw pipe, same as the credit alarm: the violations that
  // earn an alert are exactly the ones that stop agents working, so the
  // alert must not itself need a working agent.
  // `validateConfig` is supplied here and nowhere else: it shells out to the
  // openclaw CLI, so no test can spawn it by accident.
  const validateConfig = configGuard.makeConfigValidator();
  // Boost mode's reconciler — the ONLY writer of agents.defaults.model.
  // Armed unconditionally: it is what ENDS a boost, so it has to be running
  // even when nobody has turned one on. A tick with the switch off is one
  // flag read and a file read.
  const boostJob = require('./boost');
  // Weekly per user, but ticked hourly: "the small hours" is only meaningful
  // in each person's own timezone, so the job decides who is due rather than
  // the interval deciding for it.
  const { runSilentAgentTurn } = require('../channels/openclaw');
  // Deep memory: read a finished conversation and write down what it taught
  // us. Ticked every 10 minutes rather than on the chapter boundary itself —
  // there is no event for "they stopped replying", so the job asks who has
  // been quiet for half an hour. Cheap when there is nothing to do: the
  // common tick is one indexed query plus a file read per candidate, and
  // only a user with genuinely unread messages costs a model turn.
  const factExtraction = require('./fact-extraction');
  const { refreshUserCard } = require('../intake/user-card');
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
  // A finished phone call gets the identical treatment on its own hangup —
  // see jobs/voice-calls.js. Inert (a directory-not-found no-op) on any box
  // without the voice bridge installed.
  const voiceCalls = require('./voice-calls');
  // The planning pass: overnight, per user, writes a forward plan into
  // USER.md via the card refresh. Sends nothing — the plan surfaces the
  // next time Olma would have spoken anyway (digest, checkin, live turn).
  const planning = require('./planning');
  // Dated tasks onto the user's own calendar, for the people who asked for
  // it. Deliberately not inside add_task: Google must never be in the path
  // of saving a task (see domain/task-calendar.js).
  const taskCalendar = require('../domain/task-calendar');
  // Behavioral evals: nightly scripted conversations against the eval
  // user, hard checks + a judge model, alerts on the credit-alarm pipe.
  // Inert until scripts/setup-eval-user.js has been run once on the box.
  const evals = require('./evals');
  // Live-update subscriptions ("עדכן אותי על...") — hourly tick, the rows
  // decide who is due. Detection is a structured-API diff (zero tokens);
  // the one cheap model call happens only when something actually changed.
  const liveUpdates = require('../domain/live-updates');
  // cost attribution + product analytics — hourly; retention — daily
  const usage = require('./usage');
  const metrics = require('./metrics');
  const retention = require('./retention');
  // per-call voice cost, from Twilio's own pricing (see jobs/voice-usage.js)
  const voiceUsage = require('./voice-usage');
  // Is the box running what `main` says it should be? A merge whose CI run
  // was cancelled or wedged skips its own deploy, and until now that gap
  // was completely silent — #140, the fix for exactly that, sat undeployed
  // for a day for exactly that reason. A dashboard row, never an alarm:
  // running the previous release breaks nobody's tool calls.
  const deployDrift = require('./deploy-drift');

  return [
    { name: 'outbox_worker', run: async () => {
      const out = await drainOnce(pool, deliver);
      const alert = await withTx(pool, (c) => creditWatch.checkCreditAlert(c, { send: rawSend }))
        .catch(() => ({ alerted: false }));
      // A night outage is queued rather than sent at 03:00; this is what
      // delivers it when morning comes, on the same beat.
      const flushed = await withTx(pool, (c) => creditWatch.flushPendingCreditAlert(c, { send: rawSend }))
        .catch(() => null);
      if (flushed && flushed.alerted) return { ...out, creditAlert: flushed.phone, deferred: true };
      return alert.alerted ? { ...out, creditAlert: alert.phone } : out;
    } },
    // The runway warning, on the same raw pipe as the outage alarm above it but
    // NOT on the same beat: this one costs three calls to external billing APIs,
    // and a balance measured in days does not change between 30-second ticks.
    // Six-hourly is a warning that reaches you the same morning without ever
    // being a poll. Tier bookkeeping inside makes repeat ticks silent.
    { name: 'balance_watch', run: () =>
      withTx(pool, (c) => creditWatch.checkBalanceForecast(c, { send: rawSend })) },
    // The efficiency watch: cost and token ratios against this system's own
    // recent normal, reported with the evidence and a recommendation, never
    // applied. Six-hourly like the runway warning and for the same reason —
    // the ratios it reads are per-DAY, so a faster beat cannot produce a new
    // answer, only a repeated one. It borrows credit-watch's own night rule:
    // nothing here can be acted on at 03:00 and it reads the same at 09:00.
    { name: 'efficiency_watch', run: () => withTx(pool, (c) => efficiencyWatch.run(c, {
      send: rawSend,
      alertHourOpen: creditWatch.alertHourOpen,
      // Measured, not assumed: the brief's one useful lever is "the prompt got
      // bigger", and the number has to be the CURRENT rendered size, not a
      // constant somebody updates by hand. Read fresh — six-hourly, one file.
      promptChars: (() => {
        try { return require('../intake/provision').renderAgentsMd('olma_tok_' + '0'.repeat(32)).length; }
        catch { return null; }
      })(),
    })) },
    // One tick for the minute-sweeps. They were separate intervals firing
    // on the same second, each taking its own connection and transaction, to
    // do work that is almost always "nothing due" — three times the wake-ups
    // for one tick's worth of results.
    { name: 'minute_sweeps', run: () => withTx(pool, async (c) => ({
      reminders: await sweeps.sweepReminders(c),
      digests: await sweeps.sweepDigests(c),
      unblocks: await sweeps.sweepUnblocks(c),
      staleMeetings: await sweeps.sweepStaleMeetings(c),
      mediaJobs: await sweeps.sweepMediaJobs(c),
      // 60s cadence is what makes a 60-second nudge possible at all — the
      // checkin ladder's own tick (below) is 5 minutes, chosen for its
      // 15-minute floor, and would land this one anywhere up to 6x late.
      nameConfirm: await sweeps.sweepNameConfirm(c),
      // Cheap (two indexed queries that are almost always empty) and it rides
      // this tick rather than owning one. It is not urgent — a task whose
      // moment passed can leave the list a minute later — but the grace window
      // it enforces is measured in hours, so anything slower would make the
      // window meaningfully longer than the flag says it is.
      finishedTasks: await sweeps.sweepFinishedTasks(c),
    })) },
    // checkin ladder — every 5 minutes, because day one has a 15-minute step
    // and an hourly tick would land it anywhere up to an hour late. Cheap: one
    // query plus a filter, and idempotency keys make re-runs no-ops.
    { name: 'checkin_ladder', run: () => withTx(pool, (c) => checkin.run(c)) },
    // repair pass for messages the gateway dropped — see jobs/unanswered.js
    { name: 'unanswered_sweep', run: () => withTx(pool, (c) => unanswered.sweepUnanswered(c)) },
    { name: 'lane_watchdog', run: () =>
      withTx(pool, (c) => laneWatchdog.sweepLaneWatchdog(c, { abort: abortSessionLane })) },
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
    { name: 'intake_sweep', run: () => intake.runIntakeSweep(pool, {
      configPath: OPENCLAW_CONFIG, readFirstMessage: intake.readIntakeFirstMessage,
    }) },
    { name: 'reopen_sweep', run: () => withTx(pool, (c) => intake.sweepReopen(c)) },
    { name: 'intake_template_sync', run: async () => {
      if (!intake.intakeConfigured(OPENCLAW_CONFIG)) return { skipped: true };
      const open = (await flagsDomain.getFlag(pool, 'registration_open')) === true;
      return syncIntakeWorkspace(open);
    } },
    { name: 'config_guard', run: () => withTx(pool, (c) =>
      configGuard.run(c, { configPath: OPENCLAW_CONFIG, send: rawSend, validateConfig })) },
    { name: 'boost_reconcile', run: () => withTx(pool, (c) =>
      boostJob.run(c, { configPath: OPENCLAW_CONFIG })) },
    { name: 'memory_consolidation', run: () => withTx(pool, (c) =>
      memoryConsolidation.sweepMemoryConsolidation(c, { runAgent: runSilentAgentTurn })) },
    // Thinks over a direct model call (adapters/llm.js), not an agent turn —
    // no runAgent dep; the job's default is the real adapter.
    { name: 'fact_extraction', run: async () => {
      const out = await withTx(pool, (c) => factExtraction.sweepFactExtraction(c, {}));
      await refreshAfter(out.extracted || []);
      return out;
    } },
    { name: 'voice_calls', run: async () => {
      const out = await withTx(pool, (c) => voiceCalls.sweepVoiceCalls(c, {}));
      await refreshAfter(out.processed || []);
      return out;
    } },
    { name: 'planning_sweep', run: async () => {
      const out = await withTx(pool, (c) => planning.sweepPlanning(c, {}));
      await refreshAfter(out.planned || []);
      return out;
    } },
    { name: 'task_calendar', run: () => withTx(pool, (c) => taskCalendar.sweepTaskCalendar(c, {})) },
    { name: 'eval_sweep', run: () => evals.sweepEvals(pool, { send: rawSend }) },
    { name: 'live_updates', run: () => withTx(pool, (c) => liveUpdates.sweepLiveUpdates(c, {})) },
    { name: 'usage_sweep', run: () => withTx(pool, (c) => usage.sweepUsage(c)) },
    { name: 'voice_usage_sweep', run: () => withTx(pool, (c) => voiceUsage.sweepVoiceUsage(c)) },
    { name: 'metrics_sweep', run: () => withTx(pool, (c) => metrics.sweepMetrics(c)) },
    { name: 'retention_sweep', run: () => withTx(pool, (c) => retention.sweepRetention(c)) },
    { name: 'deploy_drift', run: () => withTx(pool, (c) => deployDrift.sweepDeployDrift(c)) },
  ];
}

module.exports = { jobs };
