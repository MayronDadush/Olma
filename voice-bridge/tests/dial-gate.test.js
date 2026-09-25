'use strict';
// lib/dial-gate: the list rings anybody on it; everybody else only on a
// dial that says it is capped AND asks for a call inside the cap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { admits, CAPPED_MAX_DURATION_SEC } = require('../lib/dial-gate');

const LIST = ['+972500000001'];

test('a listed number is admitted with or without a cap', () => {
  assert.equal(admits({ phone: '+972500000001' }, LIST), true);
  assert.equal(admits({ phone: '+972500000001', capped: true, maxDurationSec: 120 }, LIST), true);
});

test('an unlisted number is admitted on a capped dial — the page button for everybody', () => {
  assert.equal(admits({ phone: '+972500000009', capped: true, maxDurationSec: 120 }, LIST), true);
});

test('an unlisted number is refused on the uncapped chat door', () => {
  assert.equal(admits({ phone: '+972500000009' }, LIST), false);
  assert.equal(admits({ phone: '+972500000009', maxDurationSec: 120 }, LIST), false,
    'a duration alone is not a claim to be capped — an olma2 that predates the field gets the list');
});

test('a capped dial that asks for more than the cap, or no duration at all, is refused', () => {
  assert.equal(admits({ phone: '+972500000009', capped: true }, LIST), false);
  assert.equal(admits({ phone: '+972500000009', capped: true, maxDurationSec: CAPPED_MAX_DURATION_SEC + 1 }, LIST), false);
  assert.equal(admits({ phone: '+972500000009', capped: 'yes', maxDurationSec: 60 }, LIST), false);
});

test('no phone is never admitted, even with an empty list', () => {
  assert.equal(admits({ phone: null, capped: true, maxDurationSec: 60 }, []), false);
});
