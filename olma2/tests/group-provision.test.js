'use strict';
// Provisioning a group, and the greeter that makes an unknown group visible.
//
// The claim these tests exist to defend is the product's whole promise: a
// group nobody has vetted, and a group that is still waiting for somebody to
// sign up, CANNOT be spoken in. Here that is structural rather than a policy
// bolted on top — a locked group has no agent of its own, so it falls to the
// greeter's wildcard binding, and the greeter is muted for ever.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const occ = require('../src/intake/openclaw-config');
const groups = require('../src/domain/groups');
const pg = require('../src/intake/provision-group');

let db, tmp, configPath;

// Every filesystem write in this file goes under one mkdtemp: test files are
// separate processes over one filesystem, and a fixture dropped into a shared
// directory has taken the whole suite down before.
before(async () => {
  db = await freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-group-provision-'));
  process.env.OLMA_OPENCLAW_HOME = tmp;
  configPath = path.join(tmp, 'openclaw.json');
});
after(async () => {
  delete process.env.OLMA_OPENCLAW_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.teardown();
});

function writeConfig() {
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { entries: { main: { name: 'main' } } },
    channels: { whatsapp: { accounts: { default: { dmPolicy: 'open', allowFrom: ['*'] } } } },
    session: { dmScope: 'per-channel-peer' },
    bindings: [],
  }, null, 2));
}

async function connectedUser(phone) {
  const u = await makeUser(db.pool, phone);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  return u;
}

async function registerGroup(jid, phones) {
  const res = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: jid, subject: 'פאדל שלישי', members: phones.map((phone) => ({ phone })),
  }));
  assert.equal(res.ok, true, res.ok ? '' : res.error.message);
  return res.data.group;
}

test('the greeter installs muted, owning every group with no agent of its own', () => {
  writeConfig();
  const changed = pg.installGreeter({ configPath });
  assert.deepEqual(changed, { agent: true, binding: true, mute: true, wildcard: true });

  const cfg = occ.loadConfig(configPath);
  assert.ok(occ.hasAgent(cfg, pg.GREETER_AGENT_ID));
  assert.equal(occ.isAgentMuted(cfg, pg.GREETER_AGENT_ID), true);
  const wildcard = cfg.bindings.find((b) => b.match.peer.kind === 'group' && b.match.peer.id === '*');
  assert.equal(wildcard.agentId, pg.GREETER_AGENT_ID);
  // The "*" entry is what lets a group we have never seen wake her at all.
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.groups['*'], { requireMention: false });

  // Safe to run on every brokerd start.
  assert.deepEqual(pg.installGreeter({ configPath }),
    { agent: false, binding: false, mute: false, wildcard: false });
});

test('a locked group gets no agent — that IS the lock', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000001');
  const group = await registerGroup('120363000000000001@g.us', [a.phone, '+972602000002']);

  const res = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'conflict');

  const cfg = occ.loadConfig(configPath);
  assert.equal(cfg.bindings.filter((b) => b.match.peer.id === group.external_id).length, 0,
    'with no binding of its own the group falls to the muted greeter');
});

test('registration admits the group tag-only, outranking the greeter wildcard', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const jid = '120363000000000002@g.us';
  assert.deepEqual(pg.admitRegisteredGroup({ configPath, jid }),
    { changed: true, admitted: true, muted: true });

  const cfg = occ.loadConfig(configPath);
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.groups[jid], { requireMention: true });
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.groups['*'], { requireMention: false });
  // The belt goes on at registration, so there is never a window where a group
  // without an agent is also without a deny rule.
  assert.equal(occ.isGroupMuted(cfg, jid), true);
  assert.deepEqual(pg.admitRegisteredGroup({ configPath, jid }), { changed: false });

});

test('opening a group gives it an agent, a route and a workspace, in one write', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000010');
  const b = await connectedUser('+972602000011');
  const group = await registerGroup('120363000000000003@g.us', [a.phone, b.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));

  const saved = [];
  const origSave = occ.saveConfig;
  occ.saveConfig = (c, p) => { saved.push(JSON.parse(JSON.stringify(c))); return origSave(c, p); };
  let res;
  try {
    res = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  } finally { occ.saveConfig = origSave; }

  assert.equal(res.ok, true);
  assert.equal(res.data.agentId, `g-${group.id}`);
  assert.equal(saved.length, 1, 'agent and binding must land in ONE write or the binding is dropped');
  const written = saved[0];
  assert.ok(occ.hasAgent(written, `g-${group.id}`), 'the agent change is the write\'s hot reason');
  assert.ok(written.bindings.some((b) => b.match.peer.id === group.external_id));

  // The workspace is the group's own world: its card, its memory, its token.
  const ws = res.data.group.workspace_path;
  assert.match(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /olma_grp_/);
  assert.equal(fs.readFileSync(path.join(ws, '.olma-identity'), 'utf8').trim(),
    res.data.group.identity_token);
  const card = fs.readFileSync(path.join(ws, 'GROUP.md'), 'utf8');
  assert.match(card, /פאדל שלישי/);
  assert.match(card, /פתוחה/);
});

// A group token that resolved to a person would hand a room one member's life.
test('a group token is its own kind, never a user token', async () => {
  const token = pg.newGroupToken();
  assert.match(token, /^olma_grp_[0-9a-f]{32}$/);
  const found = await db.pool.query(`SELECT id FROM users WHERE identity_token = $1`, [token]);
  assert.equal(found.rows.length, 0);
});

test('provisioning twice is idempotent', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000020');
  const group = await registerGroup('120363000000000004@g.us', [a.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));

  const first = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  const again = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  assert.equal(first.data.created, true);
  assert.equal(again.data.created, false);
  assert.equal(again.data.agentId, first.data.agentId);
  const cfg = occ.loadConfig(configPath);
  assert.equal(cfg.bindings.filter((b) => b.match.peer.id === group.external_id).length, 1);
});

test('re-locking takes the agent and the route away, and keeps the memory', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000030');
  const group = await registerGroup('120363000000000005@g.us', [a.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));
  const provisioned = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  const ws = provisioned.data.group.workspace_path;
  fs.writeFileSync(path.join(ws, 'MEMORY.md'), '# דפוסים\n\nמשחקים בשלישי.\n');

  const locked = await withTx(db.pool, (c) => pg.lockGroup(c, { groupId: group.id, configPath }));
  assert.equal(locked.data.changed, true);
  assert.equal(locked.data.group.agent_id, null);

  const cfg = occ.loadConfig(configPath);
  assert.equal(occ.hasAgent(cfg, `g-${group.id}`), false, 'no agent is what makes it silent');
  assert.equal(cfg.bindings.filter((b) => b.match.peer.id === group.external_id).length, 0);
  assert.equal(occ.isGroupMuted(cfg, group.external_id), true, 'and the belt goes back on');
  // Still admitted: she must keep SEEING the group, she just cannot speak in it.
  assert.deepEqual(cfg.channels.whatsapp.accounts.default.groups[group.external_id], { requireMention: true });

  assert.match(fs.readFileSync(path.join(ws, 'MEMORY.md'), 'utf8'), /משחקים בשלישי/,
    'a group that re-opens must not have forgotten itself');
  assert.equal(locked.data.group.opened_announced_at, null,
    'a re-lock re-arms the announcement, so a re-open is heard again');
});

// The sweep refreshes the card every ten seconds; a card that has not changed
// must not be a disk write every ten seconds.
test('the group card is written only when it changes', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000070');
  const group = await registerGroup('120363000000000009@g.us', [a.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));
  const res = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  const ws = res.data.group.workspace_path;
  const members = await withTx(db.pool, (c) => groups.listMembers(c, group.id));

  assert.equal(pg.refreshGroupCard(ws, { subject: 'פאדל שלישי', members, state: 'open' }), false,
    'seeded moments ago with exactly this content');
  assert.equal(pg.refreshGroupCard(ws, { subject: 'פאדל רביעי', members, state: 'open' }), true);
  assert.equal(pg.refreshGroupCard(ws, { subject: 'פאדל רביעי', members, state: 'open' }), false);
});

test('a rolled-back provisioning leaves nothing that can speak', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000040');
  const group = await registerGroup('120363000000000006@g.us', [a.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));

  pg.admitRegisteredGroup({ configPath, jid: group.external_id });
  const undos = [];
  await withTx(db.pool, (c) => pg.provisionGroup(c, {
    groupId: group.id, configPath, registerUndo: (fn) => undos.push(fn),
  }));
  assert.equal(undos.length, 1);
  undos[0]();

  const cfg = occ.loadConfig(configPath);
  assert.equal(occ.hasAgent(cfg, `g-${group.id}`), false);
  assert.equal(cfg.bindings.filter((b) => b.match.peer.id === group.external_id).length, 0);
  assert.equal(occ.isGroupMuted(cfg, group.external_id), true,
    'the undo puts the belt back — a group that never opened must not be able to speak');
});

test('the group card is rewritten when the roster changes', async () => {
  writeConfig();
  pg.installGreeter({ configPath });
  const a = await connectedUser('+972602000050');
  const group = await registerGroup('120363000000000007@g.us', [a.phone]);
  await withTx(db.pool, (c) => groups.applyState(c, group.id, 'open'));
  const res = await withTx(db.pool, (c) => pg.provisionGroup(c, { groupId: group.id, configPath }));
  const ws = res.data.group.workspace_path;

  await withTx(db.pool, (c) => groups.syncRoster(c, group.id, [
    { phone: a.phone, displayName: 'מירון' }, { phone: '+972602000051', displayName: 'גלי' },
  ]));
  const members = await withTx(db.pool, (c) => groups.listMembers(c, group.id));
  pg.refreshGroupCard(ws, { subject: 'פאדל שלישי', members, state: 'locked' });

  const card = fs.readFileSync(path.join(ws, 'GROUP.md'), 'utf8');
  assert.match(card, /גלי/);
  assert.match(card, /נעולה/);
});

// The card is what the model reads every turn. A field for someone's private
// life here is how the separation gets lost quietly.
test('the group card carries names and state, never anyone\'s private facts', () => {
  const card = pg.renderGroupMd({
    subject: 'פאדל', state: 'open',
    members: [{ display_name: 'מירון', phone: '+972602000060', last_inbound_at: new Date() }],
  });
  assert.match(card, /מירון/);
  assert.ok(!card.includes('+972602000060'), 'a name is enough; the number is not the card\'s business');
});
