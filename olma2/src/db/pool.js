'use strict';
// Single pool per process. In brokerd this is THE pool (the whole reason the
// daemon exists — managed Postgres tiers allow ~22 connections; a fresh
// connection per agent turn would exhaust that instantly).
require('./types'); // registers the int8 parser before any query runs
const { Pool } = require('pg');

// Two ceilings, both because the box has one core and brokerd answers live
// users on it. A statement that runs away holds a pooled client AND the core
// for as long as it likes; with ten clients and a queue of turn_starts behind
// them, nothing bounds how long a person waits — the MCP shim gives up at 30s
// (bin/olma-mcp.js CALL_TIMEOUT_MS) with a generic "backend not reachable",
// which names the wrong culprit. 20s is under that line, so a runaway query
// fails INSIDE the tool call with Postgres's own "canceling statement due to
// statement timeout", on the row that caused it. Set per connection through
// libpq options, so every statement on every client this pool hands out is
// covered and nothing has to remember to opt in. `0` disables, for the one
// script that legitimately runs a long statement.
//
// The second is how long pool.connect() may wait for a free client. Without
// it a checkout queues for ever behind ten stuck ones and withTx never
// returns — the same invisible hang the test helper guards against.
//
// migrate.js and the test helper build their own clients and are untouched:
// a migration's CREATE INDEX may legitimately take longer than a tool call,
// and the suite already pins its own session options.
const STATEMENT_TIMEOUT_MS = parseInt(process.env.OLMA_DB_STATEMENT_TIMEOUT_MS || '20000', 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.OLMA_DB_CONNECT_TIMEOUT_MS || '10000', 10);

function createPool(url) {
  const conn = url || process.env.OLMA_DB_URL;
  if (!conn) throw new Error('OLMA_DB_URL is required (no credentials are baked into the source)');
  const pool = new Pool({
    connectionString: conn,
    max: parseInt(process.env.OLMA_DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
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

module.exports = { createPool, withTx, STATEMENT_TIMEOUT_MS, CONNECT_TIMEOUT_MS };
