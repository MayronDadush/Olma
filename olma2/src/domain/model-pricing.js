'use strict';
// What a model call actually costs, per model.
//
// This exists because the gateway does not tell us. Every `usage.cost` block
// in a transcript comes back `{input:0,output:0,cacheRead:0,cacheWrite:0,
// total:0}`, and the `estimatedCostUsd` in sessions.json is derived from a
// context-size gauge rather than cumulative usage (see migration 010). So the
// rates live here, and the arithmetic is ours.
//
// Rates are $ per million tokens, checked against the provider's own pricing
// page on 2026-08-20. Anthropic prices cache writes at 1.25x input and cache
// reads at 0.1x input; those multipliers are spelled out per model rather than
// derived, so a future model that breaks the pattern cannot be priced wrong by
// a clever helper.
//
// The reconciliation that validates all of this: summing one live day (Aug 20)
// across every transcript with these rates produced $4.68 against the $4.57
// Anthropic billed — 2.4% apart, the difference being calls whose model id we
// resolve slightly differently.
const flags = require('./flags');

const RATES = {
  // provider: anthropic
  // cacheWrite is the 1h-TTL rate (2x input), not the 5m rate (1.25x):
  // cacheRetention went "long" on 2026-08-22 (scripts/set-cache-retention.js)
  // and transcripts do not say which TTL a write used, so the current config's
  // rate is the honest guess. Rows from before that date were already priced
  // and stored; only new calls read this table. If retention is ever reset to
  // short, change these back in the same commit.
  'claude-haiku-4-5':  { input: 1.00, output: 5.00,  cacheWrite: 2.00, cacheRead: 0.10 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheWrite: 6.00, cacheRead: 0.30 },
  // provider: openrouter (pilot candidates — see CLAUDE.md "Model provider
  // pilot"). No prompt-cache pricing published for these, so cache columns are
  // charged at the input rate: over-charging a rounding error beats silently
  // pricing real tokens at zero.
  'qwen/qwen3-235b-a22b-2507': { input: 0.09,   output: 0.55,   cacheWrite: 0.09,   cacheRead: 0.09 },
  'deepseek/deepseek-v3.2':    { input: 0.2088, output: 0.3096, cacheWrite: 0.2088, cacheRead: 0.2088 },
};

// Transcripts carry dated ids ("claude-haiku-4-5-20251001") and provider
// prefixes ("openrouter/deepseek/deepseek-v3.2"). Longest match wins so a
// future "claude-haiku-4-5-mini" cannot be silently priced as "claude-haiku-4-5".
const KEYS_BY_LENGTH = Object.keys(RATES).sort((a, b) => b.length - a.length);

function rateFor(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  const key = KEYS_BY_LENGTH.find((k) => id.includes(k));
  return key ? { key, rate: RATES[key] } : null;
}

// usage → dollars. Returns { cost, estimated, model }: `estimated` true means
// no published rate was found and the blended fallback was used, which the
// ledger records so the dashboard can mark the number as a guess.
function priceUsage(usage, modelId, blendedPerMtok) {
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  const hit = rateFor(modelId);
  if (!hit) {
    const total = input + output + cacheRead + cacheWrite;
    return { cost: (total / 1e6) * Number(blendedPerMtok || 0), estimated: true, model: modelId || '' };
  }
  const r = hit.rate;
  const cost = (input * r.input + output * r.output
    + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite) / 1e6;
  return { cost, estimated: false, model: hit.key };
}

async function blendedRate(client) {
  return Number(await flags.getFlag(client, 'cost_per_mtok_usd') ?? 1.5);
}

module.exports = { RATES, rateFor, priceUsage, blendedRate };
