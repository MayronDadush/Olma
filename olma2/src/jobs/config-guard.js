'use strict';
// The identity-hardening watchdog. Two sweeps, both read-only:
//
// 1. OpenClaw config invariants — the settings the entire user-isolation
//    model rests on. If an OpenClaw update quietly regresses one of these,
//    nothing crashes: identity just stops being enforceable. This guard turns
//    "silent break, discovered weeks later" into "red row on the dashboard +
//    an issue within minutes".
// 2. Identity-file consistency — every active user's workspace must hold a
//    .olma-identity that matches users.identity_token exactly.
const fs = require('node:fs');
const path = require('node:path');
const occ = require('../intake/openclaw-config');

// The invariants, each with why it matters.
function checkOpenclawConfig(cfg) {
  const violations = [];
  const tools = cfg.tools || {};
  if (!tools.fs || tools.fs.workspaceOnly !== true) {
    violations.push('tools.fs.workspaceOnly is not true — identity tokens become readable across workspaces');
  }
  const also = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  if (!also.includes('read')) {
    violations.push('tools.alsoAllow lacks "read" — agents cannot read their .olma-identity, all tool auth fails');
  }
  if (!cfg.mcp || !cfg.mcp.servers || Object.keys(cfg.mcp.servers).length === 0) {
    violations.push('mcp.servers is empty — the Olma tool server is not registered');
  }
  return violations;
}

async function checkIdentityFiles(client) {
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path, identity_token FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const violations = [];
  for (const u of rows) {
    const p = path.join(u.workspace_path, '.olma-identity');
    try {
      const onDisk = fs.readFileSync(p, 'utf8').trim();
      if (onDisk !== u.identity_token) {
        violations.push(`user ${u.id} (${u.phone}): identity file does not match DB token`);
      }
    } catch {
      violations.push(`user ${u.id} (${u.phone}): identity file missing/unreadable at ${p}`);
    }
  }
  return violations;
}

// A carryover section holds one person's own words, quoted into their own
// card by provisioning. If two cards quote the SAME words, one of them is
// reading a stranger's message — which is what happened on 2026-08-20 and was
// only noticed on 2026-08-27, by a human, after the agent read it aloud to the
// wrong person. Prevention lives in jobs/intake.readIntakeFirstMessage; this
// is the detector, because a leak that only a person can spot is a leak that
// runs for a week.
const CARRYOVER_HEADING = '## מה שכבר שיתפו';

async function checkCarryovers(client) {
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const seen = new Map(); // carryover text → first user id that quoted it
  const violations = [];
  for (const u of rows) {
    let card;
    try { card = fs.readFileSync(path.join(u.workspace_path, 'USER.md'), 'utf8'); } catch { continue; }
    const at = card.indexOf(CARRYOVER_HEADING);
    if (at < 0) continue;
    const body = card.slice(at).replace(/\s+/g, ' ').trim();
    const prior = seen.get(body);
    if (prior !== undefined) {
      violations.push(
        `users ${prior} and ${u.id} carry the SAME intake carryover text — one card is quoting another person's message`);
    } else {
      seen.set(body, u.id);
    }
  }
  return violations;
}

// Idempotent issue filing: one open issue per distinct violation text.
async function fileViolations(client, violations) {
  let filed = 0;
  for (const v of violations) {
    const title = v.slice(0, 200);
    const { rows } = await client.query(
      `SELECT 1 FROM issues WHERE title = $1 AND status IN ('new','triaged')`, [title]
    );
    if (rows[0]) continue;
    await client.query(
      `INSERT INTO issues (category, source, title, detail, status)
       VALUES ('bug', 'agent_detected', $1, 'raised by config-guard', 'new')`,
      [title]
    );
    filed++;
  }
  return filed;
}

// Messages that keep failing delivery are invisible otherwise: the worker
// retries with backoff forever and nobody hears about it.
async function checkStuckOutbox(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE sent_at IS NULL AND attempts >= 5 AND created_at < now() - interval '1 hour'`);
  return rows[0].n > 0
    ? [`${rows[0].n} outbox message(s) stuck after 5+ delivery attempts — proactive messaging is failing`]
    : [];
}

async function run(client, { configPath } = {}) {
  let violations = [];
  try {
    violations = violations.concat(checkOpenclawConfig(occ.loadConfig(configPath)));
  } catch (e) {
    violations.push('openclaw.json unreadable: ' + e.message);
  }
  violations = violations.concat(await checkIdentityFiles(client));
  violations = violations.concat(await checkCarryovers(client));
  violations = violations.concat(await checkStuckOutbox(client));
  const filed = await fileViolations(client, violations);
  return { violations: violations.length, newIssues: filed };
}

module.exports = { run, checkOpenclawConfig, checkIdentityFiles, checkCarryovers, checkStuckOutbox, fileViolations };
