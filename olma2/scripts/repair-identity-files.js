#!/usr/bin/env node
// Repair every active user's .olma-identity against the DB and backfill the
// immutable bit onto all of them. Logic and the reasoning behind it live in
// src/domain/identity-repair.js.
//
// Usage: node scripts/repair-identity-files.js [--apply]
'use strict';
const { createPool } = require('../src/db/pool');
const { repairIdentityFiles } = require('../src/domain/identity-repair');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const r = await repairIdentityFiles(pool, { apply: APPLY, log: (m) => console.log(m) });
  console.log(`\n${r.repaired.length} ${APPLY ? 'repaired' : 'to repair'}, `
    + `${r.alreadyOk} already correct, ${r.missing} missing`
    + (APPLY ? `, ${r.locked} now immutable${r.lockFailed ? `, ${r.lockFailed} could not be locked` : ''}` : ''));
  if (!APPLY) console.log('dry run — pass --apply to write');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
