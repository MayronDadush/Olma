'use strict';
// The nightly behavioral eval sweep. Ticked hourly by brokerd like every slow
// job; runs once per night inside the small-hours window, walks every
// scenario sequentially (one lane, one 1-vCPU box), persists results, and
// alerts the operator on the two channels agreed 2026-08-27:
//
//   RED (a hard check failed) or ERROR (the harness itself broke)
//     → WhatsApp immediately, on the same raw pipe as the credit alarm.
//       An error is never silently green — a broken checker that looks
//       healthy is the /health-was-red-for-13-hours failure all over again.
//   YELLOW (judge concern) → WhatsApp only on the SECOND consecutive bad
//       night for the same scenario. Judge scores wobble between runs; an
//       alert that fires on wobble teaches the reader to ignore alerts.
//
// Everything lands in eval_runs / eval_results either way — the dashboard
// shows the full picture, the alert only carries what deserves waking someone.
const { withTx } = require('../db/pool');
const flagsDomain = require('../domain/flags');
const harness = require('../evals/harness');
const { SCENARIOS } = require('../evals/scenarios');

const LAST_RUN_FLAG = 'evals_last_run_date';
// 00:00-02:59 UTC = 03:00-05:59 Israel — after the planning pass, before
// anyone wakes up. A flag can move it without a deploy.
const WINDOW_UTC_HOURS = [0, 1, 2];

function utcDateOf(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function inWindow(now) {
  return WINDOW_UTC_HOURS.includes(new Date(now).getUTCHours());
}

// A run that deliberately drove a CANDIDATE model instead of the live
// default. Its results describe that model, never production — so it is
// excluded from the two-consecutive-nights rule and from the dashboard's
// headline. Both exclusions key on this one label.
const PILOT_TRIGGER = 'pilot';

// The previous persisted result for a scenario, EXCLUDING the given run —
// what the two-consecutive-nights rule compares against.
//
// Pilot runs are skipped: a candidate model going yellow says nothing about
// the model users are actually on, and counting it would let an afternoon
// experiment turn the next real night into a false "second night in a row"
// alert — the alert-fatigue failure the two-night rule exists to prevent.
async function previousStatus(client, scenario, beforeRunId) {
  const { rows } = await client.query(
    `SELECT r.status FROM eval_results r
       JOIN eval_runs u ON u.id = r.run_id
      WHERE r.scenario = $1 AND r.run_id < $2 AND u.trigger <> $3
      ORDER BY r.id DESC LIMIT 1`,
    [scenario, beforeRunId, PILOT_TRIGGER]
  );
  return rows[0] ? rows[0].status : null;
}

function alertText(summary) {
  const lines = ['🧪 אולמה: בדיקת ההתנהגות הלילית מצאה בעיות.'];
  for (const r of summary.alerts) {
    if (r.status === 'red') {
      const why = r.hardFailures.map((f) => f.name).join('; ') || 'hard check failed';
      lines.push(`🔴 ${r.scenario}: ${why}`);
    } else if (r.status === 'error') {
      lines.push(`⚠️ ${r.scenario}: הבדיקה עצמה נשברה (${r.error || (r.judge && r.judge.error) || 'unknown'})`);
    } else {
      const why = (r.judge && r.judge.problems && r.judge.problems[0] && r.judge.problems[0].rule) || 'איכות טקסט';
      lines.push(`🟡 ${r.scenario}: לילה שני ברצף — ${why}`);
    }
  }
  lines.push('הפירוט המלא בדשבורד, בקטע Evals.');
  return lines.join('\n');
}

// Run the whole suite and persist. Shared by the nightly sweep and the manual
// script — the ONLY difference between them is the trigger label and the
// window/watermark gate.
async function runEvalSuite(pool, { trigger = 'nightly', deps = {}, scenarios = SCENARIOS } = {}) {
  const user = await withTx(pool, (c) => harness.getEvalUser(c));
  if (!user) return { skipped: 'no eval user — run scripts/setup-eval-user.js on the server' };

  const { rows: runRows } = await pool.query(
    `INSERT INTO eval_runs (trigger, scenarios) VALUES ($1, $2) RETURNING id`,
    [trigger, scenarios.length]
  );
  const runId = Number(runRows[0].id);

  const results = [];
  for (const scenario of scenarios) {
    const r = await harness.runScenario(pool, user, scenario, deps);
    results.push(r);
    // Persisted per scenario, not at the end — a crash mid-run leaves what DID
    // run visible instead of a night that looks like it never happened.
    await pool.query(
      `INSERT INTO eval_results (run_id, scenario, status, hard_failures, judge, reply, duration_ms, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [runId, r.scenario, r.status, JSON.stringify(r.hardFailures || []),
        r.judge ? JSON.stringify(r.judge) : null, r.reply, r.durationMs,
        r.snapshot ? JSON.stringify(r.snapshot) : null]
    );
  }

  const tally = { green: 0, yellow: 0, red: 0, error: 0 };
  for (const r of results) tally[r.status]++;
  const agentModel = (results.find((r) => r.model) || {}).model || null;
  await pool.query(
    `UPDATE eval_runs SET finished_at = now(), greens = $2, yellows = $3, reds = $4,
            errors = $5, agent_model = $6 WHERE id = $1`,
    [runId, tally.green, tally.yellow, tally.red, tally.error, agentModel]
  );

  // What earns an alert: reds and errors always; yellows only on the second
  // consecutive bad night for that same scenario.
  const alerts = [];
  for (const r of results) {
    if (r.status === 'red' || r.status === 'error') { alerts.push(r); continue; }
    if (r.status === 'yellow') {
      const prev = await withTx(pool, (c) => previousStatus(c, r.scenario, runId));
      if (prev === 'yellow' || prev === 'red') alerts.push(r);
    }
  }
  return { runId, trigger, tally, alerts, results };
}

// The brokerd job. deps.send(phone, text) is the raw pipe (same as the credit
// alarm — no model, no agent turn, works even when the model provider is
// down, which is precisely when evals will be failing).
async function sweepEvals(pool, deps = {}) {
  const now = deps.now || Date.now();
  if (!inWindow(now)) return { skipped: 'outside window' };
  const today = utcDateOf(now);
  const last = await withTx(pool, (c) => flagsDomain.getFlag(c, LAST_RUN_FLAG));
  if (last === today) return { skipped: 'already ran tonight' };
  // Stamped at START on purpose: a suite that crashes must not re-run in a
  // loop every hourly tick all night — the ERR heartbeat is the signal there.
  await withTx(pool, (c) => flagsDomain.setFlag(c, LAST_RUN_FLAG, today));

  const summary = await runEvalSuite(pool, { trigger: 'nightly', deps });
  if (summary.skipped) return summary;

  if (summary.alerts.length && deps.send) {
    const phone = (await withTx(pool, (c) => flagsDomain.getFlag(c, 'admin_alert_phone')))
      || require('./credit-watch').DEFAULT_ALERT_PHONE;
    const sent = await deps.send(phone, alertText(summary));
    summary.alerted = Boolean(sent && sent.ok);
  }
  return {
    runId: summary.runId, ...summary.tally,
    alerted: summary.alerted || false, alerts: summary.alerts.length,
  };
}

module.exports = {
  sweepEvals, runEvalSuite, alertText, previousStatus, inWindow,
  LAST_RUN_FLAG, WINDOW_UTC_HOURS, PILOT_TRIGGER,
};
