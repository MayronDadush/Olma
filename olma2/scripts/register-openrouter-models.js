#!/usr/bin/env node
// Register OpenRouter models in the gateway's allowlist so they can be used
// as a per-run --model override during the cost pilot (see CLAUDE.md,
// "Model provider pilot").
//
// Why a script and not a manual edit: openclaw.json is the live routing
// config for every user. An undocumented hand-edit on the box is exactly the
// kind of drift CLAUDE.md warns about — the file and the repo disagree and
// the next session has to re-derive what happened. This is the same shape as
// scripts/set-recovery-thresholds.js: dry-run by default, --apply to write.
//
// What it does NOT do: change the default model. agents.defaults.model stays
// anthropic/claude-haiku-4-5 with its existing fallback. Registering a model
// only makes it *permitted*; the pilot then selects it per call with
// --model, so no real user's conversation is moved onto an unproven model by
// this script alone.
//
// The API key itself is NOT here and must never be: it lives in OpenClaw's
// own credential store, added with
//   openclaw models auth paste-api-key --provider openrouter
// which writes it to the agent's encrypted sqlite auth store, not to a file
// in this repo.
//
// Usage: node scripts/register-openrouter-models.js [--apply]
'use strict';
const occ = require('../src/intake/openclaw-config');

// Candidates for the pilot, cheapest-first. Prices are per million tokens as
// listed on OpenRouter 2026-08-20, against Haiku 4.5's $1.00 / $5.00:
//   qwen3-235b-a22b-2507  $0.09 / $0.55   (~11x / ~9x cheaper)
//   deepseek-v3.2         $0.209 / $0.310 (~5x / ~16x cheaper)
// Both advertise full tools + JSON-schema structured output, which is the
// hard requirement here: Olma's agent turn is mostly tool selection across
// ~59 MCP tools, and a model that cannot call tools reliably is useless to
// us no matter how cheap.
// v4 generation added 2026-08-26 after the background-cognition benchmark
// (extraction + planning briefs): flash matched Haiku's correctness in Hebrew
// at $0.0886/$0.177 per Mtok. That benchmark had no tools, so this
// registration still proves nothing about a 59-tool agent turn — that is
// what scripts/model-pilot.js is for.
// The cheap tier, added 2026-08-31 with prices read live off /api/v1/models
// that morning rather than copied forward. Against the incumbent v4-flash
// ($0.089 / $0.177 per Mtok), the whole tool-capable floor sits at roughly
// $0.03 / $0.13 — so the money argument is nearly exhausted: a swap here saves
// hundredths of a cent per Mtok on a system billing ~$18/month. These are
// registered to be judged on QUALITY and SPEED, which is where an agent turn
// actually lives (~59 tool schemas, Hebrew, and a 65s stuckSessionAbortMs).
//   qwen3.7-flash   $0.030 / $0.130, 1M context
//   gpt-oss-120b    $0.037 / $0.170, 131k context — carried in CLAUDE.md as
//                   "Anglocentric, weakest Hebrew bet" since 2026-08-20 on no
//                   evidence at all; registered to settle that rather than
//                   keep repeating it.
const MODELS = [
  'openrouter/deepseek/deepseek-v4-flash',
  'openrouter/deepseek/deepseek-v4-pro',
  'openrouter/qwen/qwen3-235b-a22b-2507',
  'openrouter/deepseek/deepseek-v3.2',
  'openrouter/qwen/qwen3.7-flash',
  'openrouter/openai/gpt-oss-120b',
];

const APPLY = process.argv.includes('--apply');
const cfg = occ.loadConfig();

cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.models = cfg.agents.defaults.models || {};

const added = [];
for (const id of MODELS) {
  if (Object.prototype.hasOwnProperty.call(cfg.agents.defaults.models, id)) continue;
  cfg.agents.defaults.models[id] = {};
  added.push(id);
}

// The allowlist alone is NOT enough (verified 2026-08-20, and the gateway's
// own error text says so): the bundled OpenRouter catalog carries only Kimi,
// so any other model also needs a matching entry in
// models.providers.openrouter.models[] or the override is refused with
// "Model override ... is not allowed". There is no CLI path for this —
// `models scan` only covers free models — so this script owns it.
cfg.models = cfg.models || {};
cfg.models.providers = cfg.models.providers || {};
cfg.models.providers.openrouter = cfg.models.providers.openrouter || {};
const provider = cfg.models.providers.openrouter;
provider.models = provider.models || [];
const catalogAdded = [];
for (const id of MODELS) {
  const bare = id.replace(/^openrouter\//, '');
  if (provider.models.some((m) => m && m.id === bare)) continue;
  provider.models.push({ id: bare, name: bare });
  catalogAdded.push(bare);
}
console.log('provider catalog now:', provider.models.map((m) => m.id).join(', '));
if (catalogAdded.length) console.log('newly catalogued:', catalogAdded.join(', '));

console.log('default model (unchanged):', JSON.stringify(cfg.agents.defaults.model));
console.log('allowlist now:', Object.keys(cfg.agents.defaults.models).join(', '));
console.log(added.length ? `\nnewly registered: ${added.join(', ')}` : '\nnothing to add — already registered');

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
if (!added.length && !catalogAdded.length) process.exit(0);

occ.saveConfig(cfg);
console.log('\nwritten to', occ.DEFAULT_PATH);
// This used to tell you to restart the gateway. Probed 2026-08-31 immediately
// after a write that added two models: a --model override on a brand-new entry
// was accepted straight away, with executionTrace.winnerModel naming the
// candidate and fallbackUsed false. So registration applies HOT, and the
// restart this script demanded for months was never needed for it — which
// matters because a restart is the one part of a model pilot that interrupts
// live users, and demanding it is what confines the pilot to a quiet window.
// The bindings rule it was generalised from is narrower than it looked (see
// CLAUDE.md, "bindings hot-apply — but only when bundled").
console.log('registration applies hot — verify with a --model override before');
console.log('assuming a restart is needed:');
console.log('  openclaw agent --agent u-15 --session-key "probe:$(date +%s)" \\');
console.log('    --message "test" --model <id> --json | grep winnerModel');
