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
const MODELS = [
  'openrouter/deepseek/deepseek-v4-flash',
  'openrouter/deepseek/deepseek-v4-pro',
  'openrouter/qwen/qwen3-235b-a22b-2507',
  'openrouter/deepseek/deepseek-v3.2',
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
console.log('agents.defaults is not a hot-reload path — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
