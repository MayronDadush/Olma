'use strict';
// Direct, atomic edits to openclaw.json — never `openclaw config set` (it can
// hang forever after a successful write; hard-learned v1 gotcha). Pure
// mutation functions over a parsed object + a load/save pair, so every edit
// is unit-testable against a temp file.
//
// Reload reality — the earlier probe drew the wrong conclusion from a real
// observation, and it cost every new user 2-4 minutes of waiting. Corrected
// 2026-08-16 from the gateway source plus live evidence (a user's second
// message routed to their brand-new agent with no restart in between):
//
//   server-reload-handlers:170  if (isNoopReloadPlan(plan) ...) return;
//   server-reload-handlers:607  params.setState(nextState);
//
// `setState` swaps in the WHOLE next config — bindings included. The only
// thing that skips it is the noop early-exit, and a plan is noop only when
// `hotReasons` is empty. So:
//
//   bindings changed ALONE      → noop plan → early return → NOT applied
//   bindings + agents.list      → hot plan  → setState → bindings ARE applied
//
// The probe changed bindings alone, saw nothing happen, and generalised.
// Provisioning never does that: addAgent + addBinding land in one saveConfig,
// so the binding is live within a second and no gateway restart is needed.
// Keep them in one write — splitting the save would silently resurrect the
// bug. The one-off catch-all binding (install-intake.js) IS a bindings-only
// change and does still need its single manual restart.
const fs = require('node:fs');

const DEFAULT_PATH = process.env.OLMA_OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';

function loadConfig(path = DEFAULT_PATH) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function saveConfig(cfg, path = DEFAULT_PATH) {
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path);
}

// agents.list — hot-reloads, safe to apply per-provision.
function addAgent(cfg, { id, workspace, agentDir }) {
  cfg.agents = cfg.agents || {};
  cfg.agents.list = cfg.agents.list || [];
  if (cfg.agents.list.some((a) => a.id === id)) return false;
  cfg.agents.list.push({ id, name: id, workspace, agentDir });
  return true;
}

// bindings — requires a gateway restart to take effect (see header).
function addBinding(cfg, { agentId, phone, comment }) {
  cfg.bindings = cfg.bindings || [];
  if (cfg.bindings.some((b) => b.match && b.match.peer && b.match.peer.id === phone && b.match.peer.kind === 'direct')) {
    return false;
  }
  cfg.bindings.push({
    type: 'route', agentId, comment: comment || `Olma user (${phone})`,
    match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'direct', id: phone } },
  });
  return true;
}

// The one-time catch-all: any direct peer with no exact binding lands on the
// intake agent. Exact peer bindings outrank wildcard-kind (verified in
// resolve-route source), so per-user bindings always win once active.
function addCatchAllBinding(cfg, { agentId }) {
  cfg.bindings = cfg.bindings || [];
  if (cfg.bindings.some((b) => b.match && b.match.peer && b.match.peer.id === '*')) return false;
  cfg.bindings.push({
    type: 'route', agentId, comment: 'Olma intake — catch-all for unknown direct peers',
    match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'direct', id: '*' } },
  });
  return true;
}

// allowFrom — hot-reloads; harmless under dmPolicy "open" but kept correct
// for any policy.
function addAllowFrom(cfg, phone) {
  const acc = cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.accounts
    && cfg.channels.whatsapp.accounts.default;
  if (!acc) return false;
  acc.allowFrom = acc.allowFrom || [];
  // Under the open-policy wildcard there is nothing to add — and skipping the
  // write matters: every allowFrom change makes the whatsapp channel restart
  // itself, a ~30s outage exactly when the new user's welcome wants to go out.
  if (acc.allowFrom.includes('*')) return false;
  if (acc.allowFrom.includes(phone)) return false;
  acc.allowFrom.push(phone);
  return true;
}

module.exports = {
  DEFAULT_PATH, loadConfig, saveConfig,
  addAgent, addBinding, addCatchAllBinding, addAllowFrom,
};
