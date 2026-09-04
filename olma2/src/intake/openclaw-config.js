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

// ---- group mode (olma2/docs/group-mode.md) ---------------------------------
// Three levers, each verified against the running gateway on 2026-09-04
// rather than against the docs, because two of the three do not behave the
// way the docs read:
//
// 1. ADMISSION — `channels.whatsapp.groups` is a MAP keyed by group JID, and
//    it is an allowlist the moment it is non-empty: adding the first entry
//    blocks every group that is not in it. Hot-applies, but a channels change
//    RESTARTS the whatsapp channel (~9s of no inbound, measured), so this is
//    a per-group registration lever, never a per-message one.
//
// 2. ROUTING — a normal binding with `peer.kind: 'group'`.
//
// 3. THE MUTE — `session.sendPolicy`, at the TOP LEVEL of the config and not
//    under `agents.defaults.session` where the config-agents doc's example
//    puts it (`resolveSendPolicy` reads `params.cfg.session?.sendPolicy`).
//    `deny` sets `suppressDelivery` unconditionally, so the turn still runs
//    and still writes its transcript — which is exactly what a locked group
//    needs: she sees the roster, and cannot speak.
//
// The trap under 3, and the reason `muteGroup` never travels alone: a
// sendPolicy-ONLY write is evaluated and DROPPED — the gateway logged
// "config change detected; evaluating reload (session.sendPolicy)" and then
// nothing, the same noop-plan early-exit that swallows a bindings-only write
// (see the header of this file). Bundled with an `agents.entries` change it
// applied in ~4s. Every lock/unlock therefore rides along with an agent or
// binding write in ONE saveConfig, exactly like provisioning.
//
// A second trap, probed before building on it: the mere PRESENCE of
// `session.sendPolicy` makes `resolveSendPolicy` deny any session key whose
// peer shape it finds ambiguous. Every one of the 46 live session keys on the
// box, plus every other key shape this gateway mints (main, cron, heartbeat,
// explicit model-run, webchat, newsletter), was run through the gateway's own
// resolver with and without a group rule: one key changed, the group's own.

// The prefix a group's sessions share, in the STRIPPED form the resolver also
// matches (`session.groupScope: "per-group"` → agent:<id>:whatsapp:group:<jid>).
// Keying on the group rather than on the agent means a group that is later
// re-provisioned under a different agent id stays muted.
function groupSessionPrefix(jid) {
  return `whatsapp:group:${String(jid).toLowerCase()}`;
}

function sendPolicyRules(cfg) {
  cfg.session = cfg.session || {};
  cfg.session.sendPolicy = cfg.session.sendPolicy || { rules: [], default: 'allow' };
  cfg.session.sendPolicy.rules = cfg.session.sendPolicy.rules || [];
  // `default` decides every session no rule matched — an absent or misspelt
  // value resolving to anything but 'allow' would mute the entire system.
  cfg.session.sendPolicy.default = 'allow';
  return cfg.session.sendPolicy.rules;
}

function isGroupMuted(cfg, jid) {
  const prefix = groupSessionPrefix(jid);
  const rules = (cfg.session && cfg.session.sendPolicy && cfg.session.sendPolicy.rules) || [];
  return rules.some((r) => r && r.action === 'deny' && r.match && r.match.keyPrefix === prefix);
}

// MUST be written in the same saveConfig as an agent/binding change (see above).
function muteGroup(cfg, jid) {
  if (isGroupMuted(cfg, jid)) return false;
  sendPolicyRules(cfg).push({
    action: 'deny',
    match: { keyPrefix: groupSessionPrefix(jid) },
  });
  return true;
}

function unmuteGroup(cfg, jid) {
  if (!cfg.session || !cfg.session.sendPolicy || !Array.isArray(cfg.session.sendPolicy.rules)) return false;
  const prefix = groupSessionPrefix(jid);
  const before = cfg.session.sendPolicy.rules.length;
  cfg.session.sendPolicy.rules = cfg.session.sendPolicy.rules.filter(
    (r) => !(r && r.action === 'deny' && r.match && r.match.keyPrefix === prefix)
  );
  return cfg.session.sendPolicy.rules.length !== before;
}

// Admission. `requireMention` is the product rule — only a real @-mention or a
// reply wakes her — and it is set per group rather than through
// `messages.groupChat.mentionPatterns`, which would ALSO make her name in free
// text a trigger. The owner asked for a real tag only, so no patterns are ever
// written.
function admitGroup(cfg, jid) {
  cfg.channels = cfg.channels || {};
  cfg.channels.whatsapp = cfg.channels.whatsapp || {};
  cfg.channels.whatsapp.groups = cfg.channels.whatsapp.groups || {};
  if (Object.hasOwn(cfg.channels.whatsapp.groups, jid)) return false;
  cfg.channels.whatsapp.groups[jid] = { requireMention: true };
  return true;
}

function unadmitGroup(cfg, jid) {
  const groups = cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groups;
  if (!groups || !Object.hasOwn(groups, jid)) return false;
  delete groups[jid];
  return true;
}

function isGroupAdmitted(cfg, jid) {
  const groups = (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groups) || {};
  return Object.hasOwn(groups, jid);
}

function addGroupBinding(cfg, { agentId, jid, comment }) {
  cfg.bindings = cfg.bindings || [];
  if (cfg.bindings.some((b) => b.match && b.match.peer && b.match.peer.kind === 'group' && b.match.peer.id === jid)) {
    return false;
  }
  cfg.bindings.push({
    type: 'route', agentId, comment: comment || `Olma group (${jid})`,
    match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: jid } },
  });
  return true;
}

function removeGroupBinding(cfg, jid) {
  if (!Array.isArray(cfg.bindings)) return false;
  const before = cfg.bindings.length;
  cfg.bindings = cfg.bindings.filter(
    (b) => !(b.match && b.match.peer && b.match.peer.kind === 'group' && b.match.peer.id === jid)
  );
  return cfg.bindings.length !== before;
}

module.exports = {
  DEFAULT_PATH, loadConfig, saveConfig,
  addAgent, removeAgent, addBinding, addCatchAllBinding, addAllowFrom,
  groupSessionPrefix, muteGroup, unmuteGroup, isGroupMuted,
  admitGroup, unadmitGroup, isGroupAdmitted, addGroupBinding, removeGroupBinding,
  usesEntries, listAgentIds, hasAgent,
};
