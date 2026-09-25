'use strict';
// A NULL timezone is silently wrong rather than visibly broken: the delivery
// gate and digest sweep fall back to UTC, so an Israeli user's quiet hours run
// three hours late. These cover the guess and the provisioning wiring.
const test = require('node:test');
const assert = require('node:assert');
const { lookupTimezone, timezoneForPhone, phoneShape, isRealPhone } = require('../src/domain/phone-timezone');

test('infers the zone from the dialling code, longest prefix first', () => {
  assert.equal(timezoneForPhone('+972526269826'), 'Asia/Jerusalem');
  assert.equal(timezoneForPhone('+970599000000'), 'Asia/Hebron');   // 970 must beat 97/9
  assert.equal(timezoneForPhone('+351911000000'), 'Europe/Lisbon'); // 351 must beat 35/3
  assert.equal(timezoneForPhone('+447700900000'), 'Europe/London');
});

test('flags countries that span several zones as ambiguous', () => {
  assert.equal(lookupTimezone('+14155550100').ambiguous, true);   // US/Canada
  assert.equal(lookupTimezone('+61400000000').ambiguous, true);   // Australia
  assert.equal(lookupTimezone('+972526269826').ambiguous, false); // Israel
});

test('an unknown code yields null rather than a wrong guess', () => {
  assert.equal(timezoneForPhone('+99900011122'), null);
  assert.equal(timezoneForPhone(''), null);
  assert.equal(timezoneForPhone(null), null);
});

test('every guessed zone is a real IANA name', () => {
  const { PREFIXES } = require('../src/domain/phone-timezone');
  for (const p of PREFIXES) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: p.tz }),
      `${p.code} -> ${p.tz} is not a valid IANA zone`);
  }
});

// ---- phoneShape: is this a number at all ------------------------------------

test('a real number from a country we know is a phone', () => {
  // Every real user on the box answered this way when the check was written —
  // the direction that must never be wrong, because a false 'not_phone'
  // silences somebody who exists.
  assert.equal(phoneShape('+972526269826'), 'phone');   // Israel, 12
  assert.equal(phoneShape('+447700900000'), 'phone');   // UK, 12
  assert.equal(phoneShape('+14155550100'), 'phone');    // US, 11
  assert.equal(phoneShape('+33612345678'), 'phone');    // France, 11
  assert.equal(phoneShape('+4915112345678'), 'phone');  // Germany, 13 — the longer of its two
  assert.equal(phoneShape('972526269826'), 'phone');    // the leading + is optional
});

test('a country we know at a length it does not issue is confidently NOT a phone', () => {
  // This is the half the length cut in `proactive-text` could never reach: 12
  // and 13 digits are inside its window, so only the dialling code can refuse
  // them. Shapes taken from the LID corpus on the box; the digits are made up.
  assert.equal(phoneShape('+100000000000'), 'not_phone');  // 12, US issues 11
  assert.equal(phoneShape('+1000000000000'), 'not_phone'); // 13, same
  assert.equal(phoneShape('+9720000000000'), 'not_phone'); // 13, Israel issues 12
  assert.equal(phoneShape('+97200000000'), 'not_phone');   // 11, Israel issues 12
});

test('a dialling code the table has never heard of is UNKNOWN, never a guess', () => {
  // The honest third state. Both of these are the live Padel Gang members the
  // room could not reach, and nothing may act on them as if they were numbers
  // — but nothing may act on them as if they were certainly LIDs either.
  assert.equal(phoneShape('+6266525098172'), 'unknown');
  assert.equal(phoneShape('+259201444126724'), 'unknown');
  assert.equal(phoneShape('+99900011122'), 'unknown');
});

test('anything that is not digits is not a phone', () => {
  for (const v of ['', null, undefined, 'not a number', '+972-52-626', '+']) {
    assert.equal(phoneShape(v), 'not_phone', `${JSON.stringify(v)} should be refused`);
  }
});

test('isRealPhone refuses UNKNOWN as well, because a row outlives the guess', () => {
  assert.equal(isRealPhone('+972526269826'), true);
  assert.equal(isRealPhone('+6266525098172'), false);   // unknown
  assert.equal(isRealPhone('+100000000000'), false);    // not_phone
});

test('every dialling code carries at least one length, longer than the code', () => {
  // A missing or nonsense `len` would make `phoneShape` answer 'not_phone' for
  // a whole country, which is the silent failure this guards.
  const { PREFIXES } = require('../src/domain/phone-timezone');
  for (const p of PREFIXES) {
    assert.ok(Array.isArray(p.len) && p.len.length > 0, `${p.code} has no len`);
    for (const n of p.len) {
      assert.ok(Number.isInteger(n) && n > p.code.length && n <= 15,
        `${p.code} -> len ${n} is not a plausible E.164 total`);
    }
  }
});
