'use strict';
// Single pool per process. In brokerd this is THE pool (the whole reason the
// daemon exists — managed Postgres tiers allow ~22 connections; a fresh
// connection per agent turn would exhaust that instantly).
require('./types'); // registers the int8 parser before any query runs
const { Pool } = require('pg');

function createPool(url) {
  const conn = url || process.env.OLMA_DB_URL;
  if (!conn) throw new Error('OLMA_DB_URL is required (no credentials are baked into the source)');
  const pool = new Pool({
    connectionString: conn,
    max: parseInt(process.env.OLMA_DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
  });
  // An idle client dying (e.g. Postgres restart) emits 'error' on the pool;
  // unhandled, that's an uncaught exception and a pointless daemon crash.
  pool.on('error', (e) => console.error('[pool] idle client error:', e.message));
  return pool;
}

// Run fn inside a transaction on a dedicated client. Domain state transitions
// go through this — Postgres brings real concurrency that SQLite serialized.
async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTx };
