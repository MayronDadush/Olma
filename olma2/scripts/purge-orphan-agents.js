#!/usr/bin/env node
// Removes the agent stores of people (and rooms) that no longer exist, so
// "delete my account" also deletes what they said (src/intake/orphan-agents.js
// has the why, and why the gateway must be STOPPED).
//
//   node scripts/purge-orphan-agents.js            # dry run: what would go, what stays and why
//   systemctl --user stop openclaw-gateway
//   node scripts/purge-orphan-agents.js --apply    # refuses any dir a process still has open
//   systemctl --user start openclaw-gateway
//
// This script never stops or starts the gateway: the window with no WhatsApp
// listener is the operator's to choose. Expect the gateway's doctor to drop the
// removed agents from its database registry on the next start.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../src/db/pool');
const occ = require('../src/intake/openclaw-config');
const orphans = require('../src/intake/orphan-agents');

const APPLY = process.argv.includes('--apply');
const HOME = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';

(async () => {
  const pool = createPool();
  try {
    const dirs = fs.readdirSync(path.join(HOME, 'agents'))
      .filter((d) => fs.statSync(path.join(HOME, 'agents', d)).isDirectory());
    const cfg = occ.loadConfig();
    const users = (await pool.query(`SELECT agent_id FROM users WHERE agent_id IS NOT NULL`)).rows;
    const groups = (await pool.query(`SELECT agent_id FROM chat_groups WHERE agent_id IS NOT NULL`)).rows;
    const plan = orphans.planPurge({
      dirs,
      configIds: occ.listAgentIds(cfg),
      userAgentIds: users.map((r) => r.agent_id),
      groupAgentIds: groups.map((r) => r.agent_id),
    });
    for (const k of plan.keep) console.log(`keep   ${k.id.padEnd(12)} ${k.reason}`);
    for (const id of plan.purge) {
      const kb = Math.round(orphans.dirBytes(path.join(HOME, 'agents', id)) / 1024);
      console.log(`purge  ${id.padEnd(12)} ${kb} KB`);
    }
    if (!APPLY) { console.log(`\n${plan.purge.length} to purge. Dry run; stop the gateway and pass --apply.`); return; }
    const res = orphans.purge(HOME, plan.purge);
    for (const r of res) console.log(r.removed ? `removed ${r.id}` : `SKIPPED ${r.id}: ${r.why}`);
    const skipped = res.filter((r) => !r.removed).length;
    console.log(`\n${res.length - skipped} removed, ${skipped} skipped.`);
    if (skipped) process.exitCode = 1;
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
