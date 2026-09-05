'use strict';
// The exact inverse of provision.js: remove a user's DB row (cascading to
// tasks/connections/outbox/...), their OpenClaw agent + binding + allowFrom
// entry, and their workspace directory.
//
// Shared by scripts/delete-user.js and the dashboard's delete button, so the
// two can never drift into deleting different things.
//
// Like provisioning, the agent and binding are removed in ONE config write,
// so the routing change is live immediately — see openclaw-config.js for why
// that pairing matters. Once the binding is gone, the intake catch-all picks
// that phone up again, which is exactly what "let me test onboarding from
// scratch" needs.
const fs = require('node:fs');
const occ = require('./openclaw-config');
const { removeWorkspaceTree } = require('./provision');
const { ok, err } = require('../domain/results');

// What would be destroyed — rendered to the operator BEFORE they confirm.
// Deleting a person's account is not something to do behind a single click
// with no idea of the blast radius.
async function previewDeletion(client, phone) {
  const { rows } = await client.query(
    `SELECT id, phone, first_name, last_name, agent_id, workspace_path, created_at
     FROM users WHERE phone = $1`, [phone]
  );
  const user = rows[0];
  if (!user) return err('not_found', 'no such user');
  const counts = (await client.query(
    `SELECT (SELECT count(*)::int FROM tasks WHERE owner_id = $1) AS tasks,
            (SELECT count(*)::int FROM outbox WHERE user_id = $1) AS outbox,
            (SELECT count(*)::int FROM connections WHERE requester_id = $1 OR target_id = $1) AS connections,
            (SELECT count(*)::int FROM meeting_participants WHERE user_id = $1) AS meetings,
            (SELECT count(*)::int FROM shares WHERE owner_id = $1 OR viewer_id = $1) AS shares`,
    [user.id]
  )).rows[0];
  return ok({ user, counts });
}

// deps.configPath / deps.removeWorkspace exist so tests never touch the live
// gateway config or a real workspace.
async function deprovisionUser(client, phone, {
  configPath, removeWorkspace = true,
  // Same seam as provisionUser: injectable so the suite never spawns systemctl.
  restartGateway = require('./gateway-restart').restartGateway,
} = {}) {
  const preview = await previewDeletion(client, phone);
  if (!preview.ok) return preview;
  const { user, counts } = preview.data;

  await client.query(`DELETE FROM users WHERE id = $1`, [user.id]);
  await client.query(`DELETE FROM waitlist WHERE phone = $1`, [phone]);

  const cfg = occ.loadConfig(configPath);
  const before = { bindings: (cfg.bindings || []).length };
  const agentRemoved = occ.removeAgent(cfg, user.agent_id);
  cfg.bindings = (cfg.bindings || []).filter(
    (b) => !(b.match && b.match.peer && b.match.peer.id === phone)
  );
  const allow = cfg.channels?.whatsapp?.accounts?.default?.allowFrom;
  if (Array.isArray(allow)) {
    cfg.channels.whatsapp.accounts.default.allowFrom = allow.filter((p) => p !== phone);
  }
  occ.saveConfig(cfg, configPath);

  // Same trap as provisioning, mirrored: if only the binding went away and
  // the agent roster is untouched, the write is bindings-only and the gateway
  // silently ignores it — the phone would keep routing to a deleted agent.
  const bindingRemoved = before.bindings !== cfg.bindings.length;
  let restarted = false;
  if (bindingRemoved && !agentRemoved) {
    // Awaited, never spawnSync — this runs inside brokerd (see provision.js).
    restarted = await restartGateway();
  }

  // Through removeWorkspaceTree, never a bare rmSync: .olma-identity carries
  // the immutable bit (chattr +i) since 2026-08-27, which stops root too — so
  // a plain recursive remove throws EPERM and the directory survives while
  // the caller is told the user was deleted.
  let workspaceRemoved = false;
  if (removeWorkspace && user.workspace_path) {
    workspaceRemoved = removeWorkspaceTree(user.workspace_path);
  }

  return ok({
    user, counts,
    config: { agentRemoved, bindingRemoved, restarted },
    workspaceRemoved,
  });
}

module.exports = { deprovisionUser, previewDeletion };
