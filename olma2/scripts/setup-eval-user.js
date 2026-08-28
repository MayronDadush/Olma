#!/usr/bin/env node
// One-time setup of the dedicated eval user — the synthetic person the
// nightly behavioral evals talk to. Provisions it exactly like a real user
// (workspace, agent, binding, AGENTS.md with its own token — the point is to
// test the REAL stack), then marks it:
//
//   is_eval = true        → every sweep skips it, the outbox gate drops its
//                           rows (its phone is fake — see migration 019)
//   checkin_enabled=false → belt and braces on top of the sweep exclusion
//   digest_times = NULL   → no digest is ever due
//   timezone confirmed    → the bare-time scenarios depend on Asia/Jerusalem
//
// Dry-run by default; --apply to write. Idempotent: an existing eval user is
// re-marked, never duplicated.
//
// Usage (on the server): node scripts/setup-eval-user.js --apply
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const { provisionUser } = require('../src/intake/provision');
const { EVAL_PHONE } = require('../src/evals/harness');
const { DEFAULT_PATH: OPENCLAW_CONFIG } = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(`SELECT id, agent_id, is_eval FROM users WHERE phone = $1`, [EVAL_PHONE]);

  if (!APPLY) {
    console.log(rows[0]
      ? `exists: user ${rows[0].id} (agent ${rows[0].agent_id}, is_eval=${rows[0].is_eval}) — --apply would (re)mark it`
      : `no eval user at ${EVAL_PHONE} — --apply would provision one (writes a workspace + openclaw.json entry)`);
    await pool.end();
    return;
  }

  let userId = rows[0] && rows[0].id;
  if (!userId) {
    const res = await withTx(pool, (c) => provisionUser(c, {
      phone: EVAL_PHONE, firstName: 'בדיקה', configPath: OPENCLAW_CONFIG,
    }));
    if (!res.ok) throw new Error(`provision failed: ${res.error.message}`);
    userId = res.data.user.id;
    console.log(`provisioned eval user ${userId} (agent ${res.data.user.agent_id})`);
  }

  await pool.query(
    `UPDATE users SET is_eval = true, checkin_enabled = false, digest_times = NULL,
            timezone = 'Asia/Jerusalem', timezone_confirmed = true, onboarded_at = now()
      WHERE id = $1`, [userId]
  );
  await pool.query(
    `INSERT INTO audit_log (actor_id, event, detail) VALUES ($1, 'admin.eval_user_marked', '{}')`,
    [userId]
  );
  console.log(`user ${userId} marked is_eval — the nightly eval sweep is now armed`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
