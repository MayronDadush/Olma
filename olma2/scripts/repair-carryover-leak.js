#!/usr/bin/env node
// Remove carryover sections quoting words their owner never sent. Logic and the
// reasoning behind it live in src/domain/carryover-repair.js.
//
// Usage: node scripts/repair-carryover-leak.js [--apply]
'use strict';
const { createPool } = require('../src/db/pool');
const { repairCarryovers } = require('../src/domain/carryover-repair');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const r = await repairCarryovers(pool, { apply: APPLY, log: (m) => console.log(m) });
  console.log(`\n${r.repaired.length} ${APPLY ? 'repaired' : 'to repair'}, `
    + `${r.ok} verified as their own, ${r.clean} with no carryover, `
    + `${r.unverifiable.length} left alone as unverifiable`
    + (r.failed.length ? `, ${r.failed.length} FAILED TO WRITE` : ''));
  if (!APPLY) console.log('dry run — pass --apply to write');
  await pool.end();
  if (r.failed.length) process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
