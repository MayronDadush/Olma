'use strict';
const test = require('node:test');
const assert = require('node:assert');
const hosts = require('../src/domain/model-hosts');

test('routing: an excluded host never survives into the order, and every request ignores the list', () => {
  const r = hosts.routing(['novita', 'StreamLake', 'deepinfra']);
  assert.deepEqual(r.order, ['novita', 'deepinfra']);
  assert.equal(r.allow_fallbacks, true, 'availability is the owner\'s rule; the exclusion holds under it');
  assert.equal(r.data_collection, 'deny');
  assert.deepEqual(r.ignore, [...hosts.EXCLUDED_HOSTS]);
  const bare = hosts.routing();
  assert.equal(bare.order, undefined, 'no order is a preference nobody stated, not an empty one');
  assert.deepEqual(bare.ignore, [...hosts.EXCLUDED_HOSTS]);
});

test('admitsExcluded: the box\'s own pre-2026-09-29 order is caught, routing() output is not', () => {
  assert.equal(hosts.admitsExcluded({ order: ['novita', 'streamlake'], allow_fallbacks: true, data_collection: 'deny' }), true);
  assert.equal(hosts.admitsExcluded({ order: ['novita'], allow_fallbacks: true }), true, 'no ignore list means any fallback');
  assert.equal(hosts.admitsExcluded(null), true);
  assert.equal(hosts.admitsExcluded(hosts.routing(['novita'])), false);
});
