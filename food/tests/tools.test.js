'use strict';
// Olma's food tools end to end: a real foodd on a random port, a real
// database, the box-only POST /api/tool, and the MCP shim spawned the way the
// gateway spawns it. brokerd is replaced by `identify` and `card`, the two
// seams createServer takes for it.
//
// No assertion here depends on the hour or the weekday the suite runs at:
// every meal names its slot, and the auto meal is run at a moment computed
// once from the person's own "today".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const { TOOL_DEFS, IDENTITY_PARAM } = require('../src/tool-defs');
const store = require('../src/store');
const D = require('../src/days');

const TOK = n => 'olma_tok_' + String(n).repeat(32).slice(0, 32);
const PEOPLE = {
  [TOK(1)]: { ok: true, user: { id: 101, name: 'מיכל', timezone: 'Asia/Jerusalem', locale: 'he' }, packs: ['food'] },
  [TOK(2)]: { ok: true, user: { id: 102, name: 'דני', timezone: 'Asia/Jerusalem', locale: 'he' }, packs: ['games', 'food'] },
  [TOK(3)]: { ok: true, user: { id: 103, name: 'בלי', timezone: 'Asia/Jerusalem', locale: 'he' }, packs: ['games'] },
};
const identify = async token => PEOPLE[token] || { ok: false, error: { code: 'forbidden', message: 'unknown identity token — re-read AGENTS.md' } };

const EGGS = { name: 'ביצים · 2', grams: 120, group: 'protein', per100: { kcal: 143, protein: 12.6, carbs: 0.7, fat: 9.5 } };
const TAHINI = { name: 'טחינה', grams: 25, group: 'fat', per100: { kcal: 595, protein: 17, carbs: 21, fat: 54 }, confidence: 'low' };
const SAUCE = { name: 'רוטב עגבניות', grams: 180, group: 'veg', per100: { kcal: 50, protein: 1.5, carbs: 6, fat: 2.5 } };
const PITA = { name: 'פיתה · חצי', grams: 60, group: 'grain', per100: { kcal: 275, protein: 9, carbs: 55, fat: 1.2 } };
const LATTE = { name: 'קפה הפוך', grams: 240, group: 'drink', per100: { kcal: 54, protein: 3.3, carbs: 4.8, fat: 2.4 } };

async function boot(t, { card } = {}) {
  const pool = await freshDb(t);
  // Written for somebody who asked for numbers; the default (off) is tested in server.test.js.
  await pool.query('ALTER TABLE people ALTER COLUMN numbers SET DEFAULT true');
  const cards = [];
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html>', identify,
    card: card || (async x => { cards.push(x); return { ok: true, path: '/root/.openclaw/workspaces/u-101/cards/x.png', invite_link: 'https://allma.world/i/AB12' }; }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const raw = (name, args, headers = {}) => fetch(`http://127.0.0.1:${port}/api/tool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ name, args }),
  });
  const call = async (tok, name, args = {}) => {
    const r = await raw(name, { [IDENTITY_PARAM]: tok, ...args });
    assert.equal(r.status, 200);
    return (await r.json()).text;
  };
  const okOf = async (tok, name, args) => {
    const text = await call(tok, name, args);
    assert.match(text, /^OK /, text);
    return JSON.parse(text.slice(3));
  };
  return { pool, port, raw, call, okOf, cards };
}

test('every definition fits Olma\'s limits: identity first and required, under 700 characters, unique names', () => {
  assert.equal(new Set(TOOL_DEFS.map(d => d.name)).size, TOOL_DEFS.length);
  for (const d of TOOL_DEFS) {
    assert.ok(d.description.length <= 700, d.name);
    assert.equal(Object.keys(d.inputSchema.properties)[0], IDENTITY_PARAM, d.name);
    assert.equal(d.inputSchema.required[0], IDENTITY_PARAM, d.name);
  }
});

test('the pack is the lock: no pack, an unknown token, or a call through a proxy are all refused', async t => {
  const { call, raw } = await boot(t);
  assert.match(await call(TOK(3), 'food_today'), /^ERROR forbidden: food tracking is not turned on/);
  assert.match(await call('olma_tok_' + 'f'.repeat(32), 'food_today'), /^ERROR forbidden: unknown identity token/);
  const proxied = await raw('food_today', { [IDENTITY_PARAM]: TOK(1) }, { 'X-Forwarded-For': '1.2.3.4' });
  assert.equal(proxied.status, 404);
  assert.match(await call(TOK(1), 'no_such_tool'), /^ERROR unknown_tool/);
});

test('a meal from a photo: items, totals, what is left, and a correction that becomes their portion next time', async t => {
  const { okOf } = await boot(t);
  const a = await okOf(TOK(1), 'log_meal', { title: 'שקשוקה עם פיתה וטחינה', meal: 'dinner', source: 'photo', items: [EGGS, SAUCE, PITA, TAHINI] });
  assert.equal(a.logged.meal, 'dinner');
  assert.equal(a.logged.items.length, 4);
  assert.equal(a.for_day, 'today');
  assert.deepEqual(a.logged.plate, ['חלבון', 'ירקות ופירות', 'פחמימות']);
  assert.equal(a.today.left.kcal, 2000 - a.logged.totals.kcal);

  const e = await okOf(TOK(1), 'edit_meal', { changes: [{ item: 'טחינה', grams: 40 }] });
  assert.deepEqual(e.learned, [{ name: 'טחינה', grams: 40, from: 25 }]);
  assert.equal(e.meal.items.find(i => i.name === 'טחינה').grams, 40);

  // The next plate with tahini starts from 40, and the answer says so...
  const b = await okOf(TOK(1), 'log_meal', { title: 'סביח', meal: 'lunch', items: [{ ...TAHINI, grams: 20 }] });
  assert.deepEqual(b.applied_portions, [{ name: 'טחינה', from: 20, to: 40 }]);
  assert.equal(b.logged.items[0].their_portion, true);
  // ...unless they said the amount themselves.
  const c = await okOf(TOK(1), 'log_meal', { title: 'סלט', meal: 'snack', items: [{ ...TAHINI, grams: 15, said: true }] });
  assert.equal(c.applied_portions, undefined);
  assert.equal(c.logged.items[0].grams, 15);

  const mine = await okOf(TOK(1), 'my_portions', {});
  assert.deepEqual(mine.portions, [{ name: 'טחינה', grams: 40 }]);
  assert.deepEqual(await okOf(TOK(1), 'my_portions', { forget: 'טחינה' }), { forgotten: 'טחינה' });
});

test('impossible values are refused whole, and nothing is written', async t => {
  const { call, okOf } = await boot(t);
  assert.match(await call(TOK(1), 'log_meal', { title: 'x', items: [{ name: 'מלפפון', grams: 100, per100: { kcal: 2000, protein: 1, carbs: 1, fat: 1 } }] }), /^ERROR bad_values/);
  assert.match(await call(TOK(1), 'log_meal', { title: 'x', items: [{ name: 'שמן', grams: 10, per100: { kcal: 100, protein: 0, carbs: 0, fat: 100 } }] }), /^ERROR bad_values/);
  assert.match(await call(TOK(1), 'log_meal', { title: 'x', items: [] }), /^ERROR no_items/);
  assert.match(await call(TOK(1), 'log_meal', { title: 'x', date: '2020-01-01', items: [EGGS] }), /^ERROR too_old/);
  assert.equal((await okOf(TOK(1), 'food_today', {})).meals.length, 0);
});

test('late logging lands on the day it was eaten, and today does not move', async t => {
  const { okOf } = await boot(t);
  const a = await okOf(TOK(1), 'log_meal', { title: 'פיצה משפחתית', date: 'yesterday', meal: 'dinner', shared_part: '2 מתוך 8 משולשים',
    items: [{ name: 'פיצה · 2 משולשים', grams: 220, group: 'grain', per100: { kcal: 266, protein: 11, carbs: 33, fat: 10 } }] });
  assert.notEqual(a.for_day, 'today');
  assert.equal(a.logged.shared_part, '2 מתוך 8 משולשים');
  assert.equal(a.that_day.totals.kcal, 585);
  assert.equal((await okOf(TOK(1), 'food_today', {})).totals.kcal, 0);
});

test('a plate after midnight is that evening\'s dinner, and the day turns at 04:00', async t => {
  // Fixed instants, so the hour the suite runs at never matters. 21:41Z in
  // October is 00:41 in Jerusalem on the 8th.
  assert.equal(D.today('Asia/Jerusalem', new Date('2026-10-07T21:41:00Z')), '2026-10-07');
  assert.equal(D.today('Asia/Jerusalem', new Date('2026-10-08T00:59:00Z')), '2026-10-07');
  assert.equal(D.today('Asia/Jerusalem', new Date('2026-10-08T01:00:00Z')), '2026-10-08');
  assert.equal(D.slotAt(0), 'dinner');
  assert.equal(D.slotAt(23, { hasDinner: true }), 'snack');
  assert.equal(D.slotAt(4), 'breakfast');

  const { pool, okOf } = await boot(t);
  await okOf(TOK(1), 'food_today', {});
  const p = await store.reload(pool, 101);
  const at = new Date('2026-10-07T21:41:00Z');
  const a = await store.logMeal(pool, p, { title: 'שקשוקה', items: [EGGS, SAUCE] }, { via: 'olma', at });
  // The date a model reads off the clock after midnight is tonight too, not a future day.
  const b = await store.logMeal(pool, p, { title: 'פיתה', date: '2026-10-08', items: [PITA] }, { via: 'olma', at });
  const { rows } = await pool.query('SELECT day::text AS day, slot FROM meals WHERE user_id = 101 AND id = ANY($1) ORDER BY id', [[a.meal.id, b.meal.id]]);
  assert.deepEqual(rows, [{ day: '2026-10-07', slot: 'dinner' }, { day: '2026-10-07', slot: 'snack' }]);
});

test('no-numbers mode: no calorie or gram reaches the model, and turning it back on loses nothing', async t => {
  const { okOf } = await boot(t);
  await okOf(TOK(1), 'log_meal', { title: 'שקשוקה', meal: 'dinner', items: [EGGS, SAUCE] });
  await okOf(TOK(1), 'food_numbers', { on: false });
  const today = await okOf(TOK(1), 'food_today', {});
  const json = JSON.stringify(today);
  for (const k of ['"kcal"', '"grams"', '"totals"', '"left"', '"protein":']) assert.ok(!json.includes(k), `${k} leaked: ${json}`);
  assert.deepEqual(today.plate, { meals: 1, with_protein: 1, with_vegetables: 1, with_grains: 0 });
  const logged = await okOf(TOK(1), 'log_meal', { title: 'פיתה', meal: 'snack', items: [PITA] });
  assert.ok(!JSON.stringify(logged).includes('kcal'));
  await okOf(TOK(1), 'food_numbers', { on: true });
  assert.equal((await okOf(TOK(1), 'food_today', {})).totals.kcal, 427);
});

test('delete and edit act on the last meal when none is named, and an emptied meal is gone', async t => {
  const { okOf } = await boot(t);
  await okOf(TOK(1), 'log_meal', { title: 'בוקר', meal: 'breakfast', items: [EGGS] });
  const b = await okOf(TOK(1), 'log_meal', { title: 'הפוך', meal: 'breakfast', items: [LATTE] });
  const d = await okOf(TOK(1), 'delete_meal', {});
  assert.equal(d.deleted.id, b.logged.meal_id);
  const e = await okOf(TOK(1), 'edit_meal', { changes: [{ item: 'ביצים', remove: true }] });
  assert.equal(e.deleted, true);
  assert.equal((await okOf(TOK(1), 'food_today', {})).meals.length, 0);
});

test('water: a cup at a time, or the day\'s count', async t => {
  const { okOf } = await boot(t);
  assert.equal((await okOf(TOK(1), 'log_water', {})).cups, 1);
  assert.equal((await okOf(TOK(1), 'log_water', { add: 2 })).cups, 3);
  assert.equal((await okOf(TOK(1), 'log_water', { cups: 6 })).cups, 6);
  assert.equal((await okOf(TOK(1), 'log_water', { add: -10 })).cups, 0);
});

test('a goal takes two calls, the second only after a proposal; under 18 no calorie goal at all', async t => {
  const { okOf, call } = await boot(t);
  assert.match(await call(TOK(1), 'set_food_goal', { confirm: true }), /^ERROR no_proposal/);
  assert.match(await call(TOK(1), 'set_food_goal', { height: 178 }), /^ERROR missing: .*weight/);
  const p = await okOf(TOK(1), 'set_food_goal', { height: 178, weight: 80, age: 32, sex: 'male', activity: 'some', aim: 'lose' });
  assert.equal(p.needs_confirmation, true);
  // 10*80 + 6.25*178 - 5*32 + 5 = 1757.5; x1.5 - 400 = 2236 -> 2250
  assert.equal(p.proposal.kcal, 2250);
  assert.equal(p.proposal.protein, 145);
  assert.equal((await okOf(TOK(1), 'food_today', {})).goal.kcal, 2000, 'nothing saved before the yes');
  const s = await okOf(TOK(1), 'set_food_goal', { confirm: true });
  assert.equal(s.saved.kcal, 2250);
  assert.equal((await okOf(TOK(1), 'food_today', {})).goal.set, true);

  const young = await okOf(TOK(2), 'set_food_goal', { height: 165, weight: 55, age: 16, sex: 'female', activity: 'some', aim: 'lose' });
  assert.equal(young.goal, null);
  assert.equal(young.numbers, false);
});

test('like yesterday and the usual: listed with ids, logged again in one call, and a daily one logs itself once a day', async t => {
  const { pool, okOf } = await boot(t);
  await okOf(TOK(1), 'log_meal', { title: 'יוגורט עם גרנולה', meal: 'breakfast', date: 'yesterday', items: [EGGS] });
  for (let i = 2; i <= 4; i++) await okOf(TOK(1), 'log_meal', { title: 'הפוך של הבוקר', meal: 'breakfast', date: D.addDays(D.today('Asia/Jerusalem'), -i), items: [LATTE] });
  const u = await okOf(TOK(1), 'usual_meals', {});
  assert.deepEqual(u.yesterday.map(m => m.title), ['יוגורט עם גרנולה']);
  assert.equal(u.usual[0].title, 'הפוך של הבוקר');
  assert.equal(u.usual[0].times_in_4_weeks, 3);

  const r = await okOf(TOK(1), 'relog_meal', { meal_id: u.yesterday[0].meal_id, meal: 'breakfast' });
  assert.equal(r.logged.title, 'יוגורט עם גרנולה');

  const auto = await okOf(TOK(1), 'auto_log_meal', { meal_id: u.usual[0].meal_id, on: true, hour: 8 });
  assert.equal(auto.auto, true);
  // Tomorrow at 09:00 Jerusalem time it is written once, however many ticks run.
  const tomorrow = D.addDays(D.today('Asia/Jerusalem'), 1);
  const at = new Date(`${tomorrow}T06:00:00Z`);
  assert.equal((await store.runAuto(pool, { at })).length, 1);
  assert.equal((await store.runAuto(pool, { at })).length, 0);
  const p = await store.reload(pool, 101);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM meals WHERE user_id = 101 AND day = $1 AND source = 'auto'`, [tomorrow]);
  assert.equal(rows[0].n, 1);
  assert.equal(p.user_id, 101);
  assert.equal((await okOf(TOK(1), 'auto_log_meal', { title: 'הפוך של הבוקר', on: false })).auto, false);
});

test('a challenge counts from the meals themselves', async t => {
  const { okOf } = await boot(t);
  const c = await okOf(TOK(1), 'food_challenge', { challenge: 'veg_dinner' });
  assert.equal(c.he, 'ירק בכל ארוחת ערב');
  assert.equal((await okOf(TOK(1), 'food_today', {})).challenge.today_met, null);
  await okOf(TOK(1), 'log_meal', { title: 'שקשוקה', meal: 'dinner', items: [EGGS, SAUCE] });
  assert.equal((await okOf(TOK(1), 'food_today', {})).challenge.today_met, true);
  assert.equal((await okOf(TOK(1), 'food_challenge', { challenge: 'none' })).challenge, null);
});

test('the day card: drawn by brokerd from an SVG with no calories, attached with its caption and invite link', async t => {
  const { okOf, call, cards } = await boot(t);
  assert.match(await call(TOK(1), 'day_card', {}), /^ERROR empty/);
  await okOf(TOK(1), 'log_meal', { title: 'שקשוקה 🍳', meal: 'dinner', items: [EGGS, SAUCE] });
  const c = await okOf(TOK(1), 'day_card', {});
  assert.match(c.next_step, /MEDIA: \/root\/\.openclaw\/workspaces\/u-101\/cards\/x\.png/);
  assert.match(c.caption, /https:\/\/allma\.world\/i\/AB12/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].userId, 101);
  assert.ok(cards[0].svg.startsWith('<svg'));
  assert.ok(!/קק"ל|קק״ל|kcal/.test(cards[0].svg), 'no calories on a card meant for sharing');
  assert.ok(!/\p{Extended_Pictographic}/u.test(cards[0].svg), 'no emoji: resvg draws them as nothing');
});

test('a card brokerd could not draw falls back to the page link', async t => {
  const { okOf } = await boot(t, { card: async () => ({ ok: false, error: 'no workspace' }) });
  await okOf(TOK(1), 'log_meal', { title: 'שקשוקה', meal: 'dinner', items: [EGGS] });
  const c = await okOf(TOK(1), 'day_card', {});
  assert.equal(c.drawn, false);
  assert.match(c.url, /^https:\/\/allma\.test\/food\/[A-Za-z0-9]{22}$/);
});

test('three very low days in a row bring a care note, once', async t => {
  const { okOf } = await boot(t);
  const today = D.today('Asia/Jerusalem');
  const notes = [];
  for (let i = 1; i <= 3; i++) for (const slot of ['breakfast', 'lunch']) {
    notes.push((await okOf(TOK(2), 'log_meal', { title: 'סלט', meal: slot, date: D.addDays(today, -i), items: [SAUCE] })).care);
  }
  // Only the call that completed the third day carries it.
  assert.deepEqual(notes.slice(0, 5), [undefined, undefined, undefined, undefined, undefined]);
  assert.match(notes[5], /never suggest eating less/);
  assert.equal((await okOf(TOK(2), 'food_today', {})).care, undefined);
});

test('the MCP shim: lists the tools and passes a call through, self-healing a malformed token', async t => {
  const { port } = await boot(t);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'food-mcp.js')], {
    env: { ...process.env, FOOD_PORT: String(port) }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', ch => {
    buf += ch;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(r => { id += 1; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'food');
  assert.deepEqual((await rpc('tools/list')).result.tools.map(d => d.name), TOOL_DEFS.map(d => d.name));
  const text = async args => (await rpc('tools/call', { name: 'log_water', arguments: args })).result.content[0].text;
  assert.match(await text({ [IDENTITY_PARAM]: 'olma_tok_abc' }), /^ERROR forbidden/, 'nothing proven yet: no repair');
  assert.match(await text({ [IDENTITY_PARAM]: TOK(1) }), /^OK /);
  assert.match(await text({ [IDENTITY_PARAM]: 'olma_tok_abc' }), /"cups":2/, 'repaired to the proven token');
});
