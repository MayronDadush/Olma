'use strict';
// The reconciler. The domain decides; this proves the writing half keeps the
// two promises — it always leaves a way back, and it ends on time by itself.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const job = require('../src/jobs/boost');
const flags = require('../src/domain/flags');
const boost = require('../src/domain/boost');

const BASE = 'openrouter/deepseek/deepseek-v4-flash';
const FAST = 'openrouter/openai/gpt-5.6-luna';
let db;

before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A config that lives in memory instead of on the box.
function fakeConfig(model = BASE, fallbacks = ['anthropic/claude-haiku-4-5']) {
  const box = { cfg: { agents: { defaults: { model: { primary: model, fallbacks } } } }, writes: 0 };
  return {
    box,
    deps: {
      loadConfig: () => JSON.parse(JSON.stringify(box.cfg)),
      saveConfig: (c) => { box.cfg = c; box.writes += 1; },
    },
  };
}
const modelOf = (box) => box.cfg.agents.defaults.model.primary;

beforeEach(async () => {
  await flags.setFlag(db.pool, job.STATE_FLAG, { on: false });
  await flags.setFlag(db.pool, job.MODEL_FLAG, FAST);
});

test('off: the reconciler writes nothing at all', async () => {
  const { box, deps } = fakeConfig();
  const r = await job.run(db.pool, { ...deps, now: new Date() });
  assert.equal(r.action, 'none');
  assert.equal(box.writes, 0, 'an idle tick must not touch the config');
  assert.equal(modelOf(box), BASE);
});

test('engaging moves everyone onto the boost model', async () => {
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);

  const r = await job.run(db.pool, { ...deps, now });
  assert.equal(r.action, 'engage');
  assert.equal(modelOf(box), FAST);
});

test('a steady demo does not rewrite the config every tick', async () => {
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);

  await job.run(db.pool, { ...deps, now });
  const after1 = box.writes;
  await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 60000) });
  await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 120000) });
  assert.equal(box.writes, after1, 'each write costs a gateway hot reload');
});

test('it ends itself two hours later with nobody touching anything', async () => {
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);
  await job.run(db.pool, { ...deps, now });
  assert.equal(modelOf(box), FAST);

  // 2h01m later. The flag still says on:true — nothing turned it off.
  const r = await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 121 * 60000) });
  assert.equal(r.action, 'release');
  assert.equal(r.reason, 'expired');
  assert.equal(modelOf(box), BASE, 'the captured default, not a guess');
  assert.deepEqual(box.cfg.agents.defaults.model.fallbacks, ['anthropic/claude-haiku-4-5']);
  assert.equal((await flags.getFlag(db.pool, job.STATE_FLAG)).on, false);
});

test('config is restored BEFORE the flag is cleared, so a crash between them is safe', async () => {
  // Simulate dying right after the config write: flag still on, config already
  // back. The next tick must be a no-op, not a re-engage.
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);
  await job.run(db.pool, { ...deps, now });

  const expiredNow = new Date(now.getTime() + 121 * 60000);
  const crashing = { ...deps, saveConfig: deps.saveConfig };
  await job.run(db.pool, { ...crashing, now: expiredNow });
  // re-run as if the flag write had been lost
  await flags.setFlag(db.pool, job.STATE_FLAG, state);
  const r = await job.run(db.pool, { ...deps, now: expiredNow });
  assert.equal(r.action, 'release');
  assert.equal(modelOf(box), BASE, 'still the real default, never re-boosted');
});

test('drift back to the default mid-demo is put right on the next tick', async () => {
  // A deploy or a hand edit reset the model while a demo was running.
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);
  await job.run(db.pool, { ...deps, now });

  box.cfg.agents.defaults.model.primary = BASE;
  const r = await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 60000) });
  assert.equal(r.action, 'engage');
  assert.equal(modelOf(box), FAST);
});

test('on-but-unusable audits and refuses to write a model nobody chose', async () => {
  const { box, deps } = fakeConfig(FAST);
  await flags.setFlag(db.pool, job.STATE_FLAG, { on: true });   // no restore
  const r = await job.run(db.pool, { ...deps, now: new Date() });
  assert.equal(r.action, 'alert');
  assert.equal(box.writes, 0);
  const { rows } = await db.pool.query(
    `SELECT event FROM audit_log WHERE event = 'boost.unusable' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows.length, 1, 'a refusal nobody can see is a silent failure');
});

test('an unreadable config is reported, never worked around', async () => {
  const r = await job.run(db.pool, {
    loadConfig: () => { throw new Error('EACCES'); },
    saveConfig: () => assert.fail('must not write against an unreadable config'),
    now: new Date(),
  });
  assert.equal(r.skipped, 'config unreadable');
});

test('re-pointing the model flag mid-demo keeps the original way back', async () => {
  const { box, deps } = fakeConfig();
  const now = new Date();
  const { state } = boost.engageState(boost.currentModel(box.cfg), FAST, now);
  await flags.setFlag(db.pool, job.STATE_FLAG, state);
  await job.run(db.pool, { ...deps, now });

  await flags.setFlag(db.pool, job.MODEL_FLAG, 'openrouter/google/gemini-3.8-flash');
  await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 60000) });
  assert.equal(modelOf(box), 'openrouter/google/gemini-3.8-flash');

  const r = await job.run(db.pool, { ...deps, now: new Date(now.getTime() + 121 * 60000) });
  assert.equal(r.action, 'release');
  assert.equal(modelOf(box), BASE, 'still the default captured at engage time');
});
