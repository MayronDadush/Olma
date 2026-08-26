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
// --apply): BOTH the agents.defaults.models allowlist and the
// models.providers.openrouter.models catalog entry, or the gateway refuses
// the override. This script checks both rather than writing a default the
// gateway will reject at turn time.
//
// agents.defaults is not a hot-reload path — restart the gateway after
// --apply / --reset:  systemctl --user restart openclaw-gateway
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
console.log('agents.defaults is not a hot-reload path — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
