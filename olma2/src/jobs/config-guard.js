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

// AGENTS.md carries the identity token inline (2026-08-27), so it is now a
// per-user secret rendered by a template — and a rendering bug could hand one
// person's agent another person's token, which is total impersonation rather
// than a leak. Same detector shape as the carryover check below, and the same
// reasoning: the failure is silent, so a machine has to be the one looking.
// A workspace still on the pre-token doctrine is NOT a violation — it falls
// back to reading .olma-identity, which still works.
async function checkAgentsTokens(client) {
  const { rows } = await client.query(
    `SELECT id, phone, workspace_path, identity_token FROM users
     WHERE status = 'active' AND workspace_path IS NOT NULL`
  );
  const byToken = new Map(rows.map((u) => [u.identity_token, Number(u.id)]));
  const violations = [];
  for (const u of rows) {
    let doctrine;
    try { doctrine = fs.readFileSync(path.join(u.workspace_path, 'AGENTS.md'), 'utf8'); } catch { continue; }
    if (doctrine.includes('{{IDENTITY_TOKEN}}')) {
      violations.push(`user ${u.id} (${u.phone}): AGENTS.md has an unrendered {{IDENTITY_TOKEN}} — every tool call will fail auth`);
      continue;
    }
    if (doctrine.includes(u.identity_token)) continue; // correct, and the common case
    for (const [token, ownerId] of byToken) {
      if (ownerId !== Number(u.id) && doctrine.includes(token)) {
        violations.push(`user ${u.id} (${u.phone}): AGENTS.md carries user ${ownerId}'s identity token — that agent can act as them`);
        break;
      }
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

// The marker that says "this row is the guard's, and the guard owns its
// lifecycle" — matched on the way back OUT, so only rows filed here are ever
// auto-closed. A human-filed or agent-reported issue is never touched.
const GUARD_DETAIL = 'raised by config-guard';

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
       VALUES ('bug', 'agent_detected', $1, $2, 'new')`,
      [title, GUARD_DETAIL]
    );
    filed++;
  }
  return filed;
}

// A watchdog that only ever OPENS rows stops being a watchdog. Every sweep
// re-derives the full truth from scratch — which is also what makes closing
// safe to get wrong: a condition closed prematurely is re-filed on the very
// next tick, so the worst case is a row that flickers, not one that vanishes.
// A title the guard filed and no longer reports is a condition that has cleared — and leaving it open is worse than never
// filing it, because it buries the live rows among the dead ones. Found on
// 2026-08-27: 13 open issues, every single one already resolved (four identity
// mismatches fixed the day before, nine outbox alarms from a credit outage
// long since over). That list is the same shape as the /health page nobody
// read for 13 hours — a signal that cries wolf teaches you to ignore it.
//
// Deliberately narrow: only rows this guard filed (detail = GUARD_DETAIL) and
// only while still open. 'fixed' rather than a delete — the fact that the
// condition happened at all is history worth keeping, and the dashboard can
// still show it. ('fixed' is the schema's word; the CHECK on issues.status
// allows new|triaged|fixed|wontfix and nothing else.)
async function closeResolved(client, violations) {
  const titles = violations.map((v) => v.slice(0, 200));
  const { rowCount } = await client.query(
    `UPDATE issues SET status = 'fixed', updated_at = now()
      WHERE detail = $1 AND status IN ('new','triaged')
        AND NOT (title = ANY($2::text[]))`,
    [GUARD_DETAIL, titles]
  );
  return rowCount;
}

// Messages that keep failing delivery are invisible otherwise: the worker
// retries with backoff forever and nobody hears about it.
// Every agent in openclaw.json must belong to somebody. The DB→disk direction
// was checked from the start; this is the reverse, and nothing looked that way
// until six orphan agents (u-15..u-20) were found by hand on 2026-08-27, two
// days after a rolled-back sweep left them behind — each with a workspace
// holding another user's carryover text and an identity token belonging to no
// one. Only `u-<n>` ids are judged: `main`, `intake` and any future
// infrastructure agent have no user row by design.
async function checkOrphanAgents(client, cfg) {
  const ids = occ.listAgentIds(cfg).filter((id) => /^u-\d+$/.test(id));
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT agent_id FROM users WHERE agent_id = ANY($1) AND status = 'active'`, [ids]);
  const known = new Set(rows.map((r) => r.agent_id));
  return ids.filter((id) => !known.has(id)).map((id) =>
    `agent ${id} is in openclaw.json with no active user — orphan of a failed provisioning; its workspace may hold another person's text`);
}

// Permission to use a model is spread across THREE independent lists, and a
// model missing from any one of them is refused — so they only work when they
// agree. Found 2026-09-01, the expensive way: a pilot registered two models
// through the two lists the code knew about and the override was still refused,
// because gateway 2026.8.1 had introduced a third, `agents.defaults.modelPolicy
// .allow`, and seeded it from the then-current allowlist. Nothing was broken
// and nothing said so; the config simply disagreed with itself.
//
//   agents.defaults.models              — the allowlist (what we intend to permit)
//   models.providers.openrouter.models  — the catalog (what the gateway can resolve)
//   agents.defaults.modelPolicy.allow   — a second permit list, 2026.8.1+
//
// This is the `agents.list` → `agents.entries` shape a third time: the vendor's
// own migration moves a key, our writer keeps the old schema in its head, and
// the failure is silent until something tries to use the result. The general
// version — diffing every key in openclaw.json against what we expect — was
// deliberately NOT built. It cannot tell a key that matters from the dozens
// that do not, and a guard that files an issue per harmless vendor addition is
// the 13-dead-rows failure documented above, manufactured on purpose.
//
// Severity is split because the consequences are not comparable: a DEFAULT
// model missing from a restricting list means every live turn fails, while a
// registered-but-unpermitted candidate only means the next pilot is refused.
function modelIdsOf(defaultModel) {
  if (typeof defaultModel === 'string') return [defaultModel];
  if (defaultModel && typeof defaultModel === 'object') {
    const fb = Array.isArray(defaultModel.fallbacks) ? defaultModel.fallbacks : [];
    return [defaultModel.primary, ...fb].filter((m) => typeof m === 'string' && m);
  }
  return [];
}

function checkModelPermissions(cfg) {
  const defaults = (cfg.agents && cfg.agents.defaults) || {};
  const allowlist = Object.keys(defaults.models || {});
  const policy = defaults.modelPolicy;
  // An absent or EMPTY allow list means "no restriction" — the gateway's own
  // error text says so ("remove/empty the list to allow any model"). Only a
  // list that actually restricts can be disagreed with.
  const policyAllow = policy && Array.isArray(policy.allow) && policy.allow.length
    ? new Set(policy.allow) : null;
  const catalog = new Set(
    (((cfg.models || {}).providers || {}).openrouter || {}).models
      ?.map((m) => m && m.id).filter(Boolean) || []);
  const inCatalog = (id) => !id.startsWith('openrouter/') || catalog.has(id.replace(/^openrouter\//, ''));

  const violations = [];

  // The live path first. A default or fallback the gateway will refuse is not a
  // latent problem — it is every user's next message failing, or silently
  // burning a fallback nobody chose.
  for (const id of modelIdsOf(defaults.model)) {
    if (policyAllow && !policyAllow.has(id)) {
      violations.push(`default/fallback model ${id} is missing from agents.defaults.modelPolicy.allow — the gateway will refuse it and live turns fall through to the next fallback`);
    }
    if (!inCatalog(id)) {
      violations.push(`default/fallback model ${id} has no entry in models.providers.openrouter.models — the gateway cannot resolve it`);
    }
  }

  // Then the pilot path: registered candidates that cannot actually be selected.
  for (const id of allowlist) {
    if (modelIdsOf(defaults.model).includes(id)) continue; // already reported above, with the louder wording
    if (policyAllow && !policyAllow.has(id)) {
      violations.push(`model ${id} is in the allowlist but not in agents.defaults.modelPolicy.allow — a --model pilot on it will be refused`);
    }
    if (!inCatalog(id)) {
      violations.push(`model ${id} is in the allowlist but not in models.providers.openrouter.models — a --model pilot on it will be refused`);
    }
  }
  return violations;
}

// The count deliberately does NOT go in the title. fileViolations dedupes on
// the title, so a count that moves files a brand-new issue every time it
// changes: nine near-identical "N outbox message(s) stuck" rows piled up over
// four days of the credit outage, which is how a dashboard stops being read.
async function checkStuckOutbox(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE sent_at IS NULL AND attempts >= 5 AND created_at < now() - interval '1 hour'`);
  return rows[0].n > 0
    ? ['outbox messages stuck after 5+ delivery attempts — proactive messaging is failing']
    : [];
}

async function run(client, { configPath } = {}) {
  let violations = [];
  try {
    const cfg = occ.loadConfig(configPath);
    violations = violations.concat(checkOpenclawConfig(cfg));
    violations = violations.concat(checkModelPermissions(cfg));
    violations = violations.concat(await checkOrphanAgents(client, cfg));
  } catch (e) {
    violations.push('openclaw.json unreadable: ' + e.message);
  }
  violations = violations.concat(await checkIdentityFiles(client));
  violations = violations.concat(await checkAgentsTokens(client));
  violations = violations.concat(await checkCarryovers(client));
  violations = violations.concat(await checkStuckOutbox(client));
  const filed = await fileViolations(client, violations);
  const closed = await closeResolved(client, violations);
  return { violations: violations.length, newIssues: filed, closedIssues: closed };
}

module.exports = {
  run, checkOpenclawConfig, checkModelPermissions, checkIdentityFiles, checkAgentsTokens,
  checkCarryovers, checkOrphanAgents, checkStuckOutbox, fileViolations, closeResolved,
};
