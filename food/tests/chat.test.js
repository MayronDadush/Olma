'use strict';
// The page's chat: code reads what has one shape, the small model reads a
// sentence about a meal, and the values still come from the table. No
// network: the model is a function here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const store = require('../src/store');
const foods = require('../src/foods');
const chat = require('../src/chat');

const identify = async () => ({ ok: false, error: { message: 'unused' } });

function fakeModel(answer) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const content = body.messages[0].content;
    let out;
    if (content.includes('המשפט:')) { calls.push('say'); out = JSON.stringify(answer); }
    else {
      calls.push('match');
      const picks = [];
      for (const m of content.matchAll(/Item (\d+): "([^"]+)"[^\n]*\n((?:  \d+: [^\n]*\n?)+)/g)) picks.push({ i: Number(m[1]), id: Number(m[3].match(/ {2}(\d+): /)[1]) });
      out = JSON.stringify({ picks });
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: out } }], usage: { cost: 0.0002 } }) };
  };
  return { fetchImpl, calls };
}

async function boot(t, answer) {
  process.env.FOOD_OPENROUTER_KEY = 'test-key';
  t.after(() => { delete process.env.FOOD_OPENROUTER_KEY; foods.reset(); });
  const pool = await freshDb(t);
  await foods.seed(pool);
  const model = fakeModel(answer);
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html>', identify, fetchImpl: model.fetchImpl });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const p = await store.ensurePerson(pool, { id: 301, name: 'טל', timezone: 'Asia/Jerusalem' });
  const say = async text => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/food/${p.token}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    assert.equal(r.status, 200);
    return r.json();
  };
  return { pool, say, model };
}

test('code reads what has one shape, with no model', () => {
  assert.deepEqual(chat.parse('כוס מים'), { k: 'water', n: 1 });
  assert.deepEqual(chat.parse('שתיתי 3 כוסות מים'), { k: 'water', n: 3 });
  assert.deepEqual(chat.parse('שתיתי שתי כוסות'), { k: 'water', n: 2 });
  assert.deepEqual(chat.parse('מה נשאר לי היום?'), { k: 'status' });
  assert.deepEqual(chat.parse('תמחקי את האחרונה'), { k: 'undo' });
  assert.deepEqual(chat.parse('עזרה'), { k: 'help' });
  assert.equal(chat.parse('אכלתי חביתה וסלט'), null);
  assert.equal(chat.parse('מה עם הפגישה מחר'), null, 'not food: the model decides, code never guesses');
});

test('a sentence about a meal is logged from the table, water and status cost nothing, and undo takes it back', async t => {
  const { pool, say, model } = await boot(t, { kind: 'log', title: 'ביצים מקושקשות', meal: 'breakfast', when: 'today',
    items: [{ name: 'ביצים מקושקשות', name_en: 'scrambled eggs', grams: 130, group: 'protein', confidence: 'mid' }] });
  const a = await say('אכלתי ביצים מקושקשות בבוקר');
  assert.match(a.reply, /^רשמתי ארוחת בוקר: ביצים מקושקשות, 194 קק״ל/);
  assert.equal(a.state.meals.length, 1);
  const { rows: [m] } = await pool.query('SELECT source, via FROM meals');
  assert.deepEqual(m, { source: 'text', via: 'page' });

  assert.match((await say('2 כוסות מים')).reply, /^2 כוסות נרשמו\. 2 מתוך/);
  assert.match((await say('מה נשאר לי?')).reply, /^היום: 194 קק״ל מתוך/);
  assert.deepEqual(model.calls, ['say'], 'only the sentence about food went to a model');

  assert.equal((await say('תמחקי את האחרונה')).reply, 'מחקתי את "ביצים מקושקשות".');
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM meals WHERE deleted_at IS NULL');
  assert.equal(n, 0);
});

test('anything that is not food is sent back to WhatsApp, and nothing is written', async t => {
  const { pool, say } = await boot(t, { kind: 'other' });
  assert.match((await say('תזכירי לי מחר להתקשר לאמא')).reply, /בוואטסאפ/);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM meals');
  assert.equal(n, 0);
});
