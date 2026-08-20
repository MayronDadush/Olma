'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const infraCost = require('../src/adapters/infra-cost');

test('infra cost: degrades to configured:false with no secrets, never throws or calls the network', async () => {
  delete process.env.ANTHROPIC_ADMIN_KEY;
  delete process.env.DO_API_TOKEN;
  delete process.env.ELEVENLABS_API_KEY;
  const data = await infraCost.getInfraCosts();
  assert.equal(data.anthropic.configured, false);
  assert.equal(data.digitalocean.configured, false);
  assert.equal(data.elevenlabs.configured, false);
  // the personal subscription is a hardcoded constant, not a fetch — always present
  assert.equal(data.subscription.configured, true);
  assert.ok(data.subscription.sinceTotal >= 20);
});
