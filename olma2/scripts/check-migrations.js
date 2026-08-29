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
// Usage: node scripts/check-migrations.js
'use strict';
const { listMigrations } = require('../src/db/migrate');

try {
  const all = listMigrations();
  console.log(`${all.length} migrations, no duplicate version numbers.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
