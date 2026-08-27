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

test('provisionUser: a name every existing owner agrees on prefills first_name, unconfirmed', async () => {
  const contacts = require('../src/domain/contacts');
  const a = await makeUser(db.pool, '+972601000200', { firstName: 'Owner A' });
  const b = await makeUser(db.pool, '+972601000201', { firstName: 'Owner B' });
  const newcomerPhone = '+972601000202';
  await withTx(db.pool, (c) => contacts.saveContact(c, a.id, { name: 'דנה כהן', phone: newcomerPhone, source: 'user_stated' }));
  await withTx(db.pool, (c) => contacts.saveContact(c, b.id, { name: 'דנה כהן', phone: newcomerPhone, source: 'contact_card' }));

  const res = await withTx(db.pool, (c) => provisionUser(c, { phone: newcomerPhone, configPath }));
  assert.ok(res.ok);
  assert.equal(res.data.user.first_name, 'דנה כהן');
  assert.equal(res.data.user.name_confirmed, false, 'a prefilled name is a guess, not a stated fact');

  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.name_prefilled_from_contacts'`,
    [res.data.user.id]);
  assert.equal(rows.length, 1, 'the source stays in the audit trail, never in anything user-facing');
  assert.equal(rows[0].detail.savedByCount, 2);
});

test('provisionUser: disagreeing names across address books prefill nothing', async () => {
  const contacts = require('../src/domain/contacts');
  const a = await makeUser(db.pool, '+972601000210', { firstName: 'Owner C' });
  const b = await makeUser(db.pool, '+972601000211', { firstName: 'Owner D' });
  const phone = '+972601000212';
  await withTx(db.pool, (c) => contacts.saveContact(c, a.id, { name: 'דנה', phone, source: 'user_stated' }));
  await withTx(db.pool, (c) => contacts.saveContact(c, b.id, { name: 'עודד', phone, source: 'user_stated' }));

  const res = await withTx(db.pool, (c) => provisionUser(c, { phone, configPath }));
  assert.ok(res.ok);
  assert.equal(res.data.user.first_name, null, 'two different names is not "the same answer" — leave it unset');
});

test('provisionUser: an explicit firstName always wins over any prefill', async () => {
  const contacts = require('../src/domain/contacts');
  const a = await makeUser(db.pool, '+972601000220', { firstName: 'Owner E' });
  const phone = '+972601000221';
  await withTx(db.pool, (c) => contacts.saveContact(c, a.id, { name: 'מהספר', phone, source: 'user_stated' }));

  const res = await withTx(db.pool, (c) => provisionUser(c, { phone, firstName: 'מהשיחה', configPath }));
  assert.equal(res.data.user.first_name, 'מהשיחה');
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

test('agent doctrine: act-first outranks curiosity, and one question is a hard cap', () => {
  const fs = require('node:fs');
  const tpl = fs.readFileSync(require('../src/intake/provision').TEMPLATE_PATH, 'utf8');

  // A real user ("קצת חופר") got four rounds of questions before anything was
  // saved. These are the specific instructions that exist to prevent that.
  assert.match(tpl, /Act first, ask second/);
  assert.match(tpl, /one question — not one message with a numbered/,
    'a numbered list of sub-questions in one bubble is still an interrogation');
  assert.match(tpl, /guess everything you reasonably can/);
  assert.match(tpl, /actually blocks what they asked for/,
    'when several things are unclear, ask about the important one, not all of them');
  assert.match(tpl, /State assumptions instead of asking/);
  assert.match(tpl, /give the\s+outcome/, 'an outcome request gets an outcome, not prerequisites');

  // The connection reflex must not fire on someone mentioned once in passing
  assert.match(tpl, /NOT for someone mentioned once in\s+passing/);

  // Gender was stored correctly and then ignored on the next line
  assert.match(tpl, /hold it consistently through every sentence/);

  // The token must be read alone — batching it caused a failed call every turn
  assert.match(tpl, /as a tool call ON ITS OWN/);
  assert.match(tpl, /not batched with `turn_start`/);
  // A goodbye is not a tool call: the doctrine has to name pause_olma, or the
  // agent does what it did the night this section was written — says something
  // kind and changes nothing.
  assert.match(tpl, /## When they want you to stop/);
  assert.match(tpl, /pause_olma/);
  assert.match(tpl, /resume_olma/);
  assert.match(tpl, /deletes nothing/i);
  // The doctrine that closes the "he'd have had to remember resume_olma
  // himself" gap: the model is told what turn_start's offerResume field means
  // and that it fires exactly once per pause.
  assert.match(tpl, /offerResume/);
  assert.match(tpl, /will not fire again this pause/);
});

test('intake greeter is told not to interrogate either', () => {
  const { intakeAgentsMd } = require('../src/intake/intake-workspace');
  const open = intakeAgentsMd(true);
  assert.match(open, /Never interrogate/);
  assert.match(open, /At most ONE question/);
  assert.match(open, /not one message holding a numbered list/);
});

// Olma is a personal assistant, not a general answering machine — the model
// underneath could imitate Google or ChatGPT, which is exactly why the
// doctrine has to say not to. Answers stay short, precise, and grounded in
// the person's own data; a missing piece is a question, never a fill-in from
// general knowledge.
test('agent doctrine: Olma does not impersonate Google or ChatGPT', () => {
  const fs = require('node:fs');
  const tpl = fs.readFileSync(require('../src/intake/provision').TEMPLATE_PATH, 'utf8');

  assert.match(tpl, /## Not Google, not ChatGPT/);
  // the value proposition the rule protects
  assert.match(tpl, /knowing\s+THIS person, not knowing everything/);
  // answers come from their data, and a gap is a question — not a guess from
  // the model's training
  assert.match(tpl, /grounded in THEIR data/);
  assert.match(tpl, /never fill the gap from general knowledge/);
  // essays, documents, explainers are declined as not-her-job — but in the
  // "cannot do" shape: one plain line, and the errand inside survives
  assert.match(tpl, /General-topic questions and writing work are out of scope/);
  assert.match(tpl, /never the refusal alone/);
  assert.match(tpl, /offer to save THAT as a task/);
  // the carve-out stays narrow: unblocking their errand, never a lecture
  assert.match(tpl, /One passing sentence that unblocks their own errand/);
  assert.match(tpl, /a lecture, a document/);

  // the greeter — where new people test the bot with exactly these questions
  // — carries the same rule
  const { intakeAgentsMd } = require('../src/intake/intake-workspace');
  const open = intakeAgentsMd(true);
  assert.match(open, /not a search engine and not a general-purpose chatbot/);
  assert.match(open, /not what Olma is for/);
});

// A user asked Olma to look things up online and buy them. She can do neither,
// and the refusal took his errand down with it — details included. These are
// the instructions that turn a hard boundary into something he keeps.
test('agent doctrine: a capability Olma lacks still leaves the user holding something', () => {
  const fs = require('node:fs');
  const tpl = fs.readFileSync(require('../src/intake/provision').TEMPLATE_PATH, 'utf8');

  assert.match(tpl, /Never end on "I can't\."/);
  // the boundary is named, so the model stops improvising around it
  assert.match(tpl, /no web access/);
  assert.match(tpl, /orders, payment/);
  // ...and the request survives — but as an OFFER, never a silent write to
  // their list: they asked Olma to do it, so handing the job back is theirs
  // to accept.
  assert.match(tpl, /Offer to keep the thing itself — ask, do not save/);
  assert.match(tpl, /Nothing goes on their\s+list before they answer/);
  assert.match(tpl, /save with everything they already told you/);
  assert.match(tpl, /never make them repeat any of it/);
  assert.match(tpl, /On a no or no answer: drop it/);
  assert.match(tpl, /if\s+time-shaped, offer a reminder/i);
  // the two save-rules must not read as contradicting each other
  assert.match(tpl, /THE\s+deliberate exception to act-first/);
  // the demand signal is logged without spending a turn asking permission
  assert.match(tpl, /`agent_detected`/);
  assert.match(tpl, /must never be\s+asked about/);
  assert.match(tpl, /invisible to\s+them/,
    'logging the gap is about the product, not their list — so it is not the one to ask about');
  // the hallucination guard — the real hazard when someone asks you to look
  assert.match(tpl, /never fake the part you cannot do/);
  assert.match(tpl, /you looked, and you did not/);
  assert.match(tpl, /a price never qualifies/);

  // and the same tool still guards the other case, where the words are theirs
  assert.match(tpl, /ask\s+before logging anything as `user_reported`/);
});

test('the report_issue tool carries the same rule at the call site', () => {
  const { TOOLS } = require('../src/adapters/mcp/registry');
  const t = TOOLS.find((x) => x.name === 'report_issue');
  assert.ok(t, 'report_issue exists');
  assert.match(t.description, /agent_detected/);
  // The description was compressed in the prompt diet (cache writes were 76%
  // of all cost); the rule survives in shorter words, and this asserts the
  // rule, not the sentence.
  assert.match(t.description, /never ask permission/,
    'a capability gap is the agent\'s own observation, not a question for the user');
});
