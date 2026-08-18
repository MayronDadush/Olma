'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const occ = require('../src/intake/openclaw-config');
const { provisionUser } = require('../src/intake/provision');
const intake = require('../src/jobs/intake');
const sessionIndex = require('../src/channels/sessions');
const invites = require('../src/intake/invites');
const guard = require('../src/jobs/config-guard');
const flags = require('../src/domain/flags');
const connections = require('../src/domain/connections');

let db, tmp, configPath;

function baseConfig() {
  return {
    agents: { list: [{ id: 'intake', workspace: '/x/intake', agentDir: '/x/intake-agent' }] },
    bindings: [],
    tools: { fs: { workspaceOnly: true }, alsoAllow: ['read', 'write'] },
    mcp: { servers: { olma: { command: 'node', args: ['shim.js'] } } },
    channels: { whatsapp: { accounts: { default: { allowFrom: [] } } } },
  };
}

before(async () => {
  db = await freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-intake-'));
  process.env.OLMA_OPENCLAW_HOME = tmp;
  configPath = path.join(tmp, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
});
after(async () => {
  delete process.env.OLMA_OPENCLAW_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.teardown();
});

test('provisionUser: workspace sealed, token file 0600, config updated, idempotent', async () => {
  const res = await withTx(db.pool, (c) => provisionUser(c, { phone: '+972601000001', firstName: 'Noa', configPath }));
  assert.equal(res.ok, true);
  const { user, workspace } = res.data;
  assert.equal(user.status, 'active');
  assert.match(user.agent_id, /^u-\d+$/);

  const idFile = path.join(workspace, '.olma-identity');
  assert.equal(fs.readFileSync(idFile, 'utf8').trim(), user.identity_token);
  assert.equal((fs.statSync(idFile).mode & 0o777), 0o600);
  const state = JSON.parse(fs.readFileSync(path.join(workspace, 'openclaw-workspace-state.json'), 'utf8'));
  assert.ok(state.setupCompletedAt, 'stock onboarding pre-neutralised');
  assert.match(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /turn_start/);

  const cfg = occ.loadConfig(configPath);
  assert.ok(cfg.agents.list.some((a) => a.id === user.agent_id));
  assert.ok(cfg.bindings.some((b) => b.match.peer.id === '+972601000001' && b.agentId === user.agent_id));
  assert.ok(cfg.channels.whatsapp.accounts.default.allowFrom.includes('+972601000001'));

  // The load-bearing invariant behind "no gateway restart": the agent and the
  // binding must reach openclaw.json in the SAME write. A bindings-only change
  // hits the gateway's noop early-exit and never becomes live; bundled with an
  // agents.list change it does. If someone ever splits this into two saves,
  // every new user silently goes back to waiting minutes for their welcome.
  const seen = [];
  const origSave = occ.saveConfig;
  occ.saveConfig = (c, p) => { seen.push(JSON.parse(JSON.stringify(c))); return origSave(c, p); };
  try {
    await withTx(db.pool, (c) => provisionUser(c, { phone: '+972601000099', configPath }));
  } finally { occ.saveConfig = origSave; }
  assert.equal(seen.length, 1, 'exactly one config write per provisioning');
  const written = seen[0];
  assert.ok(written.agents.list.some((a) => a.id.startsWith('u-')), 'that write carries the agent');
  assert.ok(written.bindings.some((b) => b.match.peer.id === '+972601000099'), 'and the binding');

  const again = await withTx(db.pool, (c) => provisionUser(c, { phone: '+972601000001', configPath }));
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'conflict');
});

test('provisionUser: with nothing extracted, USER.md carries no pending-note sections', async () => {
  const res = await withTx(db.pool, (c) => provisionUser(c, { phone: '+972601000097', configPath }));
  const userMd = fs.readFileSync(path.join(res.data.workspace, 'USER.md'), 'utf8');
  assert.ok(!/מה שכבר שיתפו/.test(userMd));
  assert.ok(!/הצטרפו דרך הזמנה/.test(userMd));
});

test('provisionUser: locale comes from what they actually wrote, not the dialling code', async () => {
  // An Israeli number whose owner opened in English gets English — the rule
  // is "the language of the first message", and the prefix is only a fallback.
  const en = await withTx(db.pool, (c) => provisionUser(c, {
    phone: '+972601000091', configPath, firstMessage: 'hi, can you help me organise my week?',
  }));
  assert.equal(en.data.user.locale, 'en');

  const he = await withTx(db.pool, (c) => provisionUser(c, {
    phone: '+972601000092', configPath, firstMessage: 'היי, אני צריך עזרה',
  }));
  assert.equal(he.data.user.locale, 'he');

  // Nothing readable in the message → fall back to the dialling code
  const guessed = await withTx(db.pool, (c) => provisionUser(c, {
    phone: '+33601000093', configPath, firstMessage: '👍',
  }));
  assert.equal(guessed.data.user.locale, 'fr');

  // ...and the audit records HOW we decided, so a guess is distinguishable
  const { rows } = await db.pool.query(
    `SELECT a.detail FROM audit_log a JOIN users u ON u.id = a.actor_id
     WHERE u.phone = '+33601000093' AND a.event = 'user.provisioned.workspace'`);
  assert.equal(rows[0].detail.localeSource, 'phone_prefix');
});

test('provisionUser: firstMessage and invitedInfo both land in USER.md, wrapped as data', async () => {
  const res = await withTx(db.pool, (c) => provisionUser(c, {
    phone: '+972601000098', configPath,
    firstMessage: 'יש לי משימה — ללכת לעבודה מחר',
    invitedInfo: { connectionId: 42, inviterName: 'Dana', reason: 'לתאם ארוחה' },
  }));
  const userMd = fs.readFileSync(path.join(res.data.workspace, 'USER.md'), 'utf8');
  assert.match(userMd, /מה שכבר שיתפו לפני שהמערכת האישית הייתה מוכנה/);
  assert.match(userMd, /<<<יש לי משימה — ללכת לעבודה מחר>>>/, 'wrapped as untrusted data, not a bare instruction');
  assert.match(userMd, /הצטרפו דרך הזמנה/);
  assert.match(userMd, /Dana/);
  assert.match(userMd, /לתאם ארוחה/);
  assert.match(userMd, /connection_id=42/);
});

test('intake sweep: open registration provisions immediately — no separate welcome message', async () => {
  const out = await withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath,
    listSessions: async () => [{ phone: '+972601000002', key: 'agent:intake:whatsapp:direct:+972601000002' }],
    readFirstMessage: async () => 'היי מה זה הדבר הזה?',
  }));
  assert.deepEqual(out.provisioned, ['+972601000002']);

  // No outbox row at all — the 2026-08-17 redesign retired the dedicated
  // 'welcome' kind. The conversation the person already had with the
  // (now-talkative) greeter just continues in their own agent.
  const { rows: outboxRows } = await db.pool.query(
    `SELECT o.* FROM outbox o JOIN users u ON u.id = o.user_id WHERE u.phone = '+972601000002'`);
  assert.equal(outboxRows.length, 0, 'nothing enqueued at provisioning time');

  const { rows: userRows } = await db.pool.query(
    `SELECT workspace_path, onboarded_at FROM users WHERE phone = '+972601000002'`);
  assert.ok(userRows[0].onboarded_at, 'onboarded_at is set at provisioning, not on a later delivery');
  const userMd = fs.readFileSync(path.join(userRows[0].workspace_path, 'USER.md'), 'utf8');
  assert.match(userMd, /מה שכבר שיתפו לפני שהמערכת האישית הייתה מוכנה/);
  assert.match(userMd, /היי מה זה הדבר הזה\?/, 'their own words reach their personal workspace');

  // second sweep: already active → skipped, workspace untouched
  const again = await withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath,
    listSessions: async () => [{ phone: '+972601000002', key: 'x' }],
  }));
  assert.equal(again.provisioned.length, 0);
});

test('intake sweep: closed registration waitlists organic strangers, still admits invited ones', async () => {
  const inviter = await makeUser(db.pool, '+972601000003', { firstName: 'Miron', lastName: 'D' });
  await withTx(db.pool, async (c) => {
    await flags.setFlag(c, 'registration_open', false);
    const req = await connections.requestConnection(c, inviter.id, '+972601000005', { reason: 'רוצה לתאם פגישה' });
    await invites.afterConnectionRequest(c, inviter, req.data.connection, false);
  });

  const out = await withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath,
    listSessions: async () => [
      { phone: '+972601000004', key: 'organic stranger' },
      { phone: '+972601000005', key: 'invited stranger' },
    ],
  }));
  assert.deepEqual(out.waitlisted, ['+972601000004']);
  assert.deepEqual(out.provisioned, ['+972601000005']);

  const wl = await db.pool.query(`SELECT * FROM waitlist WHERE phone = '+972601000004'`);
  assert.equal(wl.rows.length, 1);
  // invited stranger's connection moved forward and USER.md carries the inviter context
  const conn = await db.pool.query(`SELECT status, target_id FROM connections WHERE target_phone = '+972601000005'`);
  assert.equal(conn.rows[0].status, 'pending_target');
  assert.ok(conn.rows[0].target_id);
  const { rows: wsRows } = await db.pool.query(
    `SELECT workspace_path FROM users WHERE phone = '+972601000005'`);
  const userMd = fs.readFileSync(path.join(wsRows[0].workspace_path, 'USER.md'), 'utf8');
  assert.match(userMd, /הצטרפו דרך הזמנה/);
  assert.match(userMd, /Miron D/);
  assert.match(userMd, /לתאם/);

  await withTx(db.pool, (c) => flags.setFlag(c, 'registration_open', true));
});

test('invite intro: pending user created, fixed intro text carries name+phone+reason', async () => {
  const { rows } = await db.pool.query(
    `SELECT o.payload, u.status FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.kind = 'connection_intro'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active'); // was pending, upgraded by the sweep above
  assert.match(rows[0].payload.text, /Miron D/);
  assert.match(rows[0].payload.text, /\+972601000003/);
  assert.match(rows[0].payload.text, /לתאם פגישה/);
});

test('reopen sweep: waitlisted phones notified exactly once, through the outbox', async () => {
  const out1 = await withTx(db.pool, (c) => intake.sweepReopen(c));
  assert.equal(out1.notified, 1);
  const out2 = await withTx(db.pool, (c) => intake.sweepReopen(c));
  assert.equal(out2.notified, 0); // promise kept once, not spammed

  const { rows } = await db.pool.query(
    `SELECT o.kind, u.phone, u.status FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.kind = 'registration_reopened'`);
  assert.equal(rows[0].phone, '+972601000004');
  assert.equal(rows[0].status, 'pending'); // reachable via intake session, not yet provisioned
});

test('circuit breaker: intake flood auto-closes registration and files one issue', async () => {
  // 35 fresh sessions in the last hour, cap is 30 → trip
  const flood = Array.from({ length: 35 }, (_, i) => ({
    phone: `+97266${String(1000000 + i)}`, key: `k${i}`, ageMs: 60_000,
  }));
  const out = await withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath,
    listSessions: async () => flood,
  }));
  assert.equal(out.breakerTripped, true);
  assert.equal(await withTx(db.pool, (c) => flags.getFlag(c, 'registration_open')), false);
  // strangers arriving after the trip get waitlisted, not provisioned
  assert.ok(out.waitlisted.length > 0);
  assert.equal(out.provisioned.length, 0);
  const issue = await db.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE title LIKE 'intake circuit breaker%' AND status = 'new'`);
  assert.equal(issue.rows[0].n, 1);

  // second sweep while closed: does not trip again, does not duplicate the issue
  const again = await withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath, listSessions: async () => flood,
  }));
  assert.ok(!again.breakerTripped);
  const issue2 = await db.pool.query(
    `SELECT count(*)::int AS n FROM issues WHERE title LIKE 'intake circuit breaker%'`);
  assert.equal(issue2.rows[0].n, 1);

  await withTx(db.pool, async (c) => {
    await flags.setFlag(c, 'registration_open', true);
    await c.query(`DELETE FROM waitlist`); // don't leak flood phones into the reopen test
  });
});

test('session index: parses the gateway own on-disk index, no CLI', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-sess-'));
  const dir = path.join(base, 'agents', 'intake', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
    'agent:intake:whatsapp:direct:+972601000077': { sessionId: 's1', lastInteractionAt: now - 5_000 },
    'agent:intake:whatsapp:group:120363@g.us': { sessionId: 's2', lastInteractionAt: now },
    'garbage-key': { sessionId: 's3' },
  }));
  const found = sessionIndex.listSessionsForAgent('intake', base);
  assert.equal(found.length, 2, 'unparseable keys are ignored, not crashed on');
  const direct = found.find((s) => s.chatType === 'direct');
  assert.equal(direct.peer, '+972601000077');
  assert.ok(direct.ageMs >= 5_000 && direct.ageMs < 60_000);
  // an agent with no index at all is simply empty, never an exception
  assert.deepEqual(sessionIndex.listSessionsForAgent('nope', base), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('session index: a corrupt index throws, so discovery can never fail silently', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-sess-bad-'));
  const dir = path.join(base, 'agents', 'intake', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions.json'), '{ not json');
  assert.throws(() => sessionIndex.listSessionsForAgent('intake', base), /unreadable/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('config guard: catches every identity-critical regression', async () => {
  const good = baseConfig();
  assert.deepEqual(guard.checkOpenclawConfig(good), []);

  const bad = baseConfig();
  bad.tools.fs.workspaceOnly = false;
  bad.tools.alsoAllow = ['write'];
  bad.mcp.servers = {};
  const v = guard.checkOpenclawConfig(bad);
  assert.equal(v.length, 3);

  // identity file check: tamper with a provisioned user's file
  const { rows } = await db.pool.query(
    `SELECT workspace_path FROM users WHERE phone = '+972601000001'`);
  fs.writeFileSync(path.join(rows[0].workspace_path, '.olma-identity'), 'olma_tok_' + '9'.repeat(32));
  const idViolations = await withTx(db.pool, (c) => guard.checkIdentityFiles(c));
  assert.ok(idViolations.some((s) => s.includes('does not match')));

  // full run files issues idempotently
  const run1 = await withTx(db.pool, (c) => guard.run(c, { configPath }));
  assert.ok(run1.newIssues >= 1);
  const run2 = await withTx(db.pool, (c) => guard.run(c, { configPath }));
  assert.equal(run2.newIssues, 0); // same violations → no duplicate issues
});

test('auth failures land in the audit log', async () => {
  const { createBrokerServer } = require('../src/brokerd/server');
  const broker = createBrokerServer({ pool: db.pool });
  await broker.dispatch({ id: 1, method: 'tool_call', params: { name: 'list_my_tasks', args: { identity_token: 'olma_tok_' + '0'.repeat(32) } } });
  const { rows } = await db.pool.query(`SELECT detail FROM audit_log WHERE event = 'auth.failed'`);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].detail.tool, 'list_my_tasks');
});

test('intake workspace sync: open/closed variants, idempotent writes', () => {
  const { syncIntakeWorkspace } = require('../src/intake/intake-workspace');
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-iw-'));
  const w1 = syncIntakeWorkspace(true, base2);
  assert.equal(w1.changed, true);
  const text = fs.readFileSync(path.join(base2, 'workspaces', 'intake', 'AGENTS.md'), 'utf8');
  // 2026-08-17 redesign: the greeter answers for real (product knowledge,
  // Olma's voice) — silence turned out to feel worse than a good generic
  // reply, and there is no separate personal welcome any more for a second
  // voice to clash with.
  assert.match(text, /Answer for real/);
  assert.match(text, /Olma/);
  assert.ok(!/NO_REPLY/.test(text), 'no longer told to stay silent');
  // Not testing for the ABSENCE of "later welcome" phrasing here — the
  // instruction legitimately quotes that exact phrase to prohibit it
  // ('never say "X"'), which makes a simple negative regex self-defeating.
  // The positive assertions above are what actually distinguish this from
  // the old NO_REPLY design.
  assert.equal(syncIntakeWorkspace(true, base2).changed, false); // no rewrite when unchanged
  const w2 = syncIntakeWorkspace(false, base2);
  assert.equal(w2.changed, true);
  assert.match(fs.readFileSync(path.join(base2, 'workspaces', 'intake', 'AGENTS.md'), 'utf8'), /paused/);
  fs.rmSync(base2, { recursive: true, force: true });
});

test('CLI failures surface as thrown errors, never as "no new users"', async () => {
  const { runOpenclawJson } = require('../src/channels/openclaw');
  // nonexistent subcommand → non-zero exit → must reject, not resolve empty
  await assert.rejects(() => runOpenclawJson(['definitely-not-a-command', '--json'], 10_000));
  // a sweep whose discovery throws must propagate so the heartbeat goes red
  await assert.rejects(() => withTx(db.pool, (c) => intake.sweepIntakeSessions(c, {
    configPath,
    listSessions: async () => { throw new Error('openclaw sessions list timed out'); },
  })));
});
