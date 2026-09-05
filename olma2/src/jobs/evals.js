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
const preferences = require('../domain/preferences');
const { withinWindow } = require('../outbox/gate');

// The operator's zone, for deciding whether it is a civil hour to be told
// something. Not the server's — the server runs in UTC and would put the
// morning three hours early.
const ALERT_TZ = 'Asia/Jerusalem';

const LAST_RUN_FLAG = 'evals_last_run_date';
// 00:00-02:59 UTC = 03:00-05:59 Israel — after the planning pass, before
// anyone wakes up. A flag can move it without a deploy.
const WINDOW_UTC_HOURS = [0, 1, 2];

// Where a night's alert waits until morning. The suite still runs at 03:00 —
// it is cheap, the box is quiet, and the results are ready by breakfast — but
// the ALERT no longer goes out at 03:50.
//
// The reason it used to is written above: the raw pipe works when the model
// provider is down, which is exactly when evals fail. That reasoning is
// sound and is why the pipe is KEPT here rather than swapped for the outbox
// (outbox delivery runs `openclaw agent --deliver`, a model turn — it cannot
// deliver the news that the model is broken). What was wrong was not the
// channel but the hour: a scenario going red is not an outage. Nothing is
// burning, nobody is unreachable, and it reads the same at 08:00 as at 03:50.
// The genuine "everything is down" signal is credit-watch, which is separate
// and still immediate.
const PENDING_ALERT_FLAG = 'evals_pending_alert';

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
  const lines = ['🧪 עולמה: בדיקת ההתנהגות הלילית מצאה בעיות.'];
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
// Is the operator reachable at a civil hour? Deliberately the SAME window
// every user's proactive messages obey (preferences.DEFAULT_WINDOW, in the
// operator's own zone) rather than a second hand-picked pair of numbers —
// there is no reason the person running Olma deserves less consideration
// than the people using it.
function alertHoursOpen(now) {
  return withinWindow(preferences.DEFAULT_WINDOW, ALERT_TZ, new Date(now));
}

// Send a night's alert once morning comes. Runs on every hourly tick, not
// only inside the eval window, because the whole point is that it fires
// hours after the run that produced it.
//
// Cleared only on a CONFIRMED send: a failed pipe leaves the row pending and
// tries again next hour, which is the behaviour an alert has to have. The
// newest night overwrites an undelivered older one on purpose — the latest
// run is the current state of the system, and delivering a stale verdict
// beside a fresh one invites reading the wrong one.
async function flushPendingAlert(pool, deps, now) {
  if (!deps.send) return null;
  const raw = await withTx(pool, (c) => flagsDomain.getFlag(c, PENDING_ALERT_FLAG));
  if (!raw) return null;
  if (!alertHoursOpen(now)) return { held: 'quiet hours' };
  let pending;
  try { pending = JSON.parse(raw); } catch { pending = null; }
  if (!pending || !pending.text) {
    await withTx(pool, (c) => flagsDomain.setFlag(c, PENDING_ALERT_FLAG, ''));
    return { dropped: 'unreadable' };
  }
  // An alert delayed past its own night says so, rather than reading as
  // last night's when it is in fact Tuesday's.
  const stale = pending.date && pending.date !== utcDateOf(now);
  const text = stale ? `(מהריצה של ${pending.date})\n${pending.text}` : pending.text;
  const sent = await deps.send(pending.phone, text);
  if (!(sent && sent.ok)) return { held: 'send failed' };
  await withTx(pool, (c) => flagsDomain.setFlag(c, PENDING_ALERT_FLAG, ''));
  return { alerted: true, runId: pending.runId, deferredFrom: pending.date };
}

async function sweepEvals(pool, deps = {}) {
  const now = deps.now || Date.now();
  // Before anything else, and outside the run window: a queued alert from
  // 03:00 is delivered by the tick that first finds the morning open.
  const flushed = await flushPendingAlert(pool, deps, now);
  if (!inWindow(now)) return { skipped: 'outside window', ...(flushed || {}) };
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
    // Queued, not sent. At 03:50 nobody should be woken by a scenario going
    // red; flushPendingAlert delivers it on the first tick after 08:00. If
    // the run happens to finish inside civil hours (a manual sweep, or a
    // moved window) that same call sends it immediately, so nothing is
    // delayed that did not need to be.
    await withTx(pool, (c) => flagsDomain.setFlag(c, PENDING_ALERT_FLAG, JSON.stringify({
      text: alertText(summary), phone, runId: summary.runId, date: today,
    })));
    const now2 = deps.now || Date.now();
    const out = await flushPendingAlert(pool, deps, now2);
    summary.alerted = Boolean(out && out.alerted);
    summary.alertQueued = !summary.alerted;
  }
  return {
    runId: summary.runId, ...summary.tally,
    alerted: summary.alerted || false, alerts: summary.alerts.length,
    // Distinguishes "nothing to say" from "said, but not until morning" —
    // without it the heartbeat reads a queued alert as no alert at all.
    alertQueued: Boolean(summary.alertQueued),
  };
}

module.exports = {
  sweepEvals, runEvalSuite, alertText, previousStatus, inWindow,
  flushPendingAlert, alertHoursOpen,
  LAST_RUN_FLAG, WINDOW_UTC_HOURS, PILOT_TRIGGER, PENDING_ALERT_FLAG, ALERT_TZ,
};
