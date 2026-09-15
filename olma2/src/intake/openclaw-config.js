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
const { assertNotProduction } = require('./production-guard');

// Read per call, never captured at module load: a test file sets
// OLMA_OPENCLAW_CONFIG at the top of tests/helpers.js, and whether that lands
// before or after this module is first required depends on which other module
// happened to pull it in. A constant made the isolation depend on require
// order, which is exactly the kind of thing that works until it doesn't.
// channels/sessions.js resolves its own home the same way, for the same reason.
function defaultPath() {
  return process.env.OLMA_OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';
}

function loadConfig(path = defaultPath()) {
  assertNotProduction('openclaw config', path);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// A write under `channels.whatsapp` RESTARTS the WhatsApp channel. That is
// documented at `provision-group.admitRegisteredGroup` as a cost worth paying
// once per group, and it was measured again on 2026-09-11: the config was
// written at 09:36:58, the reload applied at 09:37:12, the channel was
// listening again at 09:37:14. Sixteen seconds in which every send is refused.
//
// Nothing recorded that window, so the group sweep registered a room, wrote
// this file, and `group_outbox` said "נעים מאוד" into the restart the sweep
// had just caused. The gateway refused the send, kept the message in its own
// outbound retry queue, and delivered it a second later anyway; our sender
// read the refusal as a definite non-delivery and sent it again. Both groups
// registered that day were greeted twice (`incidents.md`, "The room was
// greeted twice, by its own registration").
//
// The stamp lives HERE because this is the one function every such write goes
// through, and it is taken against what is ON DISK rather than from what the
// caller believes it changed — a caller that thinks it changed nothing is
// exactly the caller that would forget to say so. It is in-process, which is
// honest for its one reader: brokerd makes these writes and brokerd is the
// only sender of the group queue.
let channelWriteAt = null;

// The subtree whose change restarts the channel. `undefined` and `{}` must not
// read as the same thing, so a missing key is its own string.
function whatsappFingerprint(cfg) {
  const ch = cfg && cfg.channels && cfg.channels.whatsapp;
  return ch === undefined ? 'absent' : JSON.stringify(ch);
}

// When the WhatsApp channel was last restarted BY US — null if never this
// process. A reader wanting "is it restarting right now" adds its own grace;
// this says only when the write happened.
function channelWrittenAt() {
  return channelWriteAt;
}

function saveConfig(cfg, path = defaultPath()) {
  assertNotProduction('openclaw config', path);
  // Three answers, not two. A file that is not there yet is a config nothing
  // can be running against, so writing it restarts nothing; a file that is
  // there and cannot be read is NOT evidence that its channels block matched
  // the one we are about to write, and a needless 45-second hold is a far
  // cheaper mistake than a room told the same sentence twice.
  let before;
  try {
    before = whatsappFingerprint(JSON.parse(fs.readFileSync(path, 'utf8')));
  } catch (e) {
    before = e && e.code === 'ENOENT' ? null : undefined;
  }
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path);
  if (before === undefined || (before !== null && before !== whatsappFingerprint(cfg))) {
    channelWriteAt = Date.now();
  }
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
// 1. ADMISSION — the groups MAP, keyed by group JID (written under
//    `channels.whatsapp.accounts.default` — see admitGroup for why), and
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
//
// WHERE the map is written is load-bearing, and it is not where this code
// first put it. The gateway's reload planner takes the FIRST rule whose prefix
// matches (`matchRule`, config-reload-plan.js), and the WhatsApp plugin
// declares (its manifest, shared-D3B14d45.js):
//
//   configPrefixes: ["channels.whatsapp.enabled",
//                    "channels.whatsapp.accounts",
//                    "channels.whatsapp.selfChatMode"]   -> hot, restart-channel
//   noopPrefixes:   ["channels.whatsapp"]                -> none
//
// So `channels.whatsapp.groups` matches only the noop rule and a write that
// touches nothing else is DROPPED IN SILENCE — the same early-exit that eats a
// bindings-only and a sendPolicy-only write. Under `accounts.default` the very
// same map is a hot reason that applies on its own. The gateway merges the
// channel-level map into the account anyway (`resolveChannelGroups` ->
// `resolveMergedAccountConfig`), so the readers below accept both and the
// writers only ever use the account.
function whatsappAccount(cfg, { create = false } = {}) {
  if (!create) {
    return (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.accounts
      && cfg.channels.whatsapp.accounts.default) || null;
  }
  cfg.channels = cfg.channels || {};
  cfg.channels.whatsapp = cfg.channels.whatsapp || {};
  cfg.channels.whatsapp.accounts = cfg.channels.whatsapp.accounts || {};
  cfg.channels.whatsapp.accounts.default = cfg.channels.whatsapp.accounts.default || {};
  return cfg.channels.whatsapp.accounts.default;
}

// Read the way the gateway reads: the account's own map wins, the channel-level
// one is inherited. A config written before the move still resolves.
function groupsMap(cfg) {
  const acc = whatsappAccount(cfg);
  const channelLevel = (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groups) || {};
  return { ...channelLevel, ...((acc && acc.groups) || {}) };
}

function admitGroup(cfg, jid) {
  if (Object.hasOwn(groupsMap(cfg), jid)) return false;
  const acc = whatsappAccount(cfg, { create: true });
  acc.groups = acc.groups || {};
  acc.groups[jid] = { requireMention: true };
  return true;
}

function unadmitGroup(cfg, jid) {
  let removed = false;
  for (const map of [whatsappAccount(cfg) && whatsappAccount(cfg).groups,
    cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groups]) {
    if (map && Object.hasOwn(map, jid)) { delete map[jid]; removed = true; }
  }
  return removed;
}

function isGroupAdmitted(cfg, jid) {
  return Object.hasOwn(groupsMap(cfg), jid);
}

// ---- who may speak to her in a group ---------------------------------------
//
// `groups` above decides which ROOMS she is in. This decides which PEOPLE in
// them can reach her at all, and without it the room admission is the only
// gate there is.
//
// The trap, measured against this gateway's own resolver on 2026-09-06
// (the WhatsApp plugin, monitor-CySzv38g.js, resolveWhatsAppInboundPolicy):
//
//   const groupAllowFrom = (account.groupAllowFrom?.length ? ... : undefined)
//     ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined) ?? [];
//
// The plugin resolves the fallback ITSELF before handing the list to the core
// resolver (which is why it then passes `groupAllowFromFallbackToAllowFrom:
// false` and why reading only the core looks reassuring). Ours is
// `allowFrom: ["*"]`, so with `groupAllowFrom` unset every sender in every
// group is admitted:
//
//   groupAllowFrom UNSET, a stranger writes   -> ALLOW  group_policy_allowed
//   groupAllowFrom = [] (empty), stranger     -> ALLOW  group_policy_allowed
//   groupAllowFrom = [user],     stranger     -> BLOCK  group_policy_not_allowlisted
//   groupAllowFrom = [user],     that user    -> ALLOW  group_policy_allowed
//
// **An empty array is not a closed door — it is the same wide-open door as no
// key at all.** So this never writes one: a caller with nothing to allow is
// told, and the config is left as it was. The only thing that means "nobody"
// is `groupPolicy: "disabled"`.
//
// Her own number must never appear here. Her outbound messages tag her (the
// intro carries a real self-mention), and an echo arriving past the gateway's
// own de-duplication window would otherwise be a sender she trusts — a loop
// with her at both ends. Keeping her out of the list is the second belt under
// that, and it costs nothing: measured, her own number is BLOCKed at ingress.
const SELF_PHONE = normalizePhone(process.env.OLMA_WA_NUMBER || '+972559347282');

function normalizePhone(value) {
  const digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  return digits ? `+${digits}` : '';
}

function groupAllowFrom(cfg) {
  const acc = whatsappAccount(cfg);
  return acc && Array.isArray(acc.groupAllowFrom) ? acc.groupAllowFrom.slice() : [];
}

// Declarative: the list becomes exactly these people. One rule covers a user
// joining, a user pausing and a user being deleted, instead of three mirrored
// call sites that drift apart.
function syncGroupAllowFrom(cfg, phones) {
  const wanted = [];
  for (const phone of phones || []) {
    const e164 = normalizePhone(phone);
    if (!e164 || e164 === SELF_PHONE) continue;
    if (!wanted.includes(e164)) wanted.push(e164);
  }
  wanted.sort();
  if (!wanted.length) return { changed: false, refusedEmpty: true, entries: groupAllowFrom(cfg) };

  const current = groupAllowFrom(cfg);
  const same = current.length === wanted.length && current.every((v, i) => v === wanted[i]);
  if (same) return { changed: false, refusedEmpty: false, entries: current };
  whatsappAccount(cfg, { create: true }).groupAllowFrom = wanted;
  return { changed: true, refusedEmpty: false, entries: wanted };
}

// "Can anybody at all reach her in a group right now?" — the question a config
// file cannot be read for, because the dangerous answer is spelled as an
// absent key. True means the sender gate admits everyone.
function isGroupSenderGateOpen(cfg) {
  const acc = whatsappAccount(cfg) || {};
  if ((acc.groupPolicy || (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groupPolicy)) === 'disabled') {
    return false;
  }
  const list = groupAllowFrom(cfg);
  const effective = list.length ? list : (Array.isArray(acc.allowFrom) ? acc.allowFrom : []);
  return effective.length === 0 || effective.some((v) => String(v).trim() === '*');
}

// The greeter's catch-all: every group with no exact binding of its own lands
// on one permanently muted agent. Exact peer bindings outrank a wildcard (the
// same precedence the direct catch-all relies on), so a group that has been
// given its own agent stops coming here the moment that binding is written.
function addGroupWildcardBinding(cfg, { agentId }) {
  cfg.bindings = cfg.bindings || [];
  if (cfg.bindings.some((b) => b.match && b.match.peer && b.match.peer.kind === 'group' && b.match.peer.id === '*')) {
    return false;
  }
  cfg.bindings.push({
    type: 'route', agentId, comment: 'Olma group greeter — every group without its own agent',
    match: { channel: 'whatsapp', accountId: 'default', peer: { kind: 'group', id: '*' } },
  });
  return true;
}

// Mutes a whole AGENT rather than one group — `rawKeyPrefix` matches the raw
// session key, which begins `agent:<id>:`. This is what makes the greeter safe:
// it runs turns for groups nobody has vetted yet, and nothing it says can ever
// reach anybody.
function muteAgent(cfg, agentId) {
  const prefix = `agent:${String(agentId).toLowerCase()}:`;
  const rules = sendPolicyRules(cfg);
  if (rules.some((r) => r && r.action === 'deny' && r.match && r.match.rawKeyPrefix === prefix)) return false;
  rules.push({ action: 'deny', match: { rawKeyPrefix: prefix } });
  return true;
}

function isAgentMuted(cfg, agentId) {
  const prefix = `agent:${String(agentId).toLowerCase()}:`;
  const rules = (cfg.session && cfg.session.sendPolicy && cfg.session.sendPolicy.rules) || [];
  return rules.some((r) => r && r.action === 'deny' && r.match && r.match.rawKeyPrefix === prefix);
}

// `groups["*"]` admits every group — including one we have never seen, which
// is the whole point: it is what lets a first message anywhere reach the
// greeter. `requireMention: false` here is the DEFAULT only; a registered
// group's own entry outranks it (verified in `resolveChannelGroupRequireMention`:
// exact entry, then "*", then true).
function admitAllGroups(cfg) {
  const current = groupsMap(cfg)['*'];
  if (current && current.requireMention === false) return false;
  const acc = whatsappAccount(cfg, { create: true });
  acc.groups = acc.groups || {};
  acc.groups['*'] = { ...(current || {}), requireMention: false };
  return true;
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
  defaultPath, loadConfig, saveConfig, channelWrittenAt,
  addAgent, removeAgent, addBinding, addCatchAllBinding, addAllowFrom,
  groupSessionPrefix, muteGroup, unmuteGroup, isGroupMuted,
  addGroupWildcardBinding, muteAgent, isAgentMuted, admitAllGroups,
  admitGroup, unadmitGroup, isGroupAdmitted, addGroupBinding, removeGroupBinding,
  groupAllowFrom, syncGroupAllowFrom, isGroupSenderGateOpen, SELF_PHONE,
  usesEntries, listAgentIds, hasAgent,
};

// A getter, not a value: `occ.DEFAULT_PATH` now answers with whatever the
// environment says at the moment it is READ. Six call sites reach for it, and
// the one that matters most — jobs/registry.js, which hands it to the intake
// sweep — is evaluated while brokerd is still loading its modules. As a plain
// constant that call site captured the production path before a test process
// had finished setting up its own, which is how the sweep came to write into
// the live roster from a throwaway database.
Object.defineProperty(module.exports, 'DEFAULT_PATH', { get: defaultPath, enumerable: true });
