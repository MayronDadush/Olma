'use strict';
// The photo step and the table: a picture comes in through brokerd's
// pack_media (replaced here by `media`), a model names what it sees
// (replaced by `fetchImpl`), and every value comes from the USDA table in
// data/, through food_names. No network: a test that could spend money on a
// model is a test that one day will.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const { IDENTITY_PARAM } = require('../src/tool-defs');
const foods = require('../src/foods');
const vision = require('../src/vision');
const store = require('../src/store');
const photos = require('../src/photos');
const fs = require('fs');
const path = require('path');

const TOK = 'olma_tok_' + '1'.repeat(32);
const identify = async token => (token === TOK ? { ok: true, user: { id: 201, name: 'נועה', timezone: 'Asia/Jerusalem', locale: 'he' }, packs: ['food'] } : { ok: false, error: { message: 'unknown' } });
const PHOTO = { ok: true, mime: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64') };

// A model, by hand: the picture gets `seen`; a matching request gets the
// first row of each shortlist unless `pick` says otherwise.
function fakeModel({ seen, pick } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const content = body.messages[0].content;
    const isPhoto = Array.isArray(content);
    calls.push({ purpose: isPhoto ? 'see' : 'match', body });
    let answer;
    if (isPhoto) answer = JSON.stringify(seen);
    else {
      const picks = [];
      for (const m of content.matchAll(/Item (\d+): "([^"]+)"[^\n]*\n((?:  \d+: [^\n]*\n?)+)/g)) {
        const ids = [...m[3].matchAll(/ {2}(\d+): /g)].map(x => Number(x[1]));
        picks.push({ i: Number(m[1]), id: pick ? pick(m[2], ids) : ids[0] });
      }
      answer = '```json\n' + JSON.stringify({ picks }) + '\n```';
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: answer } }], usage: { cost: 0.0009 } }) };
  };
  return { fetchImpl, calls };
}

async function boot(t, { seen, pick, media = async () => PHOTO } = {}) {
  process.env.FOOD_OPENROUTER_KEY = 'test-key';
  t.after(() => { delete process.env.FOOD_OPENROUTER_KEY; foods.reset(); });
  const pool = await freshDb(t);
  // Written for somebody who asked for numbers; the default (off) is tested in server.test.js.
  await pool.query('ALTER TABLE people ALTER COLUMN numbers SET DEFAULT true');
  const seeded = await foods.seed(pool);
  const model = fakeModel({ seen, pick });
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html>', identify, media, fetchImpl: model.fetchImpl });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const call = async (name, args = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args: { [IDENTITY_PARAM]: TOK, ...args } }) });
    return (await r.json()).text;
  };
  const okOf = async (name, args) => { const text = await call(name, args); assert.match(text, /^OK /, text); return JSON.parse(text.slice(3)); };
  return { pool, port, call, okOf, seeded, model };
}

const PLATE = {
  title: 'ביצים ובטטה', food: true, question: 'היה שמן בבטטה? בערך כמה כפות?',
  items: [
    { name: 'ביצים מקושקשות', name_en: 'scrambled eggs', grams: 130, group: 'protein', confidence: 'high' },
    { name: 'בטטה צלויה', name_en: 'sweet potato, roasted', grams: 90, group: 'grain', confidence: 'mid' },
    { name: 'משהו ירוק', name_en: 'zzqx unknownleaf', grams: 20, group: 'veg', confidence: 'low' },
  ],
};

test('the table loads once, with the names the bench matched, and a second load adds nothing', async t => {
  const { pool, seeded } = await boot(t);
  assert.ok(seeded.loaded > 7000, `rows: ${seeded.loaded}`);
  assert.ok(seeded.named > 400, `names: ${seeded.named}`);
  const again = await foods.seed(pool);
  assert.deepEqual(again, { loaded: 0, named: 0 });
  const { rows: [eggs] } = await pool.query(`SELECT f.name_en, f.kcal100 FROM food_names n JOIN foods f ON f.id = n.food_id WHERE n.name = 'scrambled eggs'`);
  assert.equal(eggs.name_en, 'Egg, whole, cooked, scrambled');
  assert.equal(Number(eggs.kcal100), 149);
});

test('a photo is read, valued from the table by name, logged, and its one question is handed on', async t => {
  const { okOf, pool, model } = await boot(t, { seen: PLATE });
  const r = await okOf('see_meal_photo', { path: '/root/.openclaw/media/inbound/p1.jpg', meal: 'lunch' });
  assert.equal(r.logged.meal, 'lunch');
  assert.equal(r.logged.title, 'ביצים ובטטה');
  const eggs = r.logged.items.find(i => i.name === 'ביצים מקושקשות');
  assert.equal(eggs.kcal, Math.round(149 * 1.3), 'eggs from the table row, not the model');
  assert.equal(r.ask, PLATE.question);
  assert.match(r.note, /edit_meal/);
  assert.deepEqual(r.estimated, ['משהו ירוק'], 'nothing in the table: a group value, said out loud');
  const { rows } = await pool.query('SELECT name, value_src, food_id FROM items ORDER BY ord');
  assert.deepEqual(rows.map(x => x.value_src), ['table', 'table', 'group']);
  assert.ok(rows[0].food_id && rows[1].food_id && !rows[2].food_id);
  // "sweet potato, roasted" was in the seed; nothing needed matching.
  assert.deepEqual(model.calls.map(c => c.purpose), ['see']);
  assert.equal(model.calls[0].body.model, 'google/gemini-3.5-flash-lite');
  assert.equal(model.calls[0].body.temperature, 0);
  const { rows: calls } = await pool.query('SELECT purpose, ok, cost_usd FROM model_calls');
  assert.deepEqual(calls.map(c => [c.purpose, c.ok, Number(c.cost_usd)]), [['see', true, 0.0009]]);
});

test('a new name is matched once, from its own shortlist only, and then known to everybody', async t => {
  const seen = { title: 'קערה', items: [{ name: 'קינואה', name_en: 'quinoa, cooked, warm', grams: 150, group: 'grain' }] };
  const { okOf, pool, model } = await boot(t, { seen });
  await okOf('see_meal_photo', { path: '/x/p.jpg', meal: 'lunch' });
  assert.deepEqual(model.calls.map(c => c.purpose), ['see', 'match']);
  const { rows: [n] } = await pool.query(`SELECT via, f.name_en FROM food_names n JOIN foods f ON f.id = n.food_id WHERE n.name = 'quinoa, cooked, warm'`);
  assert.equal(n.via, 'model');
  assert.match(n.name_en, /quinoa/i);
  await okOf('see_meal_photo', { path: '/x/p2.jpg', meal: 'dinner' });
  assert.deepEqual(model.calls.map(c => c.purpose), ['see', 'match', 'see'], 'the second time it is simply known');
});

test('a pick outside the shortlist is ignored: the item keeps the model\'s values or a group value, never a stranger\'s row', async t => {
  const seen = { title: 'x', items: [{ name: 'לחם', name_en: 'bread, homestyle loaf', grams: 60, group: 'grain' }] };
  const { okOf, pool } = await boot(t, { seen, pick: () => 999999 });
  const r = await okOf('see_meal_photo', { path: '/x/p.jpg', meal: 'lunch' });
  assert.deepEqual(r.estimated, ['לחם']);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM food_names WHERE name = 'bread, homestyle loaf'`);
  assert.equal(rows[0].n, 0);
});

test('log_meal from words takes the table too; a label keeps its own values; a forged food_id is dropped', async t => {
  const { okOf, pool } = await boot(t);
  const r = await okOf('log_meal', { title: 'בוקר', meal: 'breakfast', items: [
    { name: 'ביצים', name_en: 'scrambled eggs', grams: 100, per100: { kcal: 300, protein: 1, carbs: 1, fat: 1 }, food_id: 1 },
    { name: 'יוגורט', name_en: 'yogurt, plain', grams: 150, confidence: 'label', per100: { kcal: 62, protein: 5, carbs: 4, fat: 3 } },
  ] });
  assert.equal(r.logged.items[0].kcal, 149, 'the table, not the 300 it was sent');
  assert.equal(r.logged.items[1].kcal, 93, 'the label wins');
  const { rows } = await pool.query('SELECT value_src, food_id FROM items ORDER BY ord');
  assert.equal(rows[0].value_src, 'table');
  assert.notEqual(rows[0].food_id, 1);
  assert.deepEqual([rows[1].value_src, rows[1].food_id], ['label', null]);
});

test('refusals: no path, a picture brokerd will not hand over, no food in it, no model key', async t => {
  const { call, okOf } = await boot(t, { seen: { food: false, items: [] }, media: async ({ path }) => (path.includes('old') ? { ok: false, code: 'too_old', error: 'that picture arrived more than two hours ago' } : PHOTO) });
  assert.match(await call('see_meal_photo', {}), /^ERROR missing: path/);
  assert.match(await call('see_meal_photo', { path: '/x/old.jpg' }), /^ERROR too_old: .*Never invent or reuse a path/);
  const none = await okOf('see_meal_photo', { path: '/x/cat.jpg' });
  assert.equal(none.logged, null);
  assert.match(none.note, /no food/);
  delete process.env.FOOD_OPENROUTER_KEY;
  assert.match(await call('see_meal_photo', { path: '/x/p.jpg' }), /^ERROR unavailable: .*log_meal/);
});

test('no-numbers mode: a photo result carries no calorie or gram', async t => {
  const { okOf } = await boot(t, { seen: PLATE });
  await okOf('food_numbers', { on: false });
  const r = await okOf('see_meal_photo', { path: '/x/p.jpg', meal: 'lunch' });
  assert.doesNotMatch(JSON.stringify(r), /"(kcal|grams|totals|left)"/);
});

test('what a model answers is made safe before anything uses it', () => {
  const long = 'א'.repeat(200);
  const c = vision.clean({ title: ` ${long} `, question: '', items: [
    { name: long, name_en: 'x'.repeat(300), grams: '120.4', group: 'bogus', confidence: 'sure' },
    { name: '', grams: 50 }, { name: 'מים', grams: -1 }, { name: 'ענק', grams: 99999 },
    ...Array.from({ length: 20 }, (_, i) => ({ name: `פריט ${i}`, grams: 10 })),
  ] });
  assert.equal(c.items.length, 12);
  assert.equal(c.items[0].name.length, 60);
  assert.equal(c.items[0].name_en.length, 120);
  assert.equal(c.items[0].grams, 120);
  assert.equal(c.items[0].group, undefined);
  assert.equal(c.items[0].confidence, 'mid');
  assert.equal(c.items[1].grams, 3000);
  assert.equal(c.question, null);
  assert.equal(c.title.length, 80);
  assert.equal(vision.clean(null), null);
  assert.deepEqual(vision.clean({ food: false }), { food: false, items: [] });
});

test('the photo is kept for the page, only through its owner\'s link, and goes with the meal', async t => {
  const { okOf, pool, port } = await boot(t, { seen: PLATE });
  const r = await okOf('see_meal_photo', { path: '/x/p.jpg', meal: 'lunch' });
  const id = r.logged.meal_id;
  const { rows: [row] } = await pool.query('SELECT photo FROM meals WHERE id = $1', [id]);
  assert.equal(row.photo, `201/${id}.jpg`);
  const file = path.join(photos.dir(), row.photo);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(PHOTO.base64, 'base64'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const me = await store.reload(pool, 201);
  const other = await store.ensurePerson(pool, { id: 202, name: 'אחר', timezone: 'Asia/Jerusalem' });
  const get = (tok, mid = id) => fetch(`http://127.0.0.1:${port}/food/${tok}/photo/${mid}`);
  const mine = await get(me.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), Buffer.from(PHOTO.base64, 'base64'));
  assert.equal((await get(other.token)).status, 404, 'the same meal id under somebody else\'s link');
  assert.equal((await get(me.token, '../../etc')).status, 404);

  const j = await (await fetch(`http://127.0.0.1:${port}/food/${me.token}/api/journal`)).json();
  assert.equal(j.days.length, 1);
  assert.equal(j.days[0].meals[0].photo, true);

  const del = await fetch(`http://127.0.0.1:${port}/food/${me.token}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'meal_delete', meal_id: id }) });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(file), false, 'deleted with the meal');
  assert.equal((await get(me.token)).status, 404);
});
