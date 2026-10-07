'use strict';
// The page's door: what Caddy passes (the page, its state, its writes, the
// card preview) and what it must never pass (/api/tool, /health from outside).
// Every write here is the same store function a tool calls, so these also
// prove the two doors agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const store = require('../src/store');

const EGGS = { name: 'ביצים · 2', grams: 120, group: 'protein', per100: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 } };
const TAHINI = { name: 'טחינה', grams: 25, group: 'fat', per100: { kcal: 595, protein: 17, carbs: 21, fat: 54 } };

async function boot(t) {
  const pool = await freshDb(t);
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html><title>page</title>', identify: async () => ({ ok: false }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const p = await store.ensurePerson(pool, { id: 7, name: 'נועה', timezone: 'Asia/Jerusalem', locale: 'he' });
  const { meal } = await store.logMeal(pool, p, { title: 'שקשוקה', meal: 'dinner', items: [EGGS, TAHINI] });
  const state = () => fetch(`${base}/food/${p.token}/api/state`).then(r => r.json());
  const write = (body, headers = {}) => fetch(`${base}/food/${p.token}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { pool, base, p, meal, state, write };
}

test('the page and its state answer only for a real link', async t => {
  const { base, p } = await boot(t);
  const page = await fetch(`${base}/food/${p.token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /<title>page<\/title>/);
  assert.equal((await fetch(`${base}/food/${'A'.repeat(22)}`)).status, 404);
  assert.equal((await fetch(`${base}/food/short`)).status, 404);
  assert.equal((await fetch(`${base}/food/${'A'.repeat(22)}/api/state`)).status, 404);
  const s = await (await fetch(`${base}/food/${p.token}/api/state`)).json();
  assert.equal(s.meals.length, 1);
  assert.equal(s.person.name, 'נועה');
});

test('box-only routes refuse anything that came through the proxy', async t => {
  const { base } = await boot(t);
  assert.equal((await fetch(`${base}/api/tool`, { method: 'POST', headers: { 'X-Forwarded-For': '1.1.1.1' }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/health`, { headers: { 'X-Forwarded-For': '1.1.1.1' } })).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a tap that changes an amount is a lesson, the same as telling Olma', async t => {
  const { pool, p, meal, write } = await boot(t);
  const tahini = meal.items.find(i => i.name === 'טחינה');
  const r = await (await write({ op: 'item_grams', meal_id: meal.id, item_id: tahini.id, grams: 40 })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.learned, [{ name: 'טחינה', grams: 40, from: 25 }]);
  assert.equal(r.state.meals[0].items.find(i => i.id === tahini.id).grams, 40);
  assert.deepEqual((await store.portionsOf(pool, p)).map(x => [x.name, x.grams]), [['טחינה', 40]]);
});

test('every control on the page is a write the server checks', async t => {
  const { meal, write, state } = await boot(t);
  const ok = async b => { const r = await write(b); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };
  assert.equal((await ok({ op: 'water', cups: 4 })).state.water, 4);
  assert.equal((await ok({ op: 'numbers', on: false })).state.person.numbers, false);
  assert.equal((await ok({ op: 'numbers', on: true })).state.person.numbers, true);
  assert.equal((await ok({ op: 'challenge', key: 'water6' })).state.challenge.key, 'water6');
  assert.equal((await ok({ op: 'goal', kcal: 2300, protein: 140, carbs: 250, fat: 75 })).state.person.goal.set, true);
  assert.equal((await ok({ op: 'meal_slot', meal_id: meal.id, slot: 'lunch' })).state.meals[0].slot, 'lunch');
  assert.equal((await ok({ op: 'relog', meal_id: meal.id })).state.meals.length, 2);
  assert.equal((await ok({ op: 'meal_delete', meal_id: meal.id })).state.meals.length, 1);
  // Refusals are a code, never a half-write.
  assert.equal((await write({ op: 'water', cups: 99 })).status, 400);
  assert.equal((await write({ op: 'goal', kcal: 100, protein: 1, carbs: 1, fat: 1 })).status, 400);
  assert.equal((await write({ op: 'meal_delete', meal_id: 999999 })).status, 404);
  assert.equal((await write({ op: 'nope' })).status, 400);
  assert.equal((await state()).person.goal.kcal, 2300);
});

test('a page link reaches only its own person\'s meals', async t => {
  const { pool, base, meal } = await boot(t);
  const other = await store.ensurePerson(pool, { id: 8, name: 'אחר', timezone: 'Asia/Jerusalem', locale: 'he' });
  const r = await fetch(`${base}/food/${other.token}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'meal_delete', meal_id: meal.id }) });
  assert.equal(r.status, 404);
});

test('the card preview is an SVG with no calories on it', async t => {
  const { base, p } = await boot(t);
  const r = await fetch(`${base}/food/${p.token}/card.svg`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await r.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /שקשוקה/);
  assert.ok(!/קק״ל|kcal/.test(svg));
});
