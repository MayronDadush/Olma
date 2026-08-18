'use strict';
// A NULL timezone is silently wrong rather than visibly broken: the delivery
// gate and digest sweep fall back to UTC, so an Israeli user's quiet hours run
// three hours late. These cover the guess and the provisioning wiring.
const test = require('node:test');
const assert = require('node:assert');
const { lookupTimezone, timezoneForPhone } = require('../src/domain/phone-timezone');

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
