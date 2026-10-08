'use strict';
// foodd's only door to a model: OpenRouter's chat completions, one call at a
// time, every one written to `model_calls` (who, what for, how long, what it
// cost — never the picture or the words).
//
// The key is FOOD_OPENROUTER_KEY in /opt/olma-food/.env, its own key with its
// own spending limit, so a runaway here can never spend Olma's. Without it
// the tools that need a model say so and everything else keeps working.
//
// Which model is decided by the bench (food/bench, "בדיקת מודלי ראייה"):
// Gemini 3.5 Flash-Lite, temperature 0. The env can point elsewhere for a
// trial without a deploy.
const DEFAULTS = {
  see: 'google/gemini-3.5-flash-lite',
  match: 'google/gemini-3.5-flash-lite',
  say: 'google/gemini-3.5-flash-lite',
};
const TIMEOUT_MS = 45_000;

const modelFor = purpose => process.env[`FOOD_${purpose.toUpperCase()}_MODEL`] || DEFAULTS[purpose];

class ModelUnavailable extends Error {}

// JSON out of a model's answer: the first { to the last }, tolerating a code
// fence around it. null when there is none.
function jsonIn(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

async function chat({ pool, userId = null, purpose, content, maxTokens = 2000, fetchImpl = globalThis.fetch, key = process.env.FOOD_OPENROUTER_KEY }) {
  if (!key) throw new ModelUnavailable('no model key configured (FOOD_OPENROUTER_KEY)');
  const model = modelFor(purpose);
  const t0 = Date.now();
  let res, body, error = null;
  try {
    res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Olma food' },
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens, usage: { include: true },
        ...(purpose === 'match' ? { reasoning: { effort: 'low' } } : {}),
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) error = `http ${res.status}: ${JSON.stringify(body?.error || body).slice(0, 160)}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? 'timeout' : String(e.message || e).slice(0, 160);
  }
  const ms = Date.now() - t0;
  const text = body?.choices?.[0]?.message?.content || '';
  if (!error && !text) error = 'empty answer';
  if (pool) {
    await pool.query(
      'INSERT INTO model_calls (user_id, purpose, model, ok, ms, cost_usd, error) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, purpose, model, !error, ms, body?.usage?.cost ?? null, error]).catch(e => console.error('[foodd llm] not recorded:', e.message));
  }
  if (error) throw new ModelUnavailable(error);
  return { text, json: jsonIn(text), ms, model };
}

module.exports = { chat, jsonIn, modelFor, ModelUnavailable, DEFAULTS };
