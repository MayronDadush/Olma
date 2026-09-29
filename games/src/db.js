'use strict';
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// numeric (a buy-in of ½) arrives as a string by default; these are small.
types.setTypeParser(1700, v => (v == null ? null : Number(v)));
// bigint ids and ms timestamps stay well inside 2^53.
types.setTypeParser(20, v => (v == null ? null : Number(v)));

// Same two ceilings as olma2's pool (src/db/pool.js there): a runaway
// statement fails by name instead of holding the one core, and a checkout
// never queues for ever.
function createPool(url) {
  const conn = url || process.env.GAMES_DB_URL;
  if (!conn) throw new Error('GAMES_DB_URL is required');
  const pool = new Pool({
    connectionString: conn,
    max: parseInt(process.env.GAMES_DB_POOL_MAX || '5', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    options: '-c statement_timeout=10000',
  });
  pool.on('error', e => console.error('[games pool] idle client error:', e.message));
  return pool;
}

async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* gone */ }
    throw e;
  } finally {
    client.release();
  }
}

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// Applies every migrations/NNN_*.sql not yet in schema_migrations, each in
// its own transaction, in order. Returns the versions it applied.
async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
  const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    if (done.has(v)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    await withTx(pool, async c => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
    });
    applied.push(v);
  }
  return applied;
}

module.exports = { createPool, withTx, migrate };
