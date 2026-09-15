'use strict';
const test = require('node:test');
const assert = require('node:assert');
const stats = require('../src/domain/stats');

// The reference values below were computed OUTSIDE this codebase, by numeric
// integration of the Beta density in Python — a different algorithm from the
// continued fraction in stats.js, which is the whole point. A test that
// re-implements the thing it is checking proves only that you can write it
// twice (CLAUDE.md, "A test that asserts on a replica of a query cannot fail
// when the original drifts").
//
// The k=0 rows needed the substitution t=u² to integrate through the
// singularity at the origin; the naive midpoint rule is wrong there by 3e-3,
// and it disagreed with this module until the reference was fixed rather than
// the code. Recorded here because the next person to "correct" a k=0 bound
// should know which of the two was wrong.
const REFERENCE = [
  { k: 0, n: 10, low: 0, high: 0.217196268 },
  { k: 1, n: 10, low: 0.011012, high: 0.381315 },
  { k: 5, n: 10, low: 0.223529, high: 0.776471 },
  { k: 9, n: 10, low: 0.618685, high: 0.988988 },
  { k: 10, n: 10, low: 0.782804, high: 1 },
  { k: 0, n: 14, low: 0, high: 0.161553305 },
  { k: 2, n: 14, low: 0.030922, high: 0.384894 },
  { k: 11, n: 14, low: 0.530976, high: 0.935665 },
  { k: 12, n: 14, low: 0.615106, high: 0.969078 },
  { k: 14, n: 14, low: 0.838447, high: 1 },
  { k: 3, n: 3, low: 0.464417, high: 1 },
  { k: 1, n: 1, low: 0.146746, high: 1 },
  { k: 40, n: 50, low: 0.674173, high: 0.892266 },
];

test('the interval matches values computed by an independent method', () => {
  for (const r of REFERENCE) {
    const ci = stats.jeffreysInterval(r.k, r.n);
    assert.ok(Math.abs(ci.low - r.low) < 1e-5,
      `${r.k}/${r.n} low: got ${ci.low}, reference ${r.low}`);
    assert.ok(Math.abs(ci.high - r.high) < 1e-5,
      `${r.k}/${r.n} high: got ${ci.high}, reference ${r.high}`);
  }
});

test('the CDF is a CDF: monotone, and 0 and 1 at the ends', () => {
  const a = 3.5;
  const b = 7.5;
  assert.equal(stats.regularizedIncompleteBeta(0, a, b), 0);
  assert.equal(stats.regularizedIncompleteBeta(1, a, b), 1);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.01) {
    const v = stats.regularizedIncompleteBeta(x, a, b);
    assert.ok(v >= prev, `not monotone at x=${x}`);
    prev = v;
  }
});

test('the quantile inverts the CDF', () => {
  for (const [a, b] of [[0.5, 10.5], [3.5, 3.5], [12.5, 2.5], [40.5, 10.5]]) {
    for (const p of [0.025, 0.25, 0.5, 0.75, 0.975]) {
      const x = stats.betaQuantile(p, a, b);
      assert.ok(Math.abs(stats.regularizedIncompleteBeta(x, a, b) - p) < 1e-6,
        `Beta(${a},${b}) quantile ${p} round-trip failed at x=${x}`);
    }
  }
});

// The reason this module exists rather than `p ± 1.96·sqrt(p(1-p)/n)`.
test('a clean sweep does not claim certainty', () => {
  const ci = stats.jeffreysInterval(14, 14);
  assert.equal(ci.rate, 1);
  assert.equal(ci.high, 1);
  assert.ok(ci.low < 0.85, `14/14 should not imply a floor above 85%, got ${ci.low}`);
  // Wald would give ±0 here, which is the arithmetic form of the mistake.
  assert.ok(ci.high - ci.low > 0.15);
});

test('nothing observed is not zero percent', () => {
  const ci = stats.jeffreysInterval(0, 0);
  assert.equal(ci.rate, null);
  assert.equal(ci.low, null);
  assert.equal(ci.high, null);
  assert.equal(stats.formatRate(0, 0), '0/0 (no runs)');
});

test('zero of ten IS zero percent, with a real upper bound', () => {
  const ci = stats.jeffreysInterval(0, 10);
  assert.equal(ci.rate, 0);
  assert.equal(ci.low, 0);
  assert.ok(ci.high > 0.2 && ci.high < 0.25);
});

test('an impossible count is refused rather than rounded', () => {
  assert.throws(() => stats.jeffreysInterval(11, 10), /k=11, n=10/);
  assert.throws(() => stats.jeffreysInterval(-1, 10), /not k successes/);
  assert.throws(() => stats.jeffreysInterval(1.5, 10), /not k successes/);
});

test('a narrower interval needs more runs, not a better mood', () => {
  const width = (k, n) => {
    const c = stats.jeffreysInterval(k, n);
    return c.high - c.low;
  };
  assert.ok(width(9, 10) > width(90, 100));
  assert.ok(width(90, 100) > width(900, 1000));
});

// The sentence the pilot tables have been missing.
test('separated() only fires when the intervals do not overlap', () => {
  const a = stats.jeffreysInterval(12, 14);
  const b = stats.jeffreysInterval(9, 14);
  assert.equal(stats.separated(a, b), false,
    '12/14 vs 9/14 on fourteen scenarios cannot tell the two apart');
  assert.equal(stats.separated(stats.jeffreysInterval(14, 14), stats.jeffreysInterval(2, 14)), true);
  // Order must not matter.
  assert.equal(stats.separated(stats.jeffreysInterval(2, 14), stats.jeffreysInterval(14, 14)), true);
  // No measurement can never be "different from".
  assert.equal(stats.separated(stats.jeffreysInterval(0, 0), stats.jeffreysInterval(14, 14)), false);
});

test('formatRate says the estimate first and the interval after', () => {
  assert.equal(stats.formatRate(12, 14), '12/14 (86%, 95% CI 62%–97%)');
  assert.equal(stats.formatRate(0, 10), '0/10 (0%, 95% CI 0%–22%)');
});
