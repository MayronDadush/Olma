#!/usr/bin/env node
// Switch Anthropic prompt-cache retention from 5 minutes to 1 hour.
//
// Why: with the cost ledger finally accurate (see migration 012), the
// breakdown across every transcript on disk came out 76% CACHE WRITES —
// $10.53 of $13.88. Every cold turn re-writes a ~29.5k-token prefix (64 tool
// schemas ≈9.3k tokens, AGENTS.md ≈30k chars, OpenClaw's own boilerplate
// ≈17k chars), and Anthropic's default cache lives 5 minutes. Olma's traffic
// is exactly wrong for that: a WhatsApp message every 20 minutes, and
// fact-extraction firing 30 minutes after a conversation ends, each find a
// cold cache and pay the whole prefix again. Anthropic's own usage report for
// 2026-08-20: ephemeral_5m 2,808,131 tokens written, ephemeral_1h 0.
//
// The knob is native (docs.openclaw.ai/reference/prompt-caching):
// agents.defaults.params.cacheRetention: "long" → cache_control
// {type:"ephemeral", ttl:"1h"} on direct Anthropic endpoints.
//
// The bet, stated so the revert condition is unambiguous: a 1h write costs 2x
// input rate vs 1.25x for 5m — 1.6x per write — and pays off only if it
// prevents ≥ ~40% of re-writes. A user who writes twice a day six hours apart
// LOSES money under this. The dashboard's reconciliation line (accurate to 0%
// since 2026-08-18) is the judge: if the daily average has not dropped after
// 48h against the $1.0-1.4 baseline of Aug 18-21, revert with --reset.
//
// Usage: node scripts/set-cache-retention.js [--apply | --reset --apply]
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
const params = cfg.agents.defaults.params || {};
const before = params.cacheRetention ?? '(default: short — 5m TTL)';

if (RESET) {
  delete params.cacheRetention;
  if (Object.keys(params).length === 0) delete cfg.agents.defaults.params;
  else cfg.agents.defaults.params = params;
  console.log('cacheRetention:', before, '-> (default: short — 5m TTL)');
} else {
  params.cacheRetention = 'long';
  cfg.agents.defaults.params = params;
  console.log('cacheRetention:', before, '-> long (1h TTL on Anthropic)');
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten. params is not a hot-reload path — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
