'use strict';
// The red line: 1000 users, 10,000 tasks, 300 concurrent calls through the
// full brokerd dispatch path (auth → tx → domain → render) — zero cross-user
// leakage. This is the v2 port of v1's load-bearing scale-test.js, now also
// proving the shared pool holds up where per-turn connections would not.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');

let db, broker;
const USERS = 1000;
const TASKS_PER_USER = 10;

function tokenFor(i) {
  // deterministic 32-hex token per seeded user
  return 'olma_tok_' + require('node:crypto').createHash('md5').update('seed' + i).digest('hex');
}

before(async () => {
  db = await freshDb();
  // Bulk-seed with set-based SQL — three statements, not 4000 round trips.
  await db.pool.query(`
    INSERT INTO users (phone, first_name, identity_token)
    SELECT '+9725' || lpad(i::text, 8, '0'), 'User' || i,
           'olma_tok_' || md5('seed' || i)
    FROM generate_series(1, ${USERS}) AS i`);
  await db.pool.query(`
    INSERT INTO user_channels (user_id, channel_type, channel_identifier, is_primary)
    SELECT id, 'whatsapp', phone, TRUE FROM users`);
  await db.pool.query(`INSERT INTO entitlements (user_id) SELECT id FROM users`);
  await db.pool.query(`
    INSERT INTO tasks (owner_id, title)
    SELECT u.id, 'secret-of-u' || u.id || '-task' || t
    FROM users u, generate_series(1, ${TASKS_PER_USER}) AS t`);
  broker = createBrokerServer({ pool: db.pool });
});
after(async () => { await db.teardown(); });

test(`${USERS} users seeded, 300 concurrent calls, zero cross-user leakage`, async () => {
  const CONCURRENT = 300;
  const calls = [];
  for (let n = 0; n < CONCURRENT; n++) {
    const userIdx = 1 + Math.floor(Math.random() * USERS);
    calls.push({ userIdx, promise: null });
  }
  const t0 = process.hrtime.bigint();
  for (const call of calls) {
    call.promise = broker.dispatch({
      id: call.userIdx, method: 'tool_call',
      params: { name: 'list_my_tasks', args: { olma_identity: tokenFor(call.userIdx) } },
    });
  }
  const results = await Promise.all(calls.map((c) => c.promise));
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  let checked = 0;
  for (let n = 0; n < CONCURRENT; n++) {
    const { userIdx } = calls[n];
    const text = results[n].text;
    assert.ok(results[n].ok, `call ${n} failed`);
    assert.match(text, new RegExp(`secret-of-u\\d+-task`), 'tasks came back');
    // every task title in the result must belong to THIS user, and only them
    const { rows } = await db.pool.query(`SELECT id FROM users WHERE identity_token = $1`, [tokenFor(userIdx)]);
    const myId = Number(rows[0].id); // pg returns BIGINT as string
    const mentioned = new Set([...text.matchAll(/secret-of-u(\d+)-task/g)].map((m) => Number(m[1])));
    assert.deepEqual([...mentioned], [myId], `call ${n}: leakage — saw tasks of users ${[...mentioned]} instead of only ${myId}`);
    checked++;
  }
  assert.equal(checked, CONCURRENT);
  console.log(`  ${CONCURRENT} concurrent calls in ${elapsedMs.toFixed(0)}ms (${(elapsedMs / CONCURRENT).toFixed(2)}ms avg)`);
});

test('flood counter trips and recovers', async () => {
  const { FloodCounter } = require('../src/brokerd/flood');
  const fc = new FloodCounter({ limitPerMinute: 5, windowMs: 60_000 });
  const t = Date.now();
  for (let i = 0; i < 5; i++) assert.equal(fc.isFlooding(42, t + i), false);
  assert.equal(fc.isFlooding(42, t + 5), true);        // 6th within the minute
  assert.equal(fc.isFlooding(42, t + 61_000), false);  // window slid, recovered
  fc.sweep(t + 200_000);
  assert.equal(fc.hits.size, 0);                       // dormant users cleaned
});
