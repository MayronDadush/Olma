'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const infraCost = require('../src/adapters/infra-cost');

test('infra cost: degrades to configured:false with no secrets, never throws or calls the network', async () => {
  for (const k of ['ANTHROPIC_ADMIN_KEY', 'DO_API_TOKEN', 'ELEVENLABS_API_KEY',
    'OPENROUTER_API_KEY', 'TWILIO_SID', 'TWILIO_TOKEN', 'DEEPGRAM_API_KEY',
    'CARTESIA_API_KEY']) delete process.env[k];
  const data = await infraCost.getInfraCosts();
  for (const svc of ['anthropic', 'digitalocean', 'elevenlabs', 'openrouter',
    'twilio', 'deepgram', 'cartesia']) {
    assert.equal(data[svc].configured, false, `${svc} must degrade, not guess`);
  }
  // the personal subscription is a hardcoded constant, not a fetch — always present
  assert.equal(data.subscription.configured, true);
  assert.ok(data.subscription.sinceTotal >= 20);
});

test('OpenRouter: days-left is the provider\'s own balance over its own burn rate', async () => {
  // The two responses the live API actually returned on 2026-08-31, trimmed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('/credits')
      ? { data: { total_credits: 5, total_usage: 3.234612374 } }
      : { data: { usage: 3.237948538, usage_daily: 0.409525533, usage_monthly: 3.237948538 } }),
  });
  try {
    const out = await infraCost.openRouterCost('sk-or-fake');
    assert.equal(out.prepaid, true);
    assert.ok(Math.abs(out.remaining - 1.765) < 0.01, `expected ~$1.77 left, got ${out.remaining}`);
    // ~$1.77 at ~$0.41/day is about four days — the number that says "top this
    // up this week", which a spend figure alone never would.
    assert.ok(out.daysLeft > 4 && out.daysLeft < 5, `expected ~4 days, got ${out.daysLeft}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OpenRouter: an unreadable credits call leaves remaining null, never a confident $0.00', async () => {
  // A failed fetch defaulting to zero would render "no money left" for the one
  // service the whole system runs on — the alarming shape, manufactured from
  // missing data. Absent must stay absent.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/credits')
    ? { ok: false, status: 500, json: async () => null }
    : { ok: true, status: 200, json: async () => ({ data: { usage: 3.2, usage_daily: 0.4 } }) });
  try {
    const out = await infraCost.openRouterCost('sk-or-fake');
    assert.equal(out.remaining, null);
    assert.equal(out.daysLeft, null);
    assert.equal(out.sinceTotal, 3.2, 'usage is still known and still shown');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Twilio and Deepgram report their prepaid balances', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('Balance.json')) {
      return { ok: true, status: 200, json: async () => ({ balance: '18.3024', currency: 'USD' }) };
    }
    if (u.endsWith('/projects')) {
      return { ok: true, status: 200, json: async () => ({ projects: [{ project_id: 'p1' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ balances: [{ amount: 199.9220723, units: 'usd' }] }) };
  };
  try {
    const tw = await infraCost.twilioCost('ACfake', 'tok');
    assert.ok(Math.abs(tw.remaining - 18.3024) < 0.001);
    const dg = await infraCost.deepgramCost('dg-fake');
    assert.ok(Math.abs(dg.remaining - 199.922) < 0.01);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Anthropic cache writes are read from cache_creation, the shape the API actually returns', async () => {
  // The exact bucket the live API returned for 2026-08-20, trimmed. Cache
  // writes arrive as an OBJECT keyed by TTL under `cache_creation`; the code
  // read a flat `cache_creation_input_tokens` that does not exist in the
  // response, so the largest line on an Olma turn silently priced at zero and
  // the dashboard under-reported the month by ~4x while looking healthy.
  const bucket = {
    starting_at: '2026-08-20T00:00:00Z',
    results: [{
      uncached_input_tokens: 3268,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2808131 },
      cache_read_input_tokens: 6564390,
      output_tokens: 80873,
      model: 'claude-haiku-4-5-20251001',
    }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ data: [bucket], has_more: false }),
  });
  try {
    const out = await infraCost.anthropicBotCost('sk-ant-fake');
    // 3268 in + 80873 out + 2808131 cache-write + 6564390 cache-read, at Haiku
    // rates, is the $4.57 Anthropic's own console showed for that day. Reading
    // the wrong field gave $1.06.
    assert.ok(Math.abs(out.sinceTotal - 4.57) < 0.01,
      `expected the console's $4.57, got $${out.sinceTotal.toFixed(2)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unknown model is skipped rather than mispriced — and that is visible', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      data: [{ starting_at: '2026-08-20T00:00:00Z', results: [
        { uncached_input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0,
          cache_creation: {}, model: 'some-unreleased-model' },
      ] }],
      has_more: false,
    }),
  });
  try {
    const out = await infraCost.anthropicBotCost('sk-ant-fake');
    assert.equal(out.sinceTotal, 0,
      'a model with no price table contributes nothing — the dashboard reconciliation line is what surfaces the resulting gap');
  } finally {
    globalThis.fetch = realFetch;
  }
});
