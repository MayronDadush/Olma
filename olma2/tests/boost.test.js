'use strict';
// Boost mode's decision layer. Everything here is about the two ways this
// feature could hurt: getting stuck ON (every user on a demo model, billed at
// demo rates, silently) and losing the way back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const boost = require('../src/domain/boost');

const BASE = 'openrouter/deepseek/deepseek-v4-flash';
const FAST = 'openrouter/openai/gpt-5.6-luna';
const cfgWith = (model, fallbacks = []) =>
  ({ agents: { defaults: { model: { primary: model, fallbacks } } } });
const T0 = new Date('2026-09-03T10:00:00Z');
const later = (min) => new Date(T0.getTime() + min * 60000);

test('engaging captures the way back before it changes anything', () => {
  const r = boost.engageState({ model: BASE, fallbacks: ['x'] }, FAST, T0);
  assert.equal(r.ok, true);
  assert.equal(r.state.restore.model, BASE);
  assert.deepEqual(r.state.restore.fallbacks, ['x']);
  assert.equal(r.state.model, FAST);
  // the 2h cap the owner asked for, stamped at engage time
  assert.equal(r.state.until, later(120).toISOString());
});

test('it refuses to record the boost model as its own restore target', () => {
  // Turning boost on while already boosted would otherwise overwrite the way
  // back with the way there, and every user stays on the demo model for good
  // — silently, because nothing about the config looks wrong afterwards.
  const r = boost.engageState({ model: FAST, fallbacks: [] }, FAST, T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /already the boost model/);
});

test('it refuses to engage when the current default cannot be read', () => {
  assert.equal(boost.engageState(null, FAST, T0).ok, false);
  assert.equal(boost.engageState({ model: null }, FAST, T0).ok, false);
});

test('expiry is re-decided every tick, so a restart cannot outlive it', () => {
  const { state } = boost.engageState({ model: BASE }, FAST, T0);
  // one minute before the deadline: still boosted
  assert.equal(boost.decide(state, cfgWith(FAST), later(119)).action, 'none');
  // one minute after: released, with the captured target
  const out = boost.decide(state, cfgWith(FAST), later(121));
  assert.equal(out.action, 'release');
  assert.equal(out.reason, 'expired');
  assert.equal(out.restore.model, BASE);
});

test('expiry releases even while the operator still believes it is on', () => {
  // The flag still says on:true. Nothing turned it off. The deadline alone
  // ends it — that is the promise "it cannot get stuck on".
  const { state } = boost.engageState({ model: BASE }, FAST, T0);
  assert.equal(state.on, true);
  assert.equal(boost.decide(state, cfgWith(FAST), later(600)).action, 'release');
});

test('an unreadable deadline reads as expired, never as forever', () => {
  const bad = { on: true, until: 'sometime', model: FAST, restore: { model: BASE } };
  assert.equal(boost.decide(bad, cfgWith(FAST), T0).action, 'release');
});

test('a malformed flag reads as OFF, and never strands users on the demo model', () => {
  for (const s of [null, undefined, {}, { on: true }, { on: true, until: 'x' },
    { on: true, until: T0.toISOString() }]) {
    assert.notEqual(boost.decide(s, cfgWith(BASE), T0).action, 'engage',
      `${JSON.stringify(s)} must not engage`);
  }
});

test('on-but-unusable alerts rather than guessing a model to restore', () => {
  // No stored restore. Writing a guess here would put every user on a model
  // nobody chose, which is worse than the stuck boost it would be papering over.
  const out = boost.decide({ on: true }, cfgWith(FAST), T0);
  assert.equal(out.action, 'alert');
  assert.match(out.reason, /no restore target/);
});

test('a steady demo does not rewrite the config every minute', () => {
  const { state } = boost.engageState({ model: BASE }, FAST, T0);
  // config already on the boost model → nothing to do
  assert.equal(boost.decide(state, cfgWith(FAST), later(5)).action, 'none');
  // config drifted back (a deploy, a hand edit) → put it back
  assert.equal(boost.decide(state, cfgWith(BASE), later(5)).action, 'engage');
});

test('the boost model can be re-pointed by flag without re-engaging', () => {
  const { state } = boost.engageState({ model: BASE }, FAST, T0);
  const other = 'openrouter/google/gemini-3.8-flash';
  const out = boost.decide(state, cfgWith(FAST), later(5), { boostModel: other });
  assert.equal(out.action, 'engage');
  assert.equal(out.model, other);
  assert.equal(out.restore.model, BASE, 'the way back is still the original default');
});

test('minutesLeft counts down and floors at zero', () => {
  const { state } = boost.engageState({ model: BASE }, FAST, T0);
  assert.equal(boost.minutesLeft(state, T0), 120);
  assert.equal(boost.minutesLeft(state, later(90)), 30);
  assert.equal(boost.minutesLeft(state, later(999)), 0);
  assert.equal(boost.minutesLeft({ on: false }, T0), 0);
});

test('currentModel reads both the string and the object form', () => {
  assert.deepEqual(boost.currentModel({ agents: { defaults: { model: 'a' } } }),
    { model: 'a', fallbacks: [] });
  assert.deepEqual(boost.currentModel(cfgWith('a', ['b'])), { model: 'a', fallbacks: ['b'] });
  assert.equal(boost.currentModel({}), null);
});
