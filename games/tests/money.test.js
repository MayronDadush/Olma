'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settle, evenly, foodSplit, pokerOf } = require('../src/money');

// Deterministic randomness, so a failure names a seed that reproduces it.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// The true minimum, by trying every way to pay: for small n this is the
// brute force the DP must match.
function bruteMin(vals) {
  const v = vals.filter(x => x !== 0);
  let best = Infinity;
  const go = (arr, k) => {
    const i = arr.findIndex(x => x !== 0);
    if (i < 0) { best = Math.min(best, k); return; }
    if (k + 1 >= best) return;
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[j] !== 0 && Math.sign(arr[j]) !== Math.sign(arr[i])) {
        const a = arr.slice(); a[j] += a[i]; a[i] = 0; go(a, k + 1);
      }
    }
  };
  go(v, 0);
  return best === Infinity ? 0 : best;
}

function randomBalances(r, n) {
  const vals = Array.from({ length: n - 1 }, () => (Math.round((r() - 0.5) * 40) * 500) || 0);
  vals.push(-vals.reduce((a, b) => a + b, 0) || 0);
  return vals.map((v, i) => ({ id: 'p' + i, v }));
}

test('settle: every balance is paid exactly, and never with more transfers than the true minimum', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const bal = randomBalances(r, 2 + Math.floor(r() * 8));
    const xs = settle(bal);
    const net = Object.fromEntries(bal.map(b => [b.id, 0]));
    for (const x of xs) { assert.ok(x.amt > 0, `seed ${seed}: zero transfer`); net[x.from] -= x.amt; net[x.to] += x.amt; }
    for (const b of bal) assert.equal(net[b.id], b.v, `seed ${seed}: ${b.id} not settled`);
    assert.equal(xs.length, bruteMin(bal.map(b => b.v)), `seed ${seed}: not minimal`);
  }
});

test('settle: two pairs that cancel are two transfers, not three', () => {
  const xs = settle([{ id: 'a', v: 5000 }, { id: 'b', v: -5000 }, { id: 'c', v: 1200 }, { id: 'd', v: -1200 }]);
  assert.equal(xs.length, 2);
});

test('evenly: splits to the agora and always sums to the total', () => {
  const out = evenly(1000, ['c', 'a', 'b']);
  assert.deepEqual(out, { a: 334, b: 333, c: 333 });
  assert.equal(Object.values(out).reduce((a, b) => a + b, 0), 1000);
});

test('foodSplit: own dishes first, the rest evenly, and what was paid is what is owed', () => {
  const players = new Set(['p0', 'p1', 'p2', 'p3']);
  const sp = foodSplit({ payer: 'p3', amount: 310, eaters: ['p0', 'p2', 'p3'], own: { p0: 58, p2: 92 } }, players);
  assert.ok(sp.ok);
  assert.deepEqual(sp.owe, { p0: 5800, p2: 9200, p3: 16000 });
  assert.deepEqual(sp.pay, { p3: 31000 });
});

test('foodSplit: own dishes that add up to more than the bill are ignored, not trusted', () => {
  const sp = foodSplit({ payer: 'a', amount: 100, eaters: ['a', 'b'], own: { a: 80, b: 80 } }, new Set(['a', 'b']));
  assert.equal(sp.warn, 'over');
  assert.deepEqual(sp.owe, { a: 5000, b: 5000 });
});

test('pokerOf: closes only when the chips add up, and the nets sum to zero', () => {
  const night = {
    game: { price: 50, chips: 1000 },
    players: { p0: { name: 'מיכל', order: 0 }, p1: { name: 'יוסי', order: 1 }, p2: { name: 'דני', order: 2 } },
    buyins: { b0: { pid: 'p0', n: 1 }, b1: { pid: 'p1', n: 1 }, b2: { pid: 'p2', n: 1 }, b3: { pid: 'p2', n: 0.5 } },
    cashouts: { p0: { chips: 2000 }, p1: { chips: 500 } },
  };
  assert.equal(pokerOf(night).closed, false);
  night.cashouts.p2 = { chips: 1000 };
  const P = pokerOf(night);
  assert.equal(P.closed, true);
  assert.deepEqual(P.poker, { p0: 5000, p1: -2500, p2: -2500 });
  night.cashouts.p2 = { chips: 999 };
  assert.equal(pokerOf(night).closed, false, 'one chip short is not closed');
});

test('pokerOf: a price that does not divide into chips still nets to exactly zero', () => {
  const night = {
    game: { price: 33.33, chips: 7 },
    players: { a: { order: 0 }, b: { order: 1 }, c: { order: 2 } },
    buyins: { x: { pid: 'a', n: 1 }, y: { pid: 'b', n: 1 }, z: { pid: 'c', n: 1 } },
    cashouts: { a: { chips: 10 }, b: { chips: 10 }, c: { chips: 1 } },
  };
  const P = pokerOf(night);
  assert.equal(P.closed, true);
  assert.equal(Object.values(P.poker).reduce((a, b) => a + b, 0), 0);
});
