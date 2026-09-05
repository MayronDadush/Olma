'use strict';
// Provisioning for a group, and for the greeter that makes a group visible in
// the first place. Design and the measurements behind it:
// olma2/docs/group-mode.md.
//
// Two things get provisioned here, and they are not symmetrical:
//
//   installGreeter()   ONCE for the whole system. `ggreet` owns every group we
//                      have never seen, is muted at the gateway for ever, and
//                      exists only so that a first message in an unknown group
//                      becomes a turn whose transcript names the group and its
//                      roster. Nothing it could ever say reaches anybody.
//
//   provisionGroup()   per group, and ONLY once it is open: its own agent, its
//                      own workspace, its own binding — which outranks the
//                      greeter's wildcard.
//
// **A locked group has no agent of its own.** That is the lock: with no exact
// binding it falls to the greeter's wildcard, and the greeter cannot speak. It
// is a structural mute rather than a policy one, and it is what makes every
// lock and unlock a change to `agents.entries` — the one key measured to give
// the gateway's reload planner a hot reason. A write it finds "noop" is
// dropped in silence, and both bindings alone and sendPolicy alone are.
// Measured on the live gateway 2026-09-04/05; see openclaw-config.js.
//
// The per-group deny rule is kept as a second belt for the window where a
// group has an agent and has just re-locked, and it now always rides along
// with the agent write that caused it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const occ = require('./openclaw-config');
const audit = require('../domain/audit');
const groupsDomain = require('../domain/groups');
const { ok, err } = require('../domain/results');

const TEMPLATE_PATH = path.join(__dirname, 'agents-group-template.md');
const GREETER_AGENT_ID = 'ggreet';

function base() {
  return process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
}

function defaultPaths(agentId) {
  return {
    workspace: `${base()}/workspaces/${agentId}`,
    agentDir: `${base()}/agents/${agentId}/agent`,
  };
}

// Same shape as a user's token and deliberately the same length, but it lives
// in chat_groups: a group token must never resolve to a person.
function newGroupToken() {
  return 'olma_grp_' + crypto.randomBytes(16).toString('hex');
}

function renderAgentsMd(identityToken) {
  const rendered = fs.readFileSync(TEMPLATE_PATH, 'utf8').replaceAll('{{IDENTITY_TOKEN}}', identityToken);
  if (rendered.includes('{{')) throw new Error('agents-group-template.md has an unfilled placeholder');
  if (!rendered.includes(identityToken)) throw new Error('agents-group-template.md lost its {{IDENTITY_TOKEN}} slot');
  return rendered;
}

// GROUP.md is to a group what USER.md is to a person: the small card injected
// every turn. It holds the group, never its members' private lives — the
// roster is names and nothing else, and there is deliberately no field here
// for anything a member told their own Olma.
function renderGroupMd({ subject, members, state }) {
  const names = (members || [])
    .map((m) => m.display_name || m.phone)
    .filter(Boolean);
  return [
    `# ${subject || 'קבוצה'}`,
    '',
    `מצב: ${state === 'open' ? 'פתוחה — כולם מחוברים' : 'נעולה — עוד לא כולם מחוברים'}`,
    `אנשים בקבוצה (${names.length}): ${names.join(', ') || '—'}`,
    '',
    '(מה שאני יודעת על הקבוצה הזאת נמצא כאן ובזיכרון שלי. על אנשים בפרטי — לא.)',
    '',
  ].join('\n');
}

// The gateway ships its own onboarding kit and it hijacks the first
// conversation if it runs (the v1 BOOTSTRAP.md lesson). Pre-stamping
// setupCompletedAt is what stops it, exactly as user provisioning does.
function seedWorkspace(workspace, { subject, identityToken, members, state }) {
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), renderAgentsMd(identityToken), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'IDENTITY.md'), 'עולמה — עוזרת של הקבוצה הזאת. חמה, קצרה, מעשית.\n');
  fs.writeFileSync(path.join(workspace, 'GROUP.md'), renderGroupMd({ subject, members, state }));
  const memoryPath = path.join(workspace, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, '# דפוסים של הקבוצה\n\n(עוד כלום.)\n');
  }
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.olma-identity'), identityToken + '\n', { mode: 0o600 });
}

// GROUP.md is rewritten on every roster change, so a group that gained or lost
// somebody does not spend a week describing a room that no longer exists.
function refreshGroupCard(workspace, { subject, members, state }) {
  if (!workspace || !fs.existsSync(workspace)) return false;
  fs.writeFileSync(path.join(workspace, 'GROUP.md'), renderGroupMd({ subject, members, state }));
  return true;
}

// ---- the greeter ------------------------------------------------------------

// Idempotent, and safe to call on every brokerd start: each piece is added
// only if missing, and the whole thing is one write. Returns what it changed
// so a caller can log a real install rather than a no-op.
//
// The wildcard `groups["*"] = { requireMention: false }` is what lets an
// unknown group wake her at all — an exact JID entry outranks it
// (`resolveChannelGroupRequireMention`), so a registered group is tag-only
// without disturbing this.
function installGreeter({ configPath, paths = defaultPaths(GREETER_AGENT_ID) } = {}) {
  fs.mkdirSync(paths.workspace, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  // A workspace the gateway can read but that says nothing: this agent is
  // muted, and anything it writes goes nowhere.
  const readme = path.join(paths.workspace, 'AGENTS.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '# ggreet',
      '',
      'סוכן זמני לקבוצות שעוד לא נרשמו. מה שנאמר כאן לא מגיע לאף אחד —',
      'הסוכן הזה מושתק ברמת הגייטוויי. אל תעני, אל תעשי כלום.',
      '',
    ].join('\n'), { mode: 0o600 });
  }

  const cfg = occ.loadConfig(configPath);
  const changed = {
    agent: occ.addAgent(cfg, { id: GREETER_AGENT_ID, workspace: paths.workspace, agentDir: paths.agentDir }),
    binding: occ.addGroupWildcardBinding(cfg, { agentId: GREETER_AGENT_ID }),
    mute: occ.muteAgent(cfg, GREETER_AGENT_ID),
    wildcard: occ.admitAllGroups(cfg),
  };
  if (Object.values(changed).some(Boolean)) occ.saveConfig(cfg, configPath);
  return changed;
}

// ---- one group --------------------------------------------------------------

function undoSideEffects({ agentId, jid, configPath, paths, removeWorkspace, added }) {
  const undone = {};
  try {
    if (removeWorkspace && fs.existsSync(paths.workspace)) {
      fs.rmSync(paths.workspace, { recursive: true, force: true });
      undone.workspace = true;
    }
    if (fs.existsSync(paths.agentDir)) {
      fs.rmSync(paths.agentDir, { recursive: true, force: true });
      undone.agentDir = true;
    }
  } catch (e) {
    console.error(`[provision-group] undo ${agentId}: workspace cleanup failed: ${e.message}`);
  }
  if (added.agent || added.binding || added.admitted || added.unmuted) {
    try {
      const cfg = occ.loadConfig(configPath);
      if (added.agent) undone.agent = occ.removeAgent(cfg, agentId);
      if (added.binding) undone.binding = occ.removeGroupBinding(cfg, jid);
      if (added.admitted) undone.admitted = occ.unadmitGroup(cfg, jid);
      // Opening the group took the belt off; an undo puts it back on. Leaving
      // a rolled-back group unmuted would be the one failure that matters here
      // — a group that never opened, able to speak.
      if (added.unmuted) undone.muted = occ.muteGroup(cfg, jid);
      occ.saveConfig(cfg, configPath);
    } catch (e) {
      console.error(`[provision-group] undo ${agentId}: config cleanup failed: ${e.message}`);
    }
  }
  console.warn(`[provision-group] undid side effects for ${agentId}: ${JSON.stringify(undone)}`);
  return undone;
}

// Gives a registered group its own agent, workspace, route and — while it is
// locked — its own mute. Idempotent: a group that already has an agent comes
// back unchanged rather than being rebuilt.
async function provisionGroup(client, { groupId, configPath, registerUndo }) {
  const group = await groupsDomain.getById(client, groupId);
  if (!group) return err('not_found', 'no such group');
  if (group.state === 'retired') return err('conflict', 'group is retired');
  if (group.state !== 'open') return err('conflict', 'a group gets its own agent only once it is open');
  if (group.agent_id) return ok({ group, agentId: group.agent_id, created: false });

  const agentId = `g-${group.id}`;
  const paths = defaultPaths(agentId);
  const identityToken = group.identity_token || newGroupToken();
  const members = await groupsDomain.listMembers(client, group.id);

  const { rows } = await client.query(
    `UPDATE chat_groups
        SET agent_id = $2, workspace_path = $3, identity_token = COALESCE(identity_token, $4)
      WHERE id = $1 RETURNING *`,
    [group.id, agentId, paths.workspace, identityToken]
  );
  const updated = rows[0];

  // Below this line nothing is inside the transaction's reach: files on disk
  // and a gateway config no ROLLBACK can undo. Each step records whether it
  // actually created something, so an undo puts back exactly what was added
  // and never more.
  const workspaceExisted = fs.existsSync(paths.workspace);
  seedWorkspace(paths.workspace, {
    subject: updated.subject, identityToken: updated.identity_token, members, state: updated.state,
  });
  fs.mkdirSync(paths.agentDir, { recursive: true });

  const cfg = occ.loadConfig(configPath);
  const added = {
    agent: occ.addAgent(cfg, { id: agentId, workspace: paths.workspace, agentDir: paths.agentDir }),
    binding: occ.addGroupBinding(cfg, { agentId, jid: updated.external_id }),
    // Tag-only from here: the exact entry outranks the greeter's wildcard.
    admitted: occ.admitGroup(cfg, updated.external_id),
    // Giving a group an agent IS the unlock, so the belt comes off in the
    // same write — and the agent entry above is the hot reason that makes a
    // sendPolicy change land at all.
    unmuted: occ.unmuteGroup(cfg, updated.external_id),
  };
  occ.saveConfig(cfg, configPath);

  if (typeof registerUndo === 'function') {
    registerUndo(() => undoSideEffects({
      agentId, jid: updated.external_id, configPath, paths,
      removeWorkspace: !workspaceExisted, added,
    }));
  }

  await audit.record(client, updated.registered_by_user_id, 'group.provisioned', {
    groupId: updated.id, agentId, externalId: updated.external_id, ...added,
  });
  return ok({ group: updated, agentId, created: true, added });
}

// Registration: admit the group, tag-only. This one stands alone safely —
// a `channels.whatsapp.*.groups` write hot-applies by itself (measured
// 2026-09-05: "config hot reload applied (…groups)"), at the cost of a ~5s
// whatsapp channel restart. That cost is why it is a per-group registration
// lever and never a per-message one.
//
// The exact entry outranks the greeter's `"*"`, so from here on only a real
// tag wakes anything in this group.
// The belt goes on HERE, not when the group later locks: the invariant worth
// having is "a group without its own agent also carries a deny rule", so there
// is no window — not at registration, not after a rolled-back opening — where
// the only thing standing between a group and a stray reply is a binding that
// happens not to exist yet. The channels write is the hot reason that makes
// the sendPolicy rule beside it actually load.
function admitRegisteredGroup({ configPath, jid }) {
  const cfg = occ.loadConfig(configPath);
  const admitted = occ.admitGroup(cfg, jid);
  const muted = occ.muteGroup(cfg, jid);
  if (!admitted && !muted) return { changed: false };
  occ.saveConfig(cfg, configPath);
  return { changed: true, admitted, muted };
}

// Re-locking: take the group's agent and binding away again, so it falls back
// to the muted greeter, and re-assert the deny rule as a belt. Removing the
// agent is the hot reason that makes the whole write land.
//
// The workspace is deliberately NOT deleted: the group's memory, its patterns
// and its card outlive a lock, and a group that re-opens should not have
// forgotten itself because somebody joined for a day.
async function lockGroup(client, { groupId, configPath }) {
  const group = await groupsDomain.getById(client, groupId);
  if (!group) return err('not_found', 'no such group');
  if (!group.agent_id) return ok({ group, changed: false, reason: 'no agent to take away' });

  const cfg = occ.loadConfig(configPath);
  const removed = {
    agent: occ.removeAgent(cfg, group.agent_id),
    binding: occ.removeGroupBinding(cfg, group.external_id),
    muted: occ.muteGroup(cfg, group.external_id),
  };
  occ.saveConfig(cfg, configPath);

  const { rows } = await client.query(
    `UPDATE chat_groups SET agent_id = NULL WHERE id = $1 RETURNING *`, [group.id]);
  await audit.record(client, group.registered_by_user_id, 'group.locked', {
    groupId: group.id, agentId: group.agent_id, ...removed,
  });
  return ok({ group: rows[0], changed: true, removed });
}

module.exports = {
  GREETER_AGENT_ID, TEMPLATE_PATH,
  defaultPaths, newGroupToken, renderAgentsMd, renderGroupMd,
  seedWorkspace, refreshGroupCard,
  installGreeter, admitRegisteredGroup, provisionGroup, lockGroup, undoSideEffects,
};
