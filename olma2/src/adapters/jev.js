'use strict';
// Jev (Typesafe), through OpenRouter's decisions endpoint — a model that reads
// text and answers only closed questions (a choice from a list, a score, a
// yes-probability) and cannot write a word.
//
// A separate adapter from llm.js because it is a separate endpoint:
// `/api/alpha/decisions`, not chat/completions, with its own request and
// answer shape. ALPHA — its reference pages 404'd the day this was written, so
// every reader below tolerates a body that differs from the documented one,
// and scripts/pilot-jev.js is where its real shape was first seen.
//
// What this module promises, because every caller is a background job that
// must behave exactly as it did before Jev existed when Jev is not there:
//   - it NEVER throws. A missing key, a timeout, a 4xx/5xx, a body that is not
//     JSON — each comes back as { ok: false, error } with a short reason;
//   - it never retries on its own. A shadow that retries is a shadow that can
//     hold a sweep's connection for a minute; the caller decides;
//   - it returns the provider's own stated cost when there is one, so the
//     ledger records what OpenRouter charged rather than a guess.
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 15_000;

async function decide(state, questions, {
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  key = process.env.OPENROUTER_API_KEY,
} = {}) {
  if (!key) return { ok: false, error: 'no_key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let res; let text = '';
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network', ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, error: `http_${res.status}`, ms };
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, error: 'not_json', ms }; }
  const answers = answersOf(body);
  if (!answers) return { ok: false, error: 'no_answers', ms };
  const u = (body && body.usage) || {};
  const stated = Number(u.cost);
  return {
    ok: true,
    answers,
    model: typeof body.model === 'string' ? body.model : '',
    usage: {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      costUsd: Number.isFinite(stated) && stated >= 0 ? stated : null,
    },
    ms,
  };
}

// The documented place, and the two others a gateway might put it.
function answersOf(body) {
  if (!body || typeof body !== 'object') return null;
  const a = body.answers || (body.result && body.result.answers) || (body.data && body.data.answers);
  return a && typeof a === 'object' ? a : null;
}

// A choice answer: the key it picked, and its confidence when it gave one.
function choiceOf(a) {
  if (!a || typeof a !== 'object') return null;
  const choice = a.choice ?? a.value;
  if (typeof choice !== 'string') return null;
  const c = Number(a.confidence);
  return { choice, confidence: Number.isFinite(c) ? c : null };
}

module.exports = { decide, choiceOf, answersOf, ENDPOINT, DEFAULT_MODEL };
