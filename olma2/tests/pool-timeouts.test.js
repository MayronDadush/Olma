'use strict';
// The two ceilings in db/pool.js only ever matter when something has already
// gone wrong — a statement that will not finish, a pool with no free client —
// which makes them exactly the kind of guard that rots into decoration. So
// each is driven for real here: a statement that outlives the cap, and a
// checkout that queues behind clients nobody returns.
//
// Uses createPool (the production constructor), not the test helper's own
// pool, because the whole point is what production connections carry.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Pool settings are read from the environment at require time, so the module
// is loaded fresh under each test's own values.
function poolWith(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../src/db/pool')];
  const mod = require('../src/db/pool');
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[require.resolve('../src/db/pool')];
  return mod;
}

test('a statement that outlives the cap is cancelled by Postgres, by name', async () => {
  const { createPool, withTx } = poolWith({ OLMA_DB_STATEMENT_TIMEOUT_MS: '300' });
  const pool = createPool(db.url);
  try {
    // The cap travels with every client the pool hands out.
    const { rows } = await pool.query('SHOW statement_timeout');
    assert.equal(rows[0].statement_timeout, '300ms');

    await assert.rejects(
      withTx(pool, (c) => c.query('SELECT pg_sleep(2)')),
      /canceling statement due to statement timeout/,
      'the failure names the statement, not a generic backend error');

    // And the pool is healthy afterwards — the cancelled client was rolled
    // back and released, not leaked.
    const ok = await withTx(pool, (c) => c.query('SELECT 1 AS n'));
    assert.equal(ok.rows[0].n, 1);
  } finally {
    await pool.end();
  }
});

test('0 disables the statement cap, for the one script that needs a long statement', async () => {
  const { createPool } = poolWith({ OLMA_DB_STATEMENT_TIMEOUT_MS: '0' });
  const pool = createPool(db.url);
  try {
    const { rows } = await pool.query('SHOW statement_timeout');
    assert.equal(rows[0].statement_timeout, '0');
  } finally {
    await pool.end();
  }
});

test('a checkout that cannot get a client fails after the connect cap instead of waiting for ever', async () => {
  const { createPool } = poolWith({ OLMA_DB_CONNECT_TIMEOUT_MS: '300' });
  // The cap is read when the module loads; the pool SIZE is read when the pool
  // is built — so this one has to be in the environment at the call.
  const savedMax = process.env.OLMA_DB_POOL_MAX;
  process.env.OLMA_DB_POOL_MAX = '1';
  let pool;
  try { pool = createPool(db.url); }
  finally { if (savedMax === undefined) delete process.env.OLMA_DB_POOL_MAX; else process.env.OLMA_DB_POOL_MAX = savedMax; }
  assert.equal(pool.options.max, 1);

  const held = await pool.connect(); // the one client, never released until the end
  let leaked = null;
  try {
    const t0 = Date.now();
    // If the cap does NOT apply, this resolves with a second client; catch it
    // so the failure is an assertion and not a pool.end() that never returns.
    await assert.rejects(
      pool.connect().then((c) => { leaked = c; }),
      /timeout exceeded when trying to connect/);
    assert.ok(Date.now() - t0 < 5_000, 'gave up on the cap, not on a longer default');
  } finally {
    if (leaked) leaked.release();
    held.release();
    await pool.end();
  }
});

test('the defaults sit under the MCP shim call timeout, so a runaway query fails inside the tool call', () => {
  const { STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS } = poolWith({});
  const shim = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'bin', 'olma-mcp.js'), 'utf8');
  const m = shim.match(/CALL_TIMEOUT_MS = (\d[\d_]*)/);
  assert.ok(m, 'the shim declares its call timeout');
  const shimMs = Number(m[1].replace(/_/g, ''));
  assert.ok(STATEMENT_TIMEOUT_MS < shimMs, `statement cap ${STATEMENT_TIMEOUT_MS} must be under the shim's ${shimMs}`);
  assert.ok(CONNECT_TIMEOUT_MS + STATEMENT_TIMEOUT_MS <= shimMs,
    'even a checkout wait plus a full statement fits inside one tool call');
});
