#!/usr/bin/env node
// Manual eval run — the "before a doctrine change" half of the cadence
// (nightly is jobs/evals.js). Same suite, same persistence, no window gate
// and no WhatsApp alert: whoever runs this is already looking at the output.
//
// Usage (on the server):
//   node scripts/run-evals.js                 # full suite
//   node scripts/run-evals.js --only stop-service,goal-capture
//   node scripts/run-evals.js --no-judge      # hard checks only (faster/cheaper)
//   node scripts/run-evals.js --model openrouter/qwen/qwen3.7-flash --only stop-service,goal-capture,bare-time-shift,hebrew-gender-feminine
//   node scripts/run-evals.js --model openrouter/qwen/qwen3.7-flash --full   # every scenario, after the smoke set passed
//
// --model is the CHEAPER-MODEL PILOT: it drives the whole suite on a
// candidate model instead of the live default, which turns nine real
// incidents into a scored comparison — tool selection, Hebrew gender, and
// doctrine, the three things a price list cannot tell you. It changes no
// routing: the override rides one disposable session per scenario, on the
// sealed eval user, exactly like scripts/model-pilot.js. The run is labelled
// trigger='pilot' so it can never head the dashboard or feed the nightly
// two-consecutive-nights alert rule.
//
// Exits non-zero on any red or error, so it can gate a manual deploy.
'use strict';
const { createPool } = require('../src/db/pool');
const { runEvalSuite, PILOT_TRIGGER } = require('../src/jobs/evals');
const { SCENARIOS } = require('../src/evals/scenarios');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const ICONS = { green: '🟢', yellow: '🟡', red: '🔴', error: '⚠️' };
// The scenarios a candidate model has actually failed before (docs/
// model-experiments.md): a skipped turn_start on the confirmation turn, a
// missed capture, a bare time read in the wrong zone, one masculine verb.
// A model that survives these has earned the other nine.
const SMOKE = ['stop-service', 'goal-capture', 'bare-time-shift', 'hebrew-gender-feminine'];

(async () => {
  const only = arg('only');
  const scenarios = only
    ? SCENARIOS.filter((s) => only.split(',').includes(s.id))
    : SCENARIOS;
  if (!scenarios.length) {
    console.error(`no scenario matches --only ${only}; known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const model = arg('model');
  // A full pilot is twelve scenarios, three or four calls each on the
  // candidate plus a reasoning judge on every reply, and it is the single
  // largest line on the bill: the eval user cost $7.31 in the four days to
  // 2026-09-09 against $2.49 for every real person together — gpt-5-mini
  // $1.65, gpt-5-nano $1.46 and claude-haiku-4.5 $2.26 for one full run
  // each (usage_ledger, user 15). Two of the three were disqualified by
  // their third scenario. So a pilot starts on the smoke set — the four
  // scenarios that have failed a candidate before — and earns the rest.
  if (model && !only && !process.argv.includes('--full')) {
    console.error(`a full pilot on ${model} runs all ${SCENARIOS.length} scenarios and the judge — $1.5–2.3 for the last three candidates.`);
    console.error(`start with the smoke set:  --only ${SMOKE.join(',')}`);
    console.error('and pass --full for the whole suite once it survives that. --no-judge drops the judge (hard checks only).');
    process.exit(2);
  }
  const pool = createPool();
  if (model) console.log(`pilot: driving ${scenarios.length} scenario(s) on ${model} (live routing untouched)\n`);
  const summary = await runEvalSuite(pool, {
    trigger: model ? PILOT_TRIGGER : 'manual', scenarios,
    deps: { skipJudge: process.argv.includes('--no-judge'), agentModel: model },
  });
  if (summary.skipped) { console.error(summary.skipped); await pool.end(); process.exit(1); }

  for (const r of summary.results) {
    console.log(`${ICONS[r.status]} ${r.scenario}  (${Math.round(r.durationMs / 1000)}s)`);
    for (const f of r.hardFailures || []) console.log(`     ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    for (const p of (r.judge && r.judge.problems) || []) console.log(`     ~ ${p.rule}: "${p.quote}"`);
    if (r.error || (r.judge && r.judge.error)) console.log(`     ! ${r.error || r.judge.error}`);
  }
  const t = summary.tally;
  console.log(`\nrun ${summary.runId}: ${t.green} green · ${t.yellow} yellow · ${t.red} red · ${t.error} error`);
  // The model the gateway REPORTS, not the one asked for — an override that
  // silently fell back to the default would otherwise be recorded as a
  // passing pilot for a model that never ran.
  const reported = (summary.results.find((r) => r.model) || {}).model;
  const wall = Math.round(summary.results.reduce((s, r) => s + (r.durationMs || 0), 0) / 1000);
  console.log(`model actually used: ${reported || 'unknown'} · ${wall}s total`);
  if (model && reported && !reported.includes(model.replace(/^openrouter\//, ''))) {
    console.log(`⚠ asked for ${model} but the turns ran on ${reported} — the override did not take`);
  }
  await pool.end();
  process.exit(t.red + t.error > 0 ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
