'use strict';
// Every test file gets its own throwaway database, created from an admin
// connection and dropped after. Never FOOD_DB_URL: a test that could reach
// the live database is how olma2's suite once provisioned into production.
const crypto = require('crypto');
const { Client } = require('pg');
const { createPool, migrate } = require('../src/db');

const ADMIN_URL = process.env.FOOD_TEST_ADMIN_URL || 'postgres:///postgres';

// Photos go to a directory of this test file's own, never the live one
// (src/photos.js refuses to fall back to it under test).
if (!process.env.FOOD_PHOTO_DIR) {
  process.env.FOOD_PHOTO_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'food-photos-'));
}

async function freshDb(t) {
  const name = 'food_t_' + crypto.randomBytes(6).toString('hex');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL.replace(/^postgres:\/\/\//, 'postgres://localhost/'));
  if (ADMIN_URL.startsWith('postgres:///')) url.host = '';
  url.pathname = '/' + name;
  const conn = ADMIN_URL.startsWith('postgres:///') ? `postgres:///${name}` : url.toString();
  const pool = createPool(conn);
  await migrate(pool);
  t.after(async () => {
    await pool.end();
    const a = new Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return pool;
}

module.exports = { freshDb };
