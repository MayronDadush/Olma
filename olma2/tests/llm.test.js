'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/adapters/llm');

test('parseJsonObject accepts the ways models actually answer "only JSON"', () => {
  const obj = { facts: [], tasks: [], name: null };
  const plain = JSON.stringify(obj);
  assert.deepEqual(llm.parseJsonObject(plain), obj);
  assert.deepEqual(llm.parseJsonObject('```json\n' + plain + '\n```'), obj, 'fenced');
  assert.deepEqual(llm.parseJsonObject('הנה התשובה:\n' + plain), obj, 'preamble prose');
  assert.deepEqual(llm.parseJsonObject('  \n' + plain + '\n בהצלחה'), obj, 'trailing prose');
  // Hebrew inside strings survives the outermost-braces slice
  const heb = { facts: [{ fact: 'טס לאילת {בחמישי}' }] };
  assert.deepEqual(llm.parseJsonObject(JSON.stringify(heb)), heb);
});

test('parseJsonObject returns null for anything unparseable — never throws, never guesses', () => {
  assert.equal(llm.parseJsonObject('מצטער, לא הצלחתי לנתח את השיחה'), null);
  assert.equal(llm.parseJsonObject(''), null);
  assert.equal(llm.parseJsonObject(null), null);
  assert.equal(llm.parseJsonObject('{"broken": '), null);
  assert.equal(llm.parseJsonObject('[]'), null, 'an array is not the contract');
});

test('complete without a key fails closed instead of dialing out', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await llm.complete({ user: 'שלום' });
    assert.equal(res.ok, false);
    assert.match(res.error, /ANTHROPIC_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('provider openrouter speaks chat/completions and maps back to the same contract', async () => {
  const realFetch = globalThis.fetch;
  try {
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return {
        ok: true, status: 200,
        json: async () => ({
          model: 'deepseek/deepseek-v4-flash',
          choices: [{ message: { content: '```json\n{"facts":[]}\n```' } }],
          usage: { prompt_tokens: 970, completion_tokens: 2767 },
        }),
      };
    };
    const res = await llm.complete({
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash',
      system: 'S', user: 'U', apiKey: 'k',
    });
    assert.equal(res.ok, true);
    assert.equal(res.model, 'deepseek/deepseek-v4-flash');
    // reasoning models bill thinking as completion tokens — they must land in
    // output so recordUsage prices what was actually paid for
    assert.deepEqual(res.usage, { input: 970, output: 2767, cacheRead: 0, cacheWrite: 0 });
    assert.match(res.text, /"facts"/);
    assert.match(captured.url, /openrouter\.ai/);
    const sent = JSON.parse(captured.init.body);
    assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
    assert.match(captured.init.headers.authorization, /^Bearer /);

    // OpenRouter reports some upstream failures as 200 + an error body —
    // trusting res.ok alone would parse an empty choices array as success
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ error: { message: 'Provider returned error', code: 502 } }),
    });
    const err = await llm.complete({ provider: 'openrouter', model: 'm', user: 'x', apiKey: 'k' });
    assert.equal(err.ok, false);
    assert.match(err.error, /Provider returned error/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('provider openrouter without a key fails closed', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const res = await llm.complete({ provider: 'openrouter', model: 'm', user: 'x' });
    assert.equal(res.ok, false);
    assert.match(res.error, /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});

test('complete maps the wire shape and never throws on API errors', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: '{"facts":[]}' }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
      }),
    });
    const res = await llm.complete({ user: 'x', apiKey: 'k' });
    assert.equal(res.ok, true);
    assert.equal(res.text, '{"facts":[]}');
    assert.deepEqual(res.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 });

    globalThis.fetch = async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'credit balance is too low' } }),
    });
    const err = await llm.complete({ user: 'x', apiKey: 'k' });
    assert.equal(err.ok, false);
    assert.match(err.error, /credit balance/);

    globalThis.fetch = async () => { throw new Error('network down'); };
    const net = await llm.complete({ user: 'x', apiKey: 'k' });
    assert.equal(net.ok, false);
    assert.match(net.error, /network down/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
