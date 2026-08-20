#!/usr/bin/env node
// One-off (idempotent, safe to re-run): render every existing user's USER.md
// from the DB. New knowledge flows through brokerd's per-call refresh; this
// script exists because users provisioned before that hook still carry the
// 28-byte provisioning stub ("First name: unknown") — verified live
// 2026-08-19 on all four active users.
//
// Usage: node scripts/backfill-user-cards.js [--apply]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../src/db/pool');
const { refreshUserCard } = require('../src/intake/user-card');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, first_name, phone, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL ORDER BY id`);

  let rendered = 0, skipped = 0;
  for (const u of rows) {
    const p = path.join(u.workspace_path, 'USER.md');
    const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0;
    if (!APPLY) {
      console.log(`  · ${u.id} ${u.first_name || u.phone}: would render (current ${before} bytes)`);
      continue;
    }
    const done = await refreshUserCard(pool, u.id);
    if (done) {
      const after = fs.readFileSync(p, 'utf8').length;
      console.log(`  → ${u.id} ${u.first_name || u.phone}: ${before} → ${after} bytes`);
      rendered++;
    } else {
      console.log(`  ! ${u.id} ${u.first_name || u.phone}: skipped (no workspace on disk)`);
      skipped++;
    }
  }
  console.log(APPLY
    ? `done: ${rendered} rendered, ${skipped} skipped`
    : `dry run over ${rows.length} users — re-run with --apply`);
  await pool.end();
})();
