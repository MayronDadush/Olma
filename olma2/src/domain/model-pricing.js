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
  // provider: openrouter. cacheRead rates ARE published — the models endpoint
  // carries `input_cache_read` per model — and they are ~5x cheaper than
  // input. The original "no cache pricing published, charge the input rate"
  // guess overstated the live default's real spend by 2.2x (measured
  // 2026-08-31: 4 steady days priced $1.106 here against $0.50 by the
  // provider's own rates, with OpenRouter's dashboard agreeing with the
  // lower figure). cacheWrite stays at the input rate: DeepSeek/Qwen publish
  // no separate write price because a cached write IS a normal input token.
  // All rates re-checked live against /api/v1/models on 2026-08-31.
  'qwen/qwen3-235b-a22b-2507': { input: 0.0875, output: 0.35,  cacheWrite: 0.0875, cacheRead: 0.0175 },
  'deepseek/deepseek-v3.2':    { input: 0.269,  output: 0.40,  cacheWrite: 0.269,  cacheRead: 0.1345 },
  // v4 generation. flash is a reasoning model: thinking is billed as output
  // tokens, and the output rate here prices exactly what OpenRouter reports
  // in completion_tokens.
  'deepseek/deepseek-v4-flash': { input: 0.08092, output: 0.16184, cacheWrite: 0.08092, cacheRead: 0.016184 },
  'deepseek/deepseek-v4-pro':   { input: 1.0308,  output: 2.0616,  cacheWrite: 1.0308,  cacheRead: 0.0859 },
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
