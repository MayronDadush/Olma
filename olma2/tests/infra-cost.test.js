'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const infraCost = require('../src/adapters/infra-cost');

test('infra cost: degrades to configured:false with no secrets, never throws or calls the network', async () => {
  delete process.env.ANTHROPIC_ADMIN_KEY;
  delete process.env.DO_API_TOKEN;
  delete process.env.ELEVENLABS_API_KEY;
  const data = await infraCost.getInfraCosts();
  assert.equal(data.anthropic.configured, false);
  assert.equal(data.digitalocean.configured, false);
  assert.equal(data.elevenlabs.configured, false);
  // the personal subscription is a hardcoded constant, not a fetch — always present
  assert.equal(data.subscription.configured, true);
  assert.ok(data.subscription.sinceTotal >= 20);
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
