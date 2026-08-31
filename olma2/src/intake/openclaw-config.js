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

// OpenClaw 2026.8.x moved the agent roster from the `agents.list` array to a
// keyed `agents.entries` object (same fields, the id becomes the key). The
// migration is one-way and UNFORGIVING: if a config carries BOTH, the gateway
// deletes `agents.list` wholesale ("Removed agents.list because canonical
// agents.entries is already set" — legacy-config-migrations.runtime.entries),
// so writing to the array on an entries-format config would silently throw
// the new agent away and leave their binding routing to nothing. Discovered
// live 2026-08-31 when the box was upgraded to 2026.8.1 under us. Every
// reader/writer below goes through these helpers so the format decision
// lives in exactly one place: entries when the config has entries, the
// legacy array otherwise.
function usesEntries(cfg) {
  return Boolean(cfg.agents && cfg.agents.entries && typeof cfg.agents.entries === 'object'
    && !Array.isArray(cfg.agents.entries));
}

function listAgentIds(cfg) {
  if (usesEntries(cfg)) return Object.keys(cfg.agents.entries);
  return ((cfg.agents && cfg.agents.list) || []).map((a) => a && a.id).filter(Boolean);
}

function hasAgent(cfg, id) {
  return listAgentIds(cfg).includes(id);
}

// Adding an agent hot-reloads in both formats, safe to apply per-provision.
function addAgent(cfg, { id, workspace, agentDir }) {
  cfg.agents = cfg.agents || {};
  if (hasAgent(cfg, id)) return false;
  if (usesEntries(cfg)) {
    cfg.agents.entries[id] = { name: id, workspace, agentDir };
    return true;
  }
  cfg.agents.list = cfg.agents.list || [];
  cfg.agents.list.push({ id, name: id, workspace, agentDir });
  return true;
}

// Remove an agent from whichever roster format the config uses. Returns
// whether anything was actually removed, so callers can keep their
// "did the config change" bookkeeping exact.
function removeAgent(cfg, id) {
  if (usesEntries(cfg)) {
    if (!Object.hasOwn(cfg.agents.entries, id)) return false;
    delete cfg.agents.entries[id];
    return true;
  }
  if (!cfg.agents || !Array.isArray(cfg.agents.list)) return false;
  const before = cfg.agents.list.length;
  cfg.agents.list = cfg.agents.list.filter((a) => a.id !== id);
  return cfg.agents.list.length !== before;
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
  addAgent, removeAgent, addBinding, addCatchAllBinding, addAllowFrom,
  usesEntries, listAgentIds, hasAgent,
};
