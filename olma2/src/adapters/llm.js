'use strict';
// Direct model calls for background cognition — the jobs that read and think
// but never speak to anyone (fact extraction, memory consolidation, and the
// planning pass to come).
//
// Why this exists next to runSilentAgentTurn: an agent turn through the
// gateway carries the full interactive stack — the system prompt, AGENTS.md,
// and 60+ tool schemas, ~21k cold tokens — to do a job that needs a transcript
// and one JSON answer. Routing background thinking here cuts the cost per
// thought ~4x, and removes two documented fragilities: the model must no
// longer call MCP tools honestly (the server writes, below the model), and
// the NO_REPLY convention cannot end a turn early (there is no turn).
//
// Deliberately zero-dep (global fetch, Node 24) and provider-shaped as one
// narrow interface: complete() takes messages, returns text + usage. The
// Anthropic Messages API is the only backend today; an OpenRouter backend can
// implement the same interface later without touching any caller — which is
// the agreed path for ever testing open-weight models on background jobs.
const pricing = require('../domain/model-pricing');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 120_000;

// complete({ system, user, model?, maxTokens?, timeoutMs?, provider? })
//   -> { ok: true, text, model, usage: {input, output, cacheRead, cacheWrite} }
//    | { ok: false, error }
// Never throws: background sweeps treat a failed call like a failed turn —
// log, leave the watermark alone, retry next tick.
//
// provider: 'anthropic' (default) or 'openrouter' — the open-weight door this
// interface was shaped for. Same inputs, same return, so a caller (or an A/B
// script) switches models with two fields and zero code.
async function complete(opts = {}) {
  if (opts.provider === 'openrouter') return completeOpenRouter(opts);
  const { system, user, model, maxTokens, timeoutMs, apiKey, baseUrl } = opts;
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no ANTHROPIC_API_KEY configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl || DEFAULT_BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: maxTokens || 2048,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: String(user) }],
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body && body.error && body.error.message ? body.error.message : `http ${res.status}`;
      return { ok: false, error: String(msg).slice(0, 300) };
    }
    const text = (body.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = body.usage || {};
    return {
      ok: true,
      text,
      model: body.model || model || DEFAULT_MODEL,
      usage: {
        input: Number(u.input_tokens) || 0,
        output: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'llm timeout' : String(e.message).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// OpenRouter speaks the OpenAI chat/completions shape. Same narrow contract
// out: text + usage (OpenRouter reports no cache split, so cacheRead/Write
// are zero and input carries the full prompt).
async function completeOpenRouter({ system, user, model, maxTokens, timeoutMs, apiKey } = {}) {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: 'no OPENROUTER_API_KEY configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 2048,
        messages: [
          ...(system ? [{ role: 'system', content: String(system) }] : []),
          { role: 'user', content: String(user) },
        ],
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || (body && body.error)) {
      const msg = body && body.error && body.error.message ? body.error.message : `http ${res.status}`;
      return { ok: false, error: String(msg).slice(0, 300) };
    }
    const choice = body.choices && body.choices[0];
    const u = body.usage || {};
    return {
      ok: true,
      text: (choice && choice.message && choice.message.content) || '',
      model: body.model || model,
      usage: {
        input: Number(u.prompt_tokens) || 0,
        output: Number(u.completion_tokens) || 0,
        cacheRead: 0, cacheWrite: 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'llm timeout' : String(e.message).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// The one lesson of migration 012, applied in advance: usage that is not
// written down somewhere the dashboard reads is usage that does not exist on
// paper. Transcript sweeps cannot see a direct call — there is no transcript —
// so every caller records its own usage here, into the same ledger, priced by
// the same table. The reconciliation line then keeps both honest.
async function recordUsage(client, userId, model, usage) {
  const priced = pricing.priceUsage(usage, model, null);
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  await client.query(
    `INSERT INTO usage_ledger
       (user_id, date, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, cost_usd, estimated)
     VALUES ($1, (now() at time zone 'utc')::date, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, date, model) DO UPDATE SET
       input_tokens = usage_ledger.input_tokens + $3,
       output_tokens = usage_ledger.output_tokens + $4,
       cache_read_tokens = usage_ledger.cache_read_tokens + $5,
       cache_write_tokens = usage_ledger.cache_write_tokens + $6,
       total_tokens = usage_ledger.total_tokens + $7,
       cost_usd = usage_ledger.cost_usd + $8,
       estimated = usage_ledger.estimated OR $9`,
    [userId, priced.model, usage.input, usage.output, usage.cacheRead,
      usage.cacheWrite, total, priced.cost.toFixed(4), priced.estimated]
  );
}

// Models answer "return only JSON" with JSON in a code fence often enough that
// refusing the fence would fail runs for formatting, not content. Strip it,
// find the outermost object, parse strictly from there. Returns null when
// there is no parseable object — the caller treats that as a failed run.
function parseJsonObject(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

module.exports = { complete, recordUsage, parseJsonObject, DEFAULT_MODEL };
