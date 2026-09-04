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

// Two branches picking the same next number is the ordinary way this repo
// works — nobody sees the other's migration until they merge — and until this
// check existed the collision was silent and awful: `version` is the PRIMARY
// KEY of schema_migrations, so the runner applied the first file, inserted its
// version, then applied the second and violated the key. Every test file's
// freshDb() threw in its `before` hook, and the suite stopped producing a
// result at all rather than a failure anyone could read. Cost most of an hour
// on a green branch whose own CI passed, because a push build sees one file
// and only the pull_request merge commit sees both.
//
// Fail here instead, by name, before a single statement runs.
//
// `dir` exists so a test can exercise this guard WITHOUT writing a decoy file
// into the real migrations/ directory. Two of them used to, and it was the
// cause of the CI wedge (incidents.md, "A test file poisoned every other
// one"): test files are separate processes sharing one filesystem, so for as
// long as the decoy sat on disk, every OTHER file's freshDb() threw here in
// its `before` hook. Callers in production pass nothing and get the real tree.
function listMigrations(dir = MIGRATIONS_DIR) {
  const all = fs.readdirSync(dir)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((file) => ({ version: parseInt(file, 10), file }));

  const byVersion = new Map();
  for (const m of all) {
    const clash = byVersion.get(m.version);
    if (clash) {
      throw new Error(
        `two migrations share version ${m.version}: ${clash} and ${m.file}. `
        + 'Renumber the newer one — the version is a primary key, so this cannot be applied.');
    }
    byVersion.set(m.version, m.file);
  }
  return all;
}

async function migrate(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Recording WHICH file a version came from, so the check below can exist.
  // Rows written before this column stay NULL and are simply not checked.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS file TEXT');

  const { rows } = await client.query('SELECT version, file FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r.file]));
  const all = listMigrations();

  // The other half of the collision problem, and the dangerous half: a version
  // this database already applied FROM A DIFFERENT FILE. The duplicate check in
  // listMigrations only sees one tree, so it cannot catch a number that was
  // burned by a branch which never merged — and production had exactly that
  // (012-usage-from-transcripts.sql, deployed by hand from an unmerged branch).
  // Without this, `applied.has(12)` is true, the new 012 is filtered out of
  // `pending` as already done, the deploy reports success, and the column the
  // code depends on is simply never created. Loud here beats silent there.
  for (const m of all) {
    const appliedFile = applied.get(m.version);
    if (appliedFile && appliedFile !== m.file) {
      throw new Error(
        `version ${m.version} was already applied here from ${appliedFile}, but this tree has `
        + `${m.file}. Renumber ${m.file} above every version this database has seen — never `
        + 'renumber or reuse one that has already been applied somewhere.');
    }
  }

  const pending = all.filter((m) => !applied.has(m.version));
  for (const m of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, file) VALUES ($1, $2)', [m.version, m.file]);
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
  require('./types');
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
