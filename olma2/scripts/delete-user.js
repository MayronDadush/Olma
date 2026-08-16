#!/usr/bin/env node
// Fully remove a user: DB row (cascades to tasks/connections/outbox/...),
// their OpenClaw agent + binding, and their workspace. Used for testing the
// onboarding flow from scratch, and as the real "delete my account" path.
//
// NOTE: removing the binding needs a gateway restart to take effect
// (bindings don't hot-reload) — otherwise the gateway keeps routing that
// phone to the now-deleted agent. The script says so and can do it for you.
//
// Usage: node scripts/delete-user.js +9725xxxxxxx [--apply] [--restart]
'use strict';
const fs = require('node:fs');
const { createPool } = require('../src/db/pool');
const occ = require('../src/intake/openclaw-config');

const phone = process.argv[2];
const APPLY = process.argv.includes('--apply');
const RESTART = process.argv.includes('--restart');

if (!/^\+\d{7,15}$/.test(phone || '')) {
  console.error('usage: delete-user.js +9725xxxxxxx [--apply] [--restart]');
  process.exit(1);
}

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, phone, first_name, agent_id, workspace_path FROM users WHERE phone = $1`, [phone]);
  const user = rows[0];
  if (!user) { console.log('no such user'); await pool.end(); return; }

  console.log(`user ${user.id} (${user.phone}) agent=${user.agent_id} workspace=${user.workspace_path}`);
  const counts = await pool.query(
    `SELECT (SELECT count(*) FROM tasks WHERE owner_id = $1) AS tasks,
            (SELECT count(*) FROM outbox WHERE user_id = $1) AS outbox,
            (SELECT count(*) FROM connections WHERE requester_id = $1 OR target_id = $1) AS connections`,
    [user.id]);
  console.log('cascades:', counts.rows[0]);

  if (!APPLY) { console.log('dry run — pass --apply to delete'); await pool.end(); return; }

  await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);
  await pool.query(`DELETE FROM waitlist WHERE phone = $1`, [phone]);
  console.log('DB rows deleted.');

  const cfg = occ.loadConfig();
  const before = { agents: cfg.agents.list.length, bindings: cfg.bindings.length };
  cfg.agents.list = cfg.agents.list.filter((a) => a.id !== user.agent_id);
  cfg.bindings = cfg.bindings.filter((b) => !(b.match && b.match.peer && b.match.peer.id === phone));
  const allow = cfg.channels?.whatsapp?.accounts?.default?.allowFrom;
  if (Array.isArray(allow)) {
    cfg.channels.whatsapp.accounts.default.allowFrom = allow.filter((p) => p !== phone);
  }
  occ.saveConfig(cfg);
  console.log(`config: agents ${before.agents}→${cfg.agents.list.length}, bindings ${before.bindings}→${cfg.bindings.length}`);

  if (user.workspace_path && fs.existsSync(user.workspace_path)) {
    fs.rmSync(user.workspace_path, { recursive: true, force: true });
    console.log('workspace removed.');
  }

  if (RESTART) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('systemctl', ['--user', 'restart', 'openclaw-gateway'],
      { env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' } });
    console.log(r.status === 0 ? 'gateway restarted — binding removal is live.'
      : 'gateway restart FAILED: ' + String(r.stderr));
  } else {
    console.log('\n⚠️  Restart the gateway for the binding removal to take effect:');
    console.log('   systemctl --user restart openclaw-gateway');
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
