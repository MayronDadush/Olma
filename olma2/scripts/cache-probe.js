#!/usr/bin/env node
'use strict';
// Did the prompt cache survive the gap between two of a person's messages?
//
//   node scripts/cache-probe.js [--days 7] [--agent u-3] [--since 2026-09-09]
//                               [--all-agents] [--json]
//
// Run it ON THE BOX. It reads the gateway's per-agent transcripts and nothing
// else — read-only, no model call, no cost, safe on a live box.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `scripts/pin-openrouter-provider.js` was applied on 2026-09-09 to stop
// OpenRouter serving the same model from three providers in six hours, since a
// prefix cache is per provider. Its own header left the verification open:
//
//   "cache: whether ONE provider's prefix cache survives the minutes between a
//    person's messages. Nobody knows until it runs a day; read `cacheRead` on
//    first-of-turn calls in the transcripts."
//
// This is that reading. The pre-pin baseline it is measured against, from
// `docs/incidents.md`, "The conversation that never ended" — first call of a
// turn, bucketed by the gap since the agent's previous call, real users only:
//
//   under 2 minutes  62% cached
//   2–10 minutes      9%
//   10–60 minutes     4%
//   1–4 hours         0%
//   second call of the same turn ~90%
//
// ── The one distinction that makes this measurement mean anything ───────────
// The FIRST call of a turn is the only one that answers the question. The
// second call of a turn hits ~90% whatever the provider does, because it
// follows its own first call by seconds — averaging the two together reports a
// healthy number for a cache that is dead where it matters. So a call counts
// as first-of-turn only when a user-role message sits between it and the
// previous assistant call, and the two populations are printed apart.
//
// `usage_ledger` cannot answer this: jobs/usage.js buckets by
// (user, UTC date, model) and discards the per-call timestamps at that point.
// The transcripts are the only place the gap survives.
//
// ── Reading the output ──────────────────────────────────────────────────────
// `cached` is cacheRead / (input + cacheRead + cacheWrite) — the share of the
// prompt that was not paid for at full rate. A falling number has two opposite
// causes (the cached part shrank, or the uncached part grew), which is the
// mistake recorded in docs/model-experiments.md, so `avg prompt` is printed
// beside it: read them together or not at all.
//
// Anything with fewer than MIN_CALLS calls prints its count and no rate — a
// bucket of three calls is not a measurement.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const HOME = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
const MIN_CALLS = 5;

// Gaps since the agent's previous call. The first bucket is the "same
// conversation, still typing" case; the last is a cold start by any TTL.
const BUCKETS = [
  { label: '< 2 min', max: 2 * 60e3 },
  { label: '2–10 min', max: 10 * 60e3 },
  { label: '10–60 min', max: 60 * 60e3 },
  { label: '1–4 h', max: 4 * 3600e3 },
  { label: '> 4 h', max: Infinity },
];

// The pre-pin reading, so the output compares itself instead of leaving the
// arithmetic to whoever is looking. Keyed by bucket label.
const BASELINE = { '< 2 min': 62, '2–10 min': 9, '10–60 min': 4, '1–4 h': 0 };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// A real person's agent. `main`, `intake`, `ggreet` and `g-N` are Olma talking
// to herself or to a room; `probe`, `agent-test` and anything `-test` is ours.
//
// The eval user is excluded from every ratio here, and that is not a detail:
// its traffic is a benchmark whose shape belongs to whatever model is on
// trial, and it is 1,609 of 4,899 calls with a cache rate 20 points above
// everybody else — averaged in, it reports a healthy cache for real people who
// do not have one. Same rule as efficiency-watch (CLAUDE.md, "A ratio's
// numerator and its denominator must describe the SAME people"). Which agent
// that is comes from `--eval-agents`, and the list is PRINTED with the output,
// because a default that silently goes stale is how the wrong population gets
// measured for a week.
const DEFAULT_EVAL_AGENTS = ['u-15'];

function isUserAgent(id) {
  return /^u-\d+$/.test(id);
}

function agentDbPath(agentId) {
  return path.join(HOME, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
}

function listAgents({ all, skip }) {
  const dir = path.join(HOME, 'agents');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    console.error(`cannot read ${dir}: ${err.message}`);
    process.exit(1);
  }
  return names
    .filter((n) => (all ? true : isUserAgent(n)))
    .filter((n) => !skip.includes(n))
    .filter((n) => fs.existsSync(agentDbPath(n)))
    .sort();
}

// One transcript event → the billable call it describes, or null.
// Mirrors channels/sessions.js `usageCallOf`; kept local so the probe can run
// from /tmp on a box whose /opt/olma2 is a different release.
function callOf(o) {
  const m = o && o.message;
  if (!m || m.role !== 'assistant' || !m.usage) return null;
  const u = m.usage;
  const input = Number(u.input) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  if (input + cacheRead + cacheWrite === 0) return null;
  return {
    at: o.timestamp ? Date.parse(o.timestamp) : null,
    model: m.responseModel || m.model || '',
    input,
    cacheRead,
    cacheWrite,
    output: Number(u.output) || 0,
  };
}

function isUserTurn(o) {
  const m = o && o.message;
  return !!m && m.role === 'user';
}

// Every call in one agent's transcripts, in time order, each marked with
// whether a person spoke since the previous call.
function callsFor(agentId, sinceMs) {
  let db;
  try {
    db = new DatabaseSync(agentDbPath(agentId), { readOnly: true });
  } catch {
    return [];
  }
  const out = [];
  try {
    const rows = db.prepare(
      'SELECT session_id, seq, event_json FROM transcript_events ORDER BY session_id, seq'
    ).all();
    // Sessions are walked separately (seq only orders within one), then the
    // whole agent is re-sorted by clock: the gap that matters is since the
    // agent's previous call, whichever session it belonged to.
    let sawUser = false;
    let lastSession = null;
    for (const r of rows) {
      if (r.session_id !== lastSession) { sawUser = true; lastSession = r.session_id; }
      let ev;
      try { ev = JSON.parse(r.event_json); } catch { continue; }
      if (isUserTurn(ev)) { sawUser = true; continue; }
      const call = callOf(ev);
      if (!call) continue;
      call.firstOfTurn = sawUser;
      sawUser = false;
      if (call.at && (!sinceMs || call.at >= sinceMs)) out.push(call);
    }
  } finally {
    db.close();
  }
  out.sort((a, b) => a.at - b.at);
  // The gap is per agent, so it is computed after the re-sort.
  let prev = null;
  for (const c of out) {
    c.gapMs = prev == null ? Infinity : c.at - prev;
    prev = c.at;
  }
  return out;
}

function bucketOf(gapMs) {
  for (const b of BUCKETS) if (gapMs < b.max) return b.label;
  return BUCKETS[BUCKETS.length - 1].label;
}

function blank() {
  return { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
}

function add(acc, c) {
  acc.calls += 1;
  acc.input += c.input;
  acc.cacheRead += c.cacheRead;
  acc.cacheWrite += c.cacheWrite;
}

function rate(acc) {
  const prompt = acc.input + acc.cacheRead + acc.cacheWrite;
  return prompt ? acc.cacheRead / prompt : null;
}

function avgPrompt(acc) {
  return acc.calls ? Math.round((acc.input + acc.cacheRead + acc.cacheWrite) / acc.calls) : 0;
}

function pct(x) {
  return x == null ? ' —' : `${(x * 100).toFixed(0)}%`;
}

function main() {
  const days = Number(arg('days', '7'));
  const sinceArg = arg('since');
  const sinceMs = sinceArg ? Date.parse(sinceArg) : Date.now() - days * 86400e3;
  const only = arg('agent');
  const all = process.argv.includes('--all-agents');
  const skip = process.argv.includes('--include-eval')
    ? []
    : (arg('eval-agents') ? arg('eval-agents').split(',').map((s2) => s2.trim()).filter(Boolean) : DEFAULT_EVAL_AGENTS);

  const agents = only ? [only] : listAgents({ all, skip });
  if (!agents.length) {
    console.error('no agent transcripts found — run this on the box');
    process.exit(1);
  }

  const first = new Map();
  const later = new Map();
  for (const b of BUCKETS) { first.set(b.label, blank()); later.set(b.label, blank()); }
  const byDay = new Map();
  const perAgent = new Map();
  const models = new Map();

  for (const agentId of agents) {
    for (const c of callsFor(agentId, sinceMs)) {
      const label = bucketOf(c.gapMs);
      add(c.firstOfTurn ? first.get(label) : later.get(label), c);

      if (c.firstOfTurn) {
        const day = new Date(c.at).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, blank());
        add(byDay.get(day), c);
      }

      if (!perAgent.has(agentId)) perAgent.set(agentId, blank());
      add(perAgent.get(agentId), c);

      const m = c.model || '(unknown)';
      if (!models.has(m)) models.set(m, blank());
      add(models.get(m), c);
    }
  }

  if (process.argv.includes('--json')) {
    const dump = (m) => Object.fromEntries([...m].map(([k, v]) => [k, { ...v, cached: rate(v), avgPrompt: avgPrompt(v) }]));
    console.log(JSON.stringify({
      since: new Date(sinceMs).toISOString(), agents: agents.length, excluded: skip,
      firstOfTurn: dump(first), withinTurn: dump(later),
      byDay: dump(byDay), byAgent: dump(perAgent), byModel: dump(models),
    }, null, 2));
    return;
  }

  console.log(`cache probe · ${agents.length} agent(s) · since ${new Date(sinceMs).toISOString().slice(0, 16)}Z`);
  console.log(skip.length ? `excluded from every ratio: ${skip.join(', ')} (eval traffic is a benchmark, not a person)` : 'eval agents INCLUDED — these ratios describe two populations at once');
  console.log('');
  console.log('FIRST CALL OF A TURN — the one the provider pin was meant to fix');
  console.log('  gap since last call    calls    cached   was    avg prompt');
  for (const b of BUCKETS) {
    const acc = first.get(b.label);
    const base = BASELINE[b.label];
    const cached = acc.calls >= MIN_CALLS ? pct(rate(acc)) : '(thin)';
    console.log(
      `  ${b.label.padEnd(20)} ${String(acc.calls).padStart(6)}   ${cached.padStart(7)}` +
      `   ${(base == null ? '—' : `${base}%`).padStart(4)}   ${String(avgPrompt(acc)).padStart(7)}`
    );
  }
  console.log('');
  console.log('LATER CALLS OF THE SAME TURN — the control, ~90% before the pin');
  for (const b of BUCKETS) {
    const acc = later.get(b.label);
    if (!acc.calls) continue;
    console.log(
      `  ${b.label.padEnd(20)} ${String(acc.calls).padStart(6)}   ` +
      `${(acc.calls >= MIN_CALLS ? pct(rate(acc)) : '(thin)').padStart(7)}   ${'—'.padStart(4)}   ${String(avgPrompt(acc)).padStart(7)}`
    );
  }
  console.log('');
  console.log('FIRST-OF-TURN BY DAY — the pin was applied 2026-09-09');
  for (const day of [...byDay.keys()].sort()) {
    const acc = byDay.get(day);
    console.log(
      `  ${day}   ${String(acc.calls).padStart(5)} calls   ` +
      `${(acc.calls >= MIN_CALLS ? pct(rate(acc)) : '(thin)').padStart(7)}   avg prompt ${String(avgPrompt(acc)).padStart(7)}`
    );
  }
  console.log('');
  console.log('BY MODEL (all calls)');
  for (const [m, acc] of [...models].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(`  ${m.padEnd(44)} ${String(acc.calls).padStart(5)} calls   ${(acc.calls >= MIN_CALLS ? pct(rate(acc)) : '(thin)').padStart(7)}`);
  }
  console.log('');
  console.log('BY AGENT (all calls)');
  for (const [a, acc] of [...perAgent].sort((x, y) => y[1].calls - x[1].calls)) {
    console.log(`  ${a.padEnd(10)} ${String(acc.calls).padStart(5)} calls   ${(acc.calls >= MIN_CALLS ? pct(rate(acc)) : '(thin)').padStart(7)}   avg prompt ${String(avgPrompt(acc)).padStart(7)}`);
  }
}

if (require.main === module) main();

module.exports = { callOf, bucketOf, BUCKETS, rate, avgPrompt };
