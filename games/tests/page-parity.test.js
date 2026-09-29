'use strict';
// The page and the server each carry the night's arithmetic: the page to
// redraw on every keystroke, the server to write game_results. This runs the
// PAGE's own functions (cut out of public/night.html, not a copy of them) and
// the server's on the same random nights, so the two cannot drift apart
// without this going red.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const money = require('../src/money');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'night.html'), 'utf8');
const cut = (from, to) => {
  const i = html.indexOf(from), j = html.indexOf(to, i);
  assert.ok(i > 0 && j > i, `could not find ${from} in the page`);
  return html.slice(i, j);
};
const pageCode = cut('function settle(bal){', '/* ───────────── store:')
  + cut('const ag = v => Math.round', 'function findPlayer(');

function pageRun(S) {
  const ctx = vm.createContext({ S, Math, Object, Float64Array, Int8Array, JSON });
  vm.runInContext(pageCode + '\nthis.out = { derive, foodSplit, settle };', ctx);
  return ctx.out;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function randomNight(r) {
  const n = 2 + Math.floor(r() * 9);
  const ids = Array.from({ length: n }, (_, i) => 'p' + i);
  const price = [20, 50, 100, 33.33, 12.5][Math.floor(r() * 5)];
  const chips = [1000, 500, 7, 250][Math.floor(r() * 4)];
  const S = { game: { price, chips, foodMode: r() < 0.5 ? 'merge' : 'split' }, players: {}, buyins: {}, cashouts: {}, food: {}, paid: {} };
  ids.forEach((id, i) => { S.players[id] = { name: id, order: i }; });
  let k = 0, total = 0;
  for (const id of ids) {
    const b = 1 + Math.floor(r() * 3);
    for (let i = 0; i < b; i++) { const v = r() < 0.2 ? 0.5 : 1; S.buyins['b' + k++] = { pid: id, n: v, at: k }; total += v; }
  }
  // chips that add up, most of the time
  let left = Math.round(total * chips);
  ids.forEach((id, i) => {
    const c = i === ids.length - 1 ? left : Math.floor(r() * Math.max(1, left));
    left -= c;
    S.cashouts[id] = { chips: c };
  });
  if (r() < 0.25) S.cashouts[ids[0]].chips += 1;
  for (let f = 0; f < Math.floor(r() * 3); f++) {
    const eaters = ids.filter(() => r() < 0.7);
    if (!eaters.length) continue;
    const order = { payer: ids[Math.floor(r() * n)], amount: Math.round(r() * 40000) / 100, eaters, at: f };
    if (r() < 0.4) order.own = { [eaters[0]]: Math.round(r() * 5000) / 100 };
    S.food['f' + f] = order;
  }
  return S;
}

test('page and server agree on the poker half of 300 random nights', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const S = randomNight(rng(seed));
    const D = pageRun(S).derive();
    const P = money.pokerOf(S);
    assert.equal(D.closed, P.closed, `seed ${seed}: closed`);
    assert.deepEqual({ ...D.poker }, P.poker, `seed ${seed}: nets`);
    assert.deepEqual({ ...D.bi }, P.bi, `seed ${seed}: buy-ins`);
  }
});

test('page and server agree on every food split and every settlement', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const S = randomNight(rng(seed));
    const page = pageRun(S);
    const players = new Set(Object.keys(S.players));
    for (const f of Object.values(S.food)) {
      const a = page.foodSplit(f), b = money.foodSplit(f, players);
      assert.deepEqual(JSON.parse(JSON.stringify({ pay: a.pay, owe: a.owe, ok: a.ok })), { pay: b.pay, owe: b.owe, ok: b.ok }, `seed ${seed}`);
    }
    const bal = Object.keys(S.players).map((id, i) => ({ id, v: (i - 1) * 1250 }));
    bal[0].v = -bal.slice(1).reduce((x, y) => x + y.v, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(page.settle(bal))), money.settle(bal), `seed ${seed}: settle`);
  }
});
