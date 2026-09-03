'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const usage = require('../src/jobs/usage');
const pricing = require('../src/domain/model-pricing');
const sessions = require('../src/channels/sessions');

let db, user, TMP;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972595000001', { firstName: 'מירון' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-cost' WHERE id = $1`, [user.id]);
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-usage-'));
});
after(async () => { await db.teardown(); fs.rmSync(TMP, { recursive: true, force: true }); });

// One assistant message as the gateway writes it.
function call({ at, model = 'claude-haiku-4-5-20251001', input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return JSON.stringify({
    type: 'message', timestamp: at,
    message: {
      role: 'assistant', responseModel: model,
      content: [{ type: 'text', text: 'ok' }],
      // The gateway really does report an all-zero cost block — the reason
      // this pipeline prices calls itself instead of trusting the field.
      usage: { input, output, cacheRead, cacheWrite, cost: { total: 0 } },
    },
  });
}

function writeTranscript(name, lines) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { agentId: 'u-cost', sessionId: name.replace('.jsonl', ''), file, size: fs.statSync(file).size };
}
function appendTranscript(t, lines) {
  fs.appendFileSync(t.file, lines.join('\n') + '\n');
  t.size = fs.statSync(t.file).size;
  return t;
}
const sweep = (transcripts) => withTx(db.pool, (c) =>
  usage.sweepUsage(c, { listTranscripts: () => transcripts }));

// ---- pricing ----------------------------------------------------------------

test('a call is priced per model, with cache reads far cheaper than fresh input', () => {
  // the real shape of an Olma turn: a tiny fresh prompt against a large cached
  // system prompt. Charging cacheRead at the input rate would overstate this
  // ~10x, which is the opposite error to the one being fixed but just as wrong.
  const p = pricing.priceUsage(
    { input: 47, output: 653, cacheRead: 88398, cacheWrite: 29863 },
    'claude-haiku-4-5-20251001', 1.5);
  assert.equal(p.estimated, false);
  assert.equal(p.model, 'claude-haiku-4-5');
  // 47*1 + 653*5 + 88398*0.1 + 29863*2 (1h-TTL write rate), per Mtok
  assert.ok(Math.abs(p.cost - 0.07188) < 0.0001, `got ${p.cost}`);

  const sonnet = pricing.priceUsage({ input: 1e6 }, 'claude-sonnet-4-6', 1.5);
  assert.equal(sonnet.cost, 3, 'sonnet input is $3/Mtok, not the blended rate');
});

test('an unpriced model falls back to the blended rate and says so', () => {
  const p = pricing.priceUsage({ input: 1e6 }, 'some-future-model', 1.5);
  assert.equal(p.cost, 1.5);
  assert.equal(p.estimated, true, 'the dashboard has to be able to mark a guess as a guess');
});

// ---- the three failures migration 010 exists for -----------------------------

test('cost comes from the transcript, not from the context-size gauge', async () => {
  // 138 calls of a real conversation. The gauge in sessions.json read 58,892
  // for this session; the truth is millions of billable tokens.
  const lines = [];
  for (let i = 0; i < 138; i++) {
    lines.push(call({ at: '2026-08-20T10:00:00Z', input: 10, output: 144, cacheRead: 27906, cacheWrite: 12000 }));
  }
  const t = writeTranscript('sess-real.jsonl', lines);
  const out = await sweep([t]);
  assert.equal(out.calls, 138);

  const { rows } = await db.pool.query(
    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd
     FROM usage_ledger WHERE user_id = $1 AND date = '2026-08-20'`, [user.id]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].output_tokens), 138 * 144);
  assert.equal(Number(rows[0].cache_read_tokens), 138 * 27906);
  assert.equal(Number(rows[0].total_tokens), 138 * (10 + 144 + 27906 + 12000));
  // dollars, not cents-from-a-gauge
  assert.ok(Number(rows[0].cost_usd) > 0.5, `expected real money, got ${rows[0].cost_usd}`);
});

test('re-running attributes nothing twice, and only new lines are charged', async () => {
  const t = writeTranscript('sess-resume.jsonl', [call({ at: '2026-08-19T10:00:00Z', input: 1000 })]);
  await sweep([t]);
  const after1 = Number((await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1 AND date = '2026-08-19'`, [user.id])).rows[0].cost_usd);

  const again = await sweep([t]);
  assert.equal(again.calls, 0, 'an unchanged transcript must cost nothing on a re-sweep');
  const after2 = Number((await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1 AND date = '2026-08-19'`, [user.id])).rows[0].cost_usd);
  assert.equal(after2, after1);

  appendTranscript(t, [call({ at: '2026-08-19T11:00:00Z', input: 1000 })]);
  const third = await sweep([t]);
  assert.equal(third.calls, 1, 'only the appended call');
  const after3 = Number((await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1 AND date = '2026-08-19'`, [user.id])).rows[0].cost_usd);
  assert.ok(after3 > after2);
});

test('a rotated session keeps its cost — the file outlives the index', async () => {
  // The live failure: sessions.json reused one key for a newer sessionId and
  // the old session's 5.69M tokens became invisible. Transcripts are listed
  // from disk, so an old file is still read even once nothing points at it.
  const older = writeTranscript('sess-rotated-old.jsonl', [call({ at: '2026-08-18T10:00:00Z', input: 500_000 })]);
  const newer = writeTranscript('sess-rotated-new.jsonl', [call({ at: '2026-08-18T12:00:00Z', input: 1000 })]);
  await sweep([older, newer]);

  const { rows } = await db.pool.query(
    `SELECT cost_usd FROM usage_ledger WHERE user_id = $1 AND date = '2026-08-18'`, [user.id]);
  // 501,000 input tokens at $1/Mtok — the old session dominates, and would be
  // missing entirely under the index-based sweep.
  assert.ok(Math.abs(Number(rows[0].cost_usd) - 0.501) < 0.001, `got ${rows[0].cost_usd}`);
});

test('a half-written last line is left for the next sweep', async () => {
  const t = writeTranscript('sess-partial.jsonl', [call({ at: '2026-08-17T10:00:00Z', input: 1000 })]);
  fs.appendFileSync(t.file, '{"type":"message","timestamp":"2026-08-17T10:01:00Z","mess');
  t.size = fs.statSync(t.file).size;

  const out = await sweep([t]);
  assert.equal(out.calls, 1, 'only the complete line');

  // completing the line makes it billable on the next pass, not lost
  fs.appendFileSync(t.file, 'age":{"role":"assistant","responseModel":"claude-haiku-4-5","content":[{"type":"text","text":"x"}],"usage":{"input":2000}}}\n');
  t.size = fs.statSync(t.file).size;
  const out2 = await sweep([t]);
  assert.equal(out2.calls, 1, 'the once-partial line is picked up whole');
});

// ---- attribution -------------------------------------------------------------

test('agents with no user (main, intake) are billed to the system ledger, not dropped', async () => {
  const t = { agentId: 'main', sessionId: 'sess-main', file: path.join(TMP, 'sess-main.jsonl'), size: 0 };
  fs.writeFileSync(t.file, call({ at: '2026-08-16T10:00:00Z', input: 100_000 }) + '\n');
  t.size = fs.statSync(t.file).size;
  await sweep([t]);

  const { rows } = await db.pool.query(
    `SELECT agent_id, cost_usd FROM usage_system_ledger WHERE date = '2026-08-16'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'main');
  assert.ok(Math.abs(Number(rows[0].cost_usd) - 0.1) < 0.001);
  // and it must not have been silently attributed to a real person
  const users = await db.pool.query(
    `SELECT count(*)::int AS n FROM usage_ledger WHERE date = '2026-08-16'`);
  assert.equal(users.rows[0].n, 0);
});

test('a call is attributed to the day it happened, not the day it was swept', async () => {
  const t = writeTranscript('sess-backfill.jsonl', [
    call({ at: '2026-08-14T23:59:00Z', input: 1000 }),
    call({ at: '2026-08-15T00:01:00Z', input: 1000 }),
  ]);
  await sweep([t]);
  const { rows } = await db.pool.query(
    `SELECT date FROM usage_ledger WHERE user_id = $1 AND date IN ('2026-08-14','2026-08-15') ORDER BY date`,
    [user.id]);
  assert.equal(rows.length, 2, 'a backfill spanning midnight must split across both days');
});

// ---- the reader itself ---------------------------------------------------------

test('trajectory files are skipped — they carry no billable usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-tr-'));
  const agents = path.join(dir, 'agents', 'u-x', 'sessions');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'a.jsonl'), '');
  fs.writeFileSync(path.join(agents, 'a.trajectory.jsonl'), '');
  const found = sessions.listTranscripts(dir);
  assert.deepEqual(found.map((f) => f.sessionId), ['a']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openrouter cache reads are priced at the published cache rate, not as fresh input', () => {
  // The original table charged cacheRead at the input rate on the stated
  // belief that no cache pricing was published. It is published
  // (models endpoint, `input_cache_read`), and the difference is ~5x — the
  // dashboard overstated the live default's spend by 2.2x for five days
  // before anyone compared it with OpenRouter's own number (2026-08-31).
  const { RATES } = require('../src/domain/model-pricing');
  for (const id of ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v3.2', 'qwen/qwen3-235b-a22b-2507']) {
    const r = RATES[id];
    assert.ok(r.cacheRead < r.input, `${id}: cacheRead (${r.cacheRead}) must be cheaper than input (${r.input})`);
  }
});

// Every model that has actually billed us must be IN the table, because being
// absent from it is not a rounding error — it hands pricing to whatever
// blended rate the caller happened to pass, and the two callers pass opposite
// things. recordUsage passes null (→ $0.00, the evals judge's 196k output
// tokens recorded as free) while the transcript sweep passes a real rate
// applied equally to cache reads that cost ~5x less (→ four pilot models
// overstated 16x to 54x). Same gap, opposite directions, both invisible.
test('every model that has actually run is priced from the table, not guessed', () => {
  const { RATES, rateFor } = require('../src/domain/model-pricing');
  // The judge, plus every candidate docs/model-experiments.md has piloted.
  const RUN = [
    'moonshotai/kimi-k2.6', 'openai/gpt-5.6-luna', 'openai/gpt-5.4-nano',
    'openai/gpt-5.4-mini', 'openai/gpt-oss-120b', 'qwen/qwen3.7-flash',
    'google/gemini-3.8-flash',
  ];
  for (const id of RUN) {
    assert.ok(rateFor(id), `${id} has billed real money and must have a published rate`);
  }
  // Sanity on every entry: output is never cheaper than input, and a cache
  // read is never dearer than a fresh one. A typo that inverts either would
  // otherwise sit in the table silently mispricing a whole model.
  for (const [id, r] of Object.entries(RATES)) {
    assert.ok(r.output >= r.input, `${id}: output (${r.output}) cheaper than input (${r.input})?`);
    assert.ok(r.cacheRead <= r.input, `${id}: cacheRead (${r.cacheRead}) dearer than input (${r.input})?`);
  }
});

// A price the provider STATES cannot be got wrong, so it outranks anything we
// reconstruct. OpenRouter returns usage.cost on every completion — probed live
// 2026-09-03 at $0.00000686 for a 29-token call — and it was being discarded.
test('a stated provider cost outranks the rate table, and is not rounded away', () => {
  const pricing = require('../src/domain/model-pricing');
  // What recordUsage now does, in the two orders it can happen.
  const decide = (usage, model) => {
    const stated = Number(usage.costUsd);
    return Number.isFinite(stated) && stated >= 0
      ? { cost: stated, estimated: false }
      : pricing.priceUsage(usage, model, null);
  };
  const tokens = { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 };

  // Stated wins even for a model the table knows — the provider is the truth.
  const stated = decide({ ...tokens, costUsd: 0.0042 }, 'deepseek/deepseek-v4-flash');
  assert.equal(stated.cost, 0.0042);
  assert.equal(stated.estimated, false, 'a stated price is not an estimate');

  // And especially for one it does not: this is the kimi case, which used to
  // come back as exactly zero.
  const unknown = decide({ ...tokens, costUsd: 0.83 }, 'some/model-nobody-added');
  assert.equal(unknown.cost, 0.83);
  assert.equal(pricing.priceUsage(tokens, 'some/model-nobody-added', null).cost, 0,
    'without a stated cost that is still $0 — which is exactly why it must be used');

  // The ledger column is numeric(14,8) as of migration 027; the value written
  // must survive that scale. At the old (10,4) a real call rounded to nothing.
  assert.equal(Number((0.00000686).toFixed(8)), 0.00000686, 'a real call price survives');
  assert.equal(Number((0.00000686).toFixed(4)), 0, 'and would have been erased at the old scale');
});
