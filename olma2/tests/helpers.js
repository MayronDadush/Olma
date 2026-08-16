'use strict';
// Each test file gets its own throwaway database, built by running the real
// migrations — the same runner production uses. No hand-applied ALTERs in
// tests, ever (the v1 wound this design exists to close).
const { Client, Pool } = require('pg');
const crypto = require('node:crypto');
const { migrate } = require('../src/db/migrate');

const ADMIN_URL = process.env.OLMA_TEST_ADMIN_URL
  || 'postgres://olma:olma2local@127.0.0.1:5432/olma2_test';

function testDbName() {
  return 'olma2_t_' + crypto.randomBytes(6).toString('hex');
}

// Creates a fresh DB + pool; returns { pool, teardown }.
async function freshDb() {
  const name = testDbName();
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  await migrate(setup);
  await setup.end();

  const pool = new Pool({ connectionString: url, max: 6 });
  const teardown = async () => {
    await pool.end();
    const admin2 = new Client({ connectionString: ADMIN_URL });
    await admin2.connect();
    try {
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch (e) {
      // WITH (FORCE) has to terminate any backend still attached, which needs
      // pg_signal_backend. Failing to clean up a throwaway database must never
      // turn a passing suite red — a leftover olma2_t_* database is inert, and
      // the next run's CREATE uses a fresh random name anyway.
      console.warn(`[test] could not drop ${name}: ${e.message}`);
    }
    await admin2.end();
  };
  return { pool, teardown, url };
}

// Shorthand: create an active user and return the row.
async function makeUser(pool, phone, extra = {}) {
  const users = require('../src/domain/users');
  const client = await pool.connect();
  try {
    const res = await users.createUser(client, { phone, firstName: extra.firstName || 'Test', ...extra });
    if (!res.ok) throw new Error('makeUser failed: ' + res.error.message);
    return res.data.user;
  } finally {
    client.release();
  }
}

module.exports = { freshDb, makeUser };
