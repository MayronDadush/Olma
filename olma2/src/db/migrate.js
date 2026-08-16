#!/usr/bin/env node
// Numbered-migrations runner. The one source of truth for schema, forever —
// tests build their throwaway DBs by running exactly this, so schema drift
// between production and tests (the v1 wound) cannot recur.
//
// Usage: node src/db/migrate.js            (applies pending to $OLMA_DB_URL)
//        require(...).migrate(client)      (programmatic, used by tests)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => ({ version: parseInt(file, 10), file }));
}

async function migrate(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const pending = listMigrations().filter((m) => !applied.has(m.version));
  for (const m of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      err.message = `migration ${m.file}: ${err.message}`;
      throw err;
    }
  }
  return pending.map((m) => m.file);
}

module.exports = { migrate, listMigrations };

if (require.main === module) {
  const { Client } = require('pg');
  const url = process.env.OLMA_DB_URL;
  if (!url) { console.error('OLMA_DB_URL is required'); process.exit(1); }
  const client = new Client({ connectionString: url });
  client.connect()
    .then(() => migrate(client))
    .then((appliedNow) => {
      console.log(appliedNow.length ? `applied: ${appliedNow.join(', ')}` : 'up to date');
      return client.end();
    })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
