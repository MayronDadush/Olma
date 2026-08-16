#!/usr/bin/env node
// Fully remove a user: DB row (cascades to tasks/connections/outbox/...),
// their OpenClaw agent + binding, and their workspace. Used for testing the
// onboarding flow from scratch, and as the real "delete my account" path.
//
// The dashboard's delete button runs the same code (src/intake/deprovision.js)
// — this CLI exists for when you'd rather not click.
//
// Usage: node scripts/delete-user.js +9725xxxxxxx [--apply]
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const { deprovisionUser, previewDeletion } = require('../src/intake/deprovision');

const phone = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!/^\+\d{7,15}$/.test(phone || '')) {
  console.error('usage: delete-user.js +9725xxxxxxx [--apply]');
  process.exit(1);
}

(async () => {
  const pool = createPool();
  const preview = await withTx(pool, (c) => previewDeletion(c, phone));
  if (!preview.ok) { console.log('no such user'); await pool.end(); return; }
  const { user, counts } = preview.data;
  console.log(`user ${user.id} (${user.phone}) agent=${user.agent_id} workspace=${user.workspace_path}`);
  console.log('cascades:', counts);

  if (!APPLY) { console.log('dry run — pass --apply to delete'); await pool.end(); return; }

  const res = await withTx(pool, (c) => deprovisionUser(c, phone));
  console.log('deleted. config:', res.data.config, 'workspace removed:', res.data.workspaceRemoved);
  // Agent and binding leave in one write, so routing is already live; a
  // restart only happens in the odd case deprovision detects and handles.
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
