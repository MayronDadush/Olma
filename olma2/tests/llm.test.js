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

// Three fields OpenRouter publishes on every completion and we were throwing
// all three away: the price it actually charged, and how much of the prompt
// was served from cache. Discarding usage.cost left the evals judge priced by
// a rate table that had no entry for it, i.e. $0.00 against 196k real output
// tokens; discarding cached_tokens billed a warm prompt as if every token were
// a fresh read. Shape probed live 2026-09-03 — this fixture is that response.
test('openrouter usage carries the stated cost and the cache split', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'deepseek/deepseek-v4-flash',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 9, completion_tokens: 20, total_tokens: 29,
          cost: 0.00000686,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
        },
      }),
    });
    const res = await llm.complete({
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', user: 'U', apiKey: 'k',
    });
    assert.equal(res.usage.costUsd, 0.00000686, 'the price the provider actually charged');
    assert.equal(res.usage.cacheRead, 4);
    assert.equal(res.usage.cacheWrite, 2);

    // A cost of genuinely zero is a real price and must stay distinguishable
    // from "not reported" — 0 is falsy, so a truthiness check here would throw
    // the one away with the other.
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'm', choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      }),
    });
    const free = await llm.complete({ provider: 'openrouter', model: 'm', user: 'U', apiKey: 'k' });
    assert.equal(free.usage.costUsd, 0, 'a free call reports 0, not null');
  } finally { globalThis.fetch = realFetch; }
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
    // output so recordUsage prices what was actually paid for. costUsd is null
    // here because this fixture carries no usage.cost: absent must read as
    // "the provider said nothing", never as "it was free" — the next test
    // pins the case where it does say something.
    assert.deepEqual(res.usage,
      { input: 970, output: 2767, cacheRead: 0, cacheWrite: 0, costUsd: null });
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

    // ...and some as 200 with a body that is not JSON at all. Before the
    // guard this threw "Cannot read properties of null (reading 'choices')" —
    // the raw TypeError the 2026-08-30 nightly eval run recorded twice.
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => { throw new Error('unexpected end of JSON input'); },
    });
    const empty = await llm.complete({ provider: 'openrouter', model: 'm', user: 'x', apiKey: 'k' });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /empty or unparseable response body/);
    assert.doesNotMatch(empty.error, /Cannot read properties/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Both providers answer a slow request with the 200 first and the body after,
// so our own deadline lands mid-body and comes back as a json() failure on a
// healthy-looking response. Reported as "empty response body (http 200)" it
// reads as the provider's fault — which is exactly how a judge that was timing
// out at 60s got diagnosed three times as an upstream wobble.
test('our own timeout is named as ours, not as an empty body from the provider', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const provider of ['openrouter', 'anthropic']) {
      globalThis.fetch = async (_url, init) => ({
        ok: true, status: 200,
        // The deadline fires while the body is still arriving: by the time
        // json() gives up, the signal is aborted — the shape undici produces.
        json: async () => {
          await new Promise((r) => setTimeout(r, 30));
          assert.equal(init.signal.aborted, true, 'the test must actually reach the abort');
          throw new Error('The operation was aborted');
        },
      });
      const res = await llm.complete({ provider, model: 'm', user: 'x', apiKey: 'k', timeoutMs: 5 });
      assert.equal(res.ok, false);
      assert.match(res.error, /timeout/, `${provider}: a deadline we set is a timeout`);
      assert.doesNotMatch(res.error, /empty or unparseable/,
        `${provider}: must not read as the provider returning nothing`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('finishReason surfaces truncation on both providers, normalised to "length"', async () => {
  const realFetch = globalThis.fetch;
  try {
    // A reasoning model that spent its whole budget thinking: 200, choices
    // present, content null, finish_reason 'length'. The caller must be able
    // to tell this from a healthy empty answer.
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'moonshotai/kimi-k2.6',
        choices: [{ message: { content: null }, finish_reason: 'length' }],
        usage: { prompt_tokens: 900, completion_tokens: 2500 },
      }),
    });
    const or = await llm.complete({ provider: 'openrouter', model: 'moonshotai/kimi-k2.6', user: 'x', apiKey: 'k' });
    assert.equal(or.ok, true);
    assert.equal(or.text, '');
    assert.equal(or.finishReason, 'length');

    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'נחת' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const an = await llm.complete({ user: 'x', apiKey: 'k' });
    assert.equal(an.finishReason, 'length', "Anthropic's max_tokens maps to the same value");
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

test('backgroundModel reads the flag and fails open to the Anthropic default', async () => {
  const fake = (value) => ({ query: async () => ({ rows: value === undefined ? [] : [{ value }] }) });
  assert.deepEqual(await llm.backgroundModel(fake(undefined)), {}, 'no flag → default');
  assert.deepEqual(
    await llm.backgroundModel(fake({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' })),
    { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(await llm.backgroundModel(fake('deepseek')), {}, 'malformed flag → default');
  assert.deepEqual(await llm.backgroundModel(fake({ provider: 'openrouter' })), {}, 'no model → default');
  const boom = { query: async () => { throw new Error('db down'); } };
  assert.deepEqual(await llm.backgroundModel(boom), {}, 'a broken flag read must not kill the job');
  // an unknown provider string must not dial an unintended backend
  const odd = await llm.backgroundModel(fake({ provider: 'evil', model: 'm' }));
  assert.equal(odd.provider, undefined);
  assert.equal(odd.model, 'm');
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
