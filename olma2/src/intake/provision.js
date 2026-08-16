'use strict';
// End-to-end provisioning for one user, v2 edition. Agent, allowFrom and
// binding all go into ONE config write and are live within about a second —
// no gateway restart, no scheduled activation, no welcome held back waiting
// for it. All filesystem/config side effects go through injectable deps so
// tests run against temp dirs, never the live gateway.
const fs = require('node:fs');
const path = require('node:path');
const usersDomain = require('../domain/users');
const audit = require('../domain/audit');
const { ok, err } = require('../domain/results');
const occ = require('./openclaw-config');

const TEMPLATE_PATH = path.join(__dirname, 'agents-template.md');

function defaultPaths(agentId) {
  const base = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
  return {
    workspace: `${base}/workspaces/${agentId}`,
    agentDir: `${base}/agents/${agentId}/agent`,
  };
}

// Seal = neutralise OpenClaw's stock onboarding kit before it ever runs:
// pre-stamp setupCompletedAt and write our own identity files. (v1 lesson:
// the stock BOOTSTRAP.md hijacks the first conversation.)
function seedWorkspace(workspace, { firstName, identityToken }) {
  fs.mkdirSync(workspace, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  fs.writeFileSync(path.join(workspace, 'IDENTITY.md'), 'Olma — personal assistant. Warm, brief, practical.\n');
  fs.writeFileSync(path.join(workspace, 'USER.md'), `# User\n\nFirst name: ${firstName || 'unknown'}\n`);
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Long-term memory\n\n(Nothing yet.)\n');
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'openclaw-workspace-state.json'),
    JSON.stringify({ version: 1, bootstrapSeededAt: now, setupCompletedAt: now }, null, 2),
    { mode: 0o600 }
  );
  // The root of trust. tools.fs.workspaceOnly makes it unforgeable — an
  // agent can only ever read its own.
  fs.writeFileSync(path.join(workspace, '.olma-identity'), identityToken + '\n', { mode: 0o600 });
  for (const stock of ['BOOTSTRAP.md', 'TOOLS.md']) {
    const p = path.join(workspace, stock);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// Activates a user end-to-end. If a 'pending' row for this phone exists
// (created at invite/waitlist time), it is upgraded in place. Returns the
// user row; the caller schedules the restart + welcome.
async function provisionUser(client, { phone, firstName, invitedByConnectionId, configPath, timezone, locale }) {
  let user = await usersDomain.getByPhone(client, phone);
  if (user && user.status === 'active' && user.agent_id) {
    return err('conflict', 'already provisioned', { userId: user.id });
  }
  if (!user) {
    const created = await usersDomain.createUser(client, { phone, firstName, invitedByConnectionId, timezone, locale });
    if (!created.ok) return created;
    user = created.data.user;
  }

  const agentId = `u-${user.id}`;
  const paths = defaultPaths(agentId);
  const { rows } = await client.query(
    `UPDATE users SET status = 'active', agent_id = $2, workspace_path = $3,
            first_name = COALESCE(first_name, $4)
     WHERE id = $1 RETURNING *`,
    [user.id, agentId, paths.workspace, firstName || null]
  );
  user = rows[0];

  seedWorkspace(paths.workspace, { firstName: user.first_name, identityToken: user.identity_token });
  fs.mkdirSync(paths.agentDir, { recursive: true });

  // ONE config write carrying agent + binding together. That pairing is what
  // makes the binding live without a gateway restart: a bindings-only write
  // hits the gateway's noop early-exit and is silently dropped. See
  // openclaw-config.js for the source references.
  const cfg = occ.loadConfig(configPath);
  const agentAdded = occ.addAgent(cfg, { id: agentId, workspace: paths.workspace, agentDir: paths.agentDir });
  occ.addAllowFrom(cfg, phone);
  const bindingAdded = occ.addBinding(cfg, { agentId, phone });
  occ.saveConfig(cfg, configPath);

  // Narrow but nasty: an agent entry left over from an earlier partial
  // provisioning means agents.list does NOT change, so this write is
  // effectively bindings-only and the person would sit on the intake agent
  // forever with no error anywhere. Rare enough to solve with the blunt
  // instrument rather than reintroduce scheduling machinery for.
  let restarted = false;
  if (bindingAdded && !agentAdded) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('systemctl', ['--user', 'restart', 'openclaw-gateway'],
      { env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/0' } });
    restarted = r.status === 0;
    console.warn(`[provision] ${agentId}: binding written without an agents.list change; ` +
      `forced gateway restart ${restarted ? 'ok' : 'FAILED'}`);
  }

  await audit.record(client, user.id, 'user.provisioned.workspace', { agentId, agentAdded, bindingAdded, restarted });
  return ok({ user, agentId, workspace: paths.workspace });
}

module.exports = { provisionUser, seedWorkspace, defaultPaths, TEMPLATE_PATH };
