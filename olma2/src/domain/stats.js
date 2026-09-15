'use strict';
// How sure are we, on this many runs?
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Every model pilot in `docs/model-experiments.md` is a comparison of pass
// rates over a few dozen scenarios: "9 green · 2 yellow · 0 red" against
// "11 green · 0 yellow". Those are read as though a two-scenario difference
// meant something. On fourteen scenarios it does not — 11/14 and 9/14 have
// 95% intervals that overlap across more than half their width, so the two
// runs are consistent with the same model being better, and with neither.
//
// Three deploys and one model decision have already been argued from
// differences that small. This module puts the interval next to the number so
// the argument has to be made against it, and it is deliberately printed for
// the SINGLE-run case too: the honest reading of one full suite is not
// "78% pass" but "somewhere between 52% and 94%", which is the real reason the
// suite is a regression net and not a scoreboard.
//
// ── Which interval, and why not the obvious one ─────────────────────────────
// The textbook `p ± 1.96·sqrt(p(1-p)/n)` (Wald) is wrong exactly where evals
// live: it gives a zero-width interval at 0/n and n/n — "14 of 14 passed, so
// the pass rate is 100%, ±0" — which is the arithmetic version of the mistake
// this whole file is here to stop. It also under-covers badly below a few
// hundred samples.
//
// Jeffreys is the Bayesian interval with the Beta(½,½) prior: the posterior
// after k successes in n trials is Beta(k+½, n−k+½), and the interval is its
// 2.5th and 97.5th percentiles. It never collapses to a point, it has good
// coverage in exactly the small-n regime we are in, and the convention at the
// boundaries (0 for k=0, 1 for k=n) is the one everyone uses.
//
// No dependency: `regularizedIncompleteBeta` is the standard continued
// fraction, and the quantile is bisection on it. Both are exercised against
// values computed independently in tests/stats.test.js — a numerical routine
// nobody checked is a number nobody should quote.

// log Γ(x) — Lanczos, g=7, n=9. Accurate to ~15 significant figures for the
// x > 0 we ever pass it (a and b here are counts plus a half).
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) {
    // reflection, so the caller never has to care
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta (Numerical Recipes §6.4).
function betaContinuedFraction(x, a, b) {
  const TINY = 1e-30;
  const EPS = 3e-16;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// I_x(a, b) — the regularized incomplete beta, i.e. P(X <= x) for X ~ Beta(a,b).
function regularizedIncompleteBeta(x, a, b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  // The fraction converges fast only on one side of the mean; the symmetry
  // I_x(a,b) = 1 − I_{1−x}(b,a) puts every call on the fast side.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (Math.exp(
      logGamma(a + b) - logGamma(a) - logGamma(b) + b * Math.log(1 - x) + a * Math.log(x)
    ) * betaContinuedFraction(1 - x, b, a)) / b;
}

// The p-th quantile of Beta(a, b), by bisection on the CDF above.
// Bisection rather than Newton on purpose: it cannot diverge, 200 halvings of
// [0,1] is far below double precision, and this runs a handful of times per
// eval run — there is nothing to optimise and a wrong tail would be invisible.
function betaQuantile(p, a, b) {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// The 95% Jeffreys interval for k successes in n trials.
//
// Returns { rate, low, high, n, k }. `rate` is the plain k/n, because the
// point estimate people quote should stay the one they recognise — the
// interval is the correction, not a different number.
//
// n = 0 is not "0%": it is no measurement at all, and it returns nulls so a
// caller printing it cannot accidentally claim a rate nobody observed. Same
// rule as everywhere else here — `null` (could not judge) and `0` (judged,
// nothing passed) must never collapse.
function jeffreysInterval(k, n, confidence = 0.95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`jeffreysInterval: k=${k}, n=${n} is not k successes in n trials`);
  }
  if (n === 0) return { rate: null, low: null, high: null, n: 0, k: 0 };
  const tail = (1 - confidence) / 2;
  const a = k + 0.5;
  const b = n - k + 0.5;
  return {
    rate: k / n,
    // The boundary convention: with no failures observed there is no evidence
    // for any upper bound below 1, and symmetrically at the bottom.
    low: k === 0 ? 0 : betaQuantile(tail, a, b),
    high: k === n ? 1 : betaQuantile(1 - tail, a, b),
    n,
    k,
  };
}

// "12/14 (86%, 95% CI 60–96%)" — one string, so every caller says it the same
// way and a reader never has to ask which of the three numbers is the estimate.
function formatRate(k, n, { confidence = 0.95 } = {}) {
  const ci = jeffreysInterval(k, n, confidence);
  if (ci.rate === null) return '0/0 (no runs)';
  const p = (x) => `${Math.round(x * 100)}%`;
  return `${k}/${n} (${p(ci.rate)}, 95% CI ${p(ci.low)}–${p(ci.high)})`;
}

// Do two measurements actually differ? True only when the intervals are
// disjoint. This is deliberately CONSERVATIVE — non-overlapping intervals
// imply a significant difference, but overlapping ones do not prove sameness,
// so the honest reading of `false` is "this run cannot tell", which is exactly
// the sentence the pilot tables have been missing.
function separated(aCi, bCi) {
  if (aCi.rate === null || bCi.rate === null) return false;
  return aCi.low > bCi.high || bCi.low > aCi.high;
}

module.exports = {
  jeffreysInterval,
  formatRate,
  separated,
  regularizedIncompleteBeta,
  betaQuantile,
  logGamma,
};
