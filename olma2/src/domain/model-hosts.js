'use strict';
// Which companies may run the model on a person's words.
//
// OpenRouter is a router: the same model is served by a dozen hosts, and the
// request's `provider` object decides which. Until 2026-09-29 the live
// default's order was `novita, streamlake` — StreamLake is CN-headquartered,
// as scripts/pin-openrouter-provider.js itself recorded when it chose Novita
// first — and `allow_fallbacks: true` let any other host serve when those two
// did not. The background calls (adapters/llm.js: memory consolidation, fact
// extraction, the judges) sent no `provider` object at all, so they went
// wherever OpenRouter liked, with no `data_collection: deny` either.
//
// The compliance review (2026-09-28, finding 7) could not establish where
// those hosts process data, and Israel's Transfer of Data to Databases Abroad
// Regulations 2001 ask the controller to know. So this is the one list both
// paths read: hosts that never serve a person's words, whatever the order and
// whatever the fallback. `ignore` is OpenRouter's own exclusion, which unlike
// `order` holds under `allow_fallbacks` — availability still has every other
// host, and the gateway's model fallbacks behind that.
//
// A slug here that OpenRouter does not know excludes nothing and costs
// nothing; a host missing from here is the gap. Grow it from OpenRouter's
// /generation records (`provider_name`), never from a guess about a name.
//
// On 2026-09-28 the owner kept StreamLake; on 2026-09-29, after the lawyer
// brief named it as the hardest transfer question, the owner took it out.
// The list is StreamLake ALONE because that is the decision that was made —
// other CN hosts (Baidu, SiliconFlow, Alibaba, DeepSeek's own) are still
// reachable as fallbacks, and adding one is the owner's call, not this file's.
const EXCLUDED_HOSTS = Object.freeze(['streamlake']);

// The `provider` object for a request. `order` is a preference (price and
// prompt cache, see the pin script); the exclusion and the no-retention rule
// ride every request, ordered or not.
function routing(order) {
  const clean = (order || []).filter((h) => !EXCLUDED_HOSTS.includes(String(h).toLowerCase()));
  return {
    ...(clean.length ? { order: clean, allow_fallbacks: true } : {}),
    data_collection: 'deny',
    ignore: [...EXCLUDED_HOSTS],
  };
}

// True when a config's provider object lets an excluded host serve.
function admitsExcluded(provider) {
  if (!provider) return true;
  const order = Array.isArray(provider.order) ? provider.order.map((h) => String(h).toLowerCase()) : [];
  const ignore = Array.isArray(provider.ignore) ? provider.ignore.map((h) => String(h).toLowerCase()) : [];
  return EXCLUDED_HOSTS.some((h) => order.includes(h) || !ignore.includes(h));
}

module.exports = { EXCLUDED_HOSTS, routing, admitsExcluded };
