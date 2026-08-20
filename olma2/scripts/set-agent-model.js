#!/usr/bin/env node
// Pin ONE agent to a specific model, without touching anybody else.
//
// Why this is not `openclaw models --agent <id> set <model>`: that CLI routes
// through setAgentEffectiveModelPrimary, which reads
//
//   if (resolveAgentExplicitModelPrimary(cfg, id)) { ...set on the agent... }
//   ...otherwise fall through and set cfg.agents.defaults.model
//
// An agent with no explicit model yet — which is every Olma user — therefore
// takes the fall-through branch and the "per-agent" command silently changes
// the DEFAULT for every user on the box. Seeding agents.list[].model here
// first is what makes the per-agent path real.
//
// Three things have to line up before a model override is accepted at all
// (learned from the gateway refusing one with a valid key):
//   1. models.providers.<provider>.models[] — registers the model id itself.
//      The bundled OpenRouter catalog carries only kimi-k2.5/k2.6/auto, so
//      anything else is unknown until it is listed here.
//   2. agents.defaults.models["<provider>/<id>"] — the allowlist of models
//      any agent is permitted to use.
//   3. agents.list[<agent>].model.primary — what THIS agent actually runs.
//
// Fallback is deliberately Haiku: if the pilot model errors, refuses, or
// times out, that person's turn still completes on the known-good model
// rather than failing in front of a real user (exactly what an outage looked
// like on 2026-08-20).
//
// Usage:
//   node scripts/set-agent-model.js --agent u-3 --model openrouter/qwen/qwen3-235b-a22b-2507 [--apply]
//   node scripts/set-agent-model.js --agent u-3 --reset [--apply]     # back to inheriting defaults
'use strict';
const occ = require('../src/intake/openclaw-config');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const agentId = arg('agent');
const modelRef = arg('model');
const FALLBACK = 'anthropic/claude-haiku-4-5';

if (!agentId || (!modelRef && !RESET)) {
  console.error('Usage: --agent <id> (--model <provider/model> | --reset) [--apply]');
  process.exit(1);
}

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.list = cfg.agents.list || [];
cfg.agents.defaults = cfg.agents.defaults || {};

const entry = cfg.agents.list.find((a) => a && a.id === agentId);
if (!entry) {
  console.error(`no such agent in agents.list: ${agentId}`);
  process.exit(1);
}

const before = entry.model ? JSON.stringify(entry.model) : '(inherits defaults)';

if (RESET) {
  delete entry.model;
  console.log(`${agentId}: ${before} -> (inherits defaults)`);
} else {
  const slash = modelRef.indexOf('/');
  const provider = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);
  if (!provider || !modelId) {
    console.error(`--model must be provider/model, got: ${modelRef}`);
    process.exit(1);
  }

  // 1. register the model id with its provider
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers[provider] = cfg.models.providers[provider] || {};
  const list = cfg.models.providers[provider].models = cfg.models.providers[provider].models || [];
  if (!list.some((m) => m && m.id === modelId)) {
    list.push({ id: modelId, name: modelId });
    console.log(`registered models.providers.${provider}.models[]: ${modelId}`);
  }

  // 2. permit it
  cfg.agents.defaults.models = cfg.agents.defaults.models || {};
  if (!Object.prototype.hasOwnProperty.call(cfg.agents.defaults.models, modelRef)) {
    cfg.agents.defaults.models[modelRef] = {};
    console.log(`allowlisted: ${modelRef}`);
  }

  // 3. pin THIS agent to it
  entry.model = { primary: modelRef, fallbacks: [FALLBACK] };
  console.log(`${agentId}: ${before} -> ${JSON.stringify(entry.model)}`);
}

console.log('\nagents.defaults.model (everyone else) stays:', JSON.stringify(cfg.agents.defaults.model));
const others = cfg.agents.list.filter((a) => a && a.id !== agentId && a.model);
console.log('other agents with their own pinned model:', others.length ? others.map((a) => a.id).join(', ') : 'none');

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten to', occ.DEFAULT_PATH);
console.log('agents.defaults/models are not hot-reload paths — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
