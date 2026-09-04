#!/usr/bin/env node
// Fast, DB-less pre-flight: two migration files cannot share a version.
//
// listMigrations() already refuses this — but only when something calls
// migrate(), which every test's freshDb() does. That is how the two most
// recent collisions were actually found: not by this check (it did not
// exist yet) but by the ENTIRE suite throwing in its `before` hook, which
// reads exactly like "everything is broken" rather than "one migration
// number is duplicated." This script runs the same check standalone, with
// no Postgres needed, so CI can fail in three seconds with the one line
// that actually explains it, before spending several minutes running (and
// failing) 500+ tests to discover the same thing.
//
// Usage: node scripts/check-migrations.js [migrations-dir]
//
// CI passes no argument and gets the real tree. The optional directory is for
// this script's own test, which needs a colliding pair to check the exit code
// and stream — and must NOT get one by writing into the real migrations/
// directory, because every concurrently-running test file reads it too (see
// listMigrations, and incidents.md "A test file poisoned every other one").
'use strict';
const { listMigrations } = require('../src/db/migrate');

try {
  const all = listMigrations(process.argv[2] || undefined);
  console.log(`${all.length} migrations, no duplicate version numbers.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
