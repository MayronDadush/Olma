#!/usr/bin/env node
// Switch the model every agent turn runs on — the one config value that puts
// a model in front of real people. Dry-run by default, --apply to write,
// --reset to restore the Anthropic default; same shape as
// set-cache-retention.js, and like it, never `openclaw config set` (hangs).
//
// Why this exists (2026-08-26): the Anthropic account ran dry for the third
// time in a week and the operator decided not to refill it — at which point
// the standing default was not "expensive", it was a dead end for every
// user turn. The pilot path (scripts/model-pilot.js, disposable sessions,
// no --deliver) ran deepseek-v4-flash on u-3 first: correct Hebrew including
// grammatical gender, and the full honest tool sequence (turn_start →
// calendar → list → add_task) verified against the DB, not the reply text.
//
// The model must be registered first (scripts/register-openrouter-models.js
// --apply): the agents.defaults.models allowlist, the
// models.providers.openrouter.models catalog entry, AND — since gateway
// 2026.8.1 — agents.defaults.modelPolicy.allow. All THREE, or the gateway
// refuses the override with "not allowed for agent <id> by
// agents.defaults.modelPolicy.allow". Registered-in-two-of-three is invisible
// until something actually tries to use the model, which cost an entire eval
// suite on 2026-09-02.
//
// NO RESTART NEEDED. This header used to say "agents.defaults is not a
// hot-reload path — restart the gateway", and on 2026.8.1 that is wrong. From
// the installed gateway's own reload plan
// (dist/config-reload-plan-BVRn0HTz.js):
//
//   { prefix: "agents.defaults.model",       kind: "hot", ... }
//   { prefix: "agents.defaults.models",      kind: "hot", ... }
//   { prefix: "agents.defaults.modelPolicy", kind: "hot", ... }
//   { prefix: "models",                      kind: "hot", ... }
//
// Confirmed live 2026-09-02: after a write, the journal prints "config hot
// reload applied" and the very next turn accepts the new model — no restart.
// This is not a footnote. The restart is the ONLY part of a model change that
// touches live users, so believing it was required is what confined every
// model experiment in this project to off-hours for months.
'use strict';
const occ = require('../src/intake/openclaw-config');

const DEFAULT_TARGET = {
  primary: 'openrouter/deepseek/deepseek-v4-flash',
  // pro is the same provider pipe with a stronger model; Anthropic stays
  // last so a future top-up quietly becomes a safety net again.
  fallbacks: ['openrouter/deepseek/deepseek-v4-pro', 'anthropic/claude-haiku-4-5'],
};
const ANTHROPIC_DEFAULT = {
  primary: 'anthropic/claude-haiku-4-5',
  fallbacks: ['anthropic/claude-sonnet-4-6'],
};

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const target = RESET ? ANTHROPIC_DEFAULT : DEFAULT_TARGET;

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};

const allow = cfg.agents.defaults.models || {};
const catalog = ((((cfg.models || {}).providers || {}).openrouter || {}).models || []).map((m) => m && m.id);
for (const id of [target.primary, ...target.fallbacks]) {
  if (id.startsWith('openrouter/')) {
    const bare = id.replace(/^openrouter\//, '');
    if (!Object.prototype.hasOwnProperty.call(allow, id) || !catalog.includes(bare)) {
      console.error(`refusing: ${id} is not fully registered (allowlist + provider catalog).`);
      console.error('run scripts/register-openrouter-models.js --apply first.');
      process.exit(1);
    }
  }
}

console.log('current default:', JSON.stringify(cfg.agents.defaults.model));
console.log('target default: ', JSON.stringify(target));

if (!APPLY && !RESET) {
  console.log('\ndry run — pass --apply to write (or --reset for the Anthropic default)');
  process.exit(0);
}

cfg.agents.defaults.model = target;
occ.saveConfig(cfg);
console.log('\nwritten to', occ.DEFAULT_PATH);
console.log('agents.defaults.model is a HOT reload path on 2026.8.1 — no restart.');
console.log('Verify it landed:  journalctl --user -u openclaw-gateway -n 20 | grep "hot reload"');
