#!/usr/bin/env node
// Tell OpenRouter which providers may serve the live default model, in order.
//
// OpenRouter routes `deepseek/deepseek-v4-flash` across a dozen providers and
// picks per request. Read off its own /generation records for the response
// ids in u-3's transcript on 2026-09-09: StreamLake, DeepInfra and GMICloud
// inside six hours. A prompt cache is per provider, so the first call of
// nearly every message found nothing cached — 0–9% for any gap over two
// minutes, against ~90% for the second call of the same turn — and paid the
// full prompt (avg 62k tokens, 44k uncached), about 45% of the bill
// (docs/incidents.md, "The conversation that never ended").
//
// Two things this buys, one certain and one to be measured:
//   - price: DigitalOcean serves the same model at $0.068/M input against
//     $0.089–0.091 for the three in use, cache reads $0.0168/M, completion
//     $0.168/M (OpenRouter /models/.../endpoints, 2026-09-09) — ~20% off
//     the bill whatever the cache does;
//   - cache: whether ONE provider's prefix cache survives the minutes
//     between a person's messages. Nobody knows until it runs a day; read
//     `cacheRead` on first-of-turn calls in the transcripts, or OpenRouter's
//     `native_tokens_cached` for the same ids, before calling it a win.
//
// ── ANSWERED 2026-09-11, and the answer is no ───────────────────────────────
// `scripts/cache-probe.js` is that reading, two days after this was applied
// and the gateway restarted. First-of-turn cache, real users: 57% under two
// minutes, 6% at 2–10, 3% at 10–60 (2,001 calls), 0% past the hour — the
// pre-pin baseline to the point. `order` is a PREFERENCE, not an exclusion,
// and `allow_fallbacks: true` is what makes it one: of 54 consecutive calls
// after the restart, StreamLake served 38 and DigitalOcean 16, and 21 landed
// on a different provider than the call before them. Same provider as the
// previous call: 54% cached. Changed: 3%. That is the entire effect.
//
// So the price half of this bet is collected and the cache half is not, and
// the two are not independent: an UNCACHED call on the cheap provider
// ($0.0679/M × 44k = $0.00299) costs MORE than a 54%-cached call on the
// dearer one ($0.0840 and $0.0168/M × 44k = $0.00210). If the order is ever
// re-cut, cut it towards where the traffic actually lands, not down the price
// list. Turning `allow_fallbacks` off would buy the cache and spend the
// availability this flag exists to protect — the owner's rule is that an
// outage costs the cache and never a reply — so it stays on.
// (`docs/incidents.md`, "The pin held the order and the cache still died".)
//
// The knob is OpenClaw's own: `agents.defaults.models["openrouter/<model>"]
// .params.provider` is forwarded as OpenRouter's request `provider` object
// (docs: gateway/config-agents, "OpenRouter provider routing"). `order` is
// tried in sequence; `allow_fallbacks: true` keeps every other provider
// behind them, so a DigitalOcean outage costs the cache, never a reply.
// Slugs, not display names (OpenRouter /providers).
//
// `params` is not a hot-reload path — restart the gateway after writing.
// Then prove it on a real generation, never on the file:
//   curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
//     https://openrouter.ai/api/v1/generation?id=<responseId from a transcript>
// must say provider_name "DigitalOcean". model-pricing.js carries that
// provider's rates for new ledger rows (the ledger is append-only; earlier
// rows keep the blended rate they were written with).
//
// Usage: node scripts/pin-openrouter-provider.js [--apply] [--reset]
//   --reset deletes params.provider (back to OpenRouter's own routing)
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const MODEL = 'openrouter/deepseek/deepseek-v4-flash';
// Cheapest first; the next two are the ones OpenRouter was already using,
// both with cache pricing published, so a fallback is the old world at the
// old price rather than a stranger.
const ORDER = ['digitalocean', 'streamlake', 'deepinfra'];

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.models = cfg.agents.defaults.models || {};
const entry = cfg.agents.defaults.models[MODEL] || {};
const before = entry.params && entry.params.provider ? JSON.stringify(entry.params.provider) : '(unset — OpenRouter picks per request)';

if (RESET) {
  if (entry.params) { delete entry.params.provider; if (!Object.keys(entry.params).length) delete entry.params; }
} else {
  entry.params = { ...(entry.params || {}), provider: { order: ORDER, allow_fallbacks: true } };
}
cfg.agents.defaults.models[MODEL] = entry;
console.log(`${MODEL} params.provider:`, before, '->', RESET ? '(unset)' : JSON.stringify(entry.params.provider));

if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
occ.saveConfig(cfg);
console.log('\nwritten. params is not a hot-reload path — restart the gateway:');
console.log('  XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway');
console.log('then read a fresh responseId out of any transcript and ask OpenRouter who served it.');
