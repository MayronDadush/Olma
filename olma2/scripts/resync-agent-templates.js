#!/usr/bin/env node
// Push the current agents-template.md into every existing user's workspace.
//
// AGENTS.md is written once, at provisioning. That means every doctrine fix —
// the act-first rule, the identity-token batching fix, gender consistency —
// reaches NEW users only, while the people already using Olma keep whatever
// text existed on the day they joined. The user whose feedback prompted the
// act-first rewrite would never have seen it.
//
// Only AGENTS.md is rewritten. USER.md and MEMORY.md accumulate real content
// about the person and must never be regenerated from a template.
//
// Usage: node scripts/resync-agent-templates.js [--apply]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createPool } = require('../src/db/pool');
const { renderAgentsMd } = require('../src/intake/provision');
const turnDomain = require('../src/domain/turn');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  // AGENTS.md is rendered PER USER (the identity token is inline since
  // 2026-08-27), so staleness is judged against each person's own rendering,
  // never the raw template.
  const { rows } = await pool.query(
    `SELECT id, first_name, phone, workspace_path, identity_token FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL ORDER BY id`);

  // Which turn doctrine each person gets — the tool call, or the Turn
  // context block the gateway plugin prepends — is a per-person flag
  // (domain/turn.js, CONTEXT_FLAG), read once here rather than per row.
  const client = await pool.connect();
  let contextFlag;
  try { contextFlag = await require('../src/domain/flags').getFlag(client, turnDomain.CONTEXT_FLAG); } finally { client.release(); }

  let changed = 0, same = 0, missing = 0;
  for (const u of rows) {
    const p = path.join(u.workspace_path, 'AGENTS.md');
    if (!fs.existsSync(p)) {
      console.log(`  ! ${u.id} ${u.first_name || u.phone}: no AGENTS.md at ${p}`);
      missing++;
      continue;
    }
    const turnContext = turnDomain.coveredBy(contextFlag, u.phone);
    const rendered = renderAgentsMd(u.identity_token, { turnContext });
    if (fs.readFileSync(p, 'utf8') === rendered) { same++; continue; }
    console.log(`  ${APPLY ? '→' : '·'} ${u.id} ${u.first_name || u.phone}: template is stale${turnContext ? ' (turn-context doctrine)' : ''}`);
    if (APPLY) {
      fs.writeFileSync(p, rendered, { mode: 0o600 });
      fs.chmodSync(p, 0o600); // writeFileSync mode applies only at creation
    }
    changed++;
  }
  console.log(`\n${changed} stale, ${same} already current, ${missing} missing`);
  if (!APPLY && changed) console.log('dry run — pass --apply to write');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
