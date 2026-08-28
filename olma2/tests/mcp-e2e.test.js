'use strict';
// Full-stack integration: real brokerd process + real MCP shim process,
// talking line-delimited JSON-RPC over stdio, against a throwaway DB —
// the same path OpenClaw exercises in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { freshDb, makeUser } = require('./helpers');

let db, brokerd, shim, alice, bob;
const SOCK = path.join(os.tmpdir(), 'olma2-test-' + crypto.randomBytes(4).toString('hex') + '.sock');
const BIN = path.join(__dirname, '..', 'bin');

let rpcId = 0;
const pendingRpc = new Map();

function shimSend(msg) { shim.stdin.write(JSON.stringify(msg) + '\n'); }
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pendingRpc.set(id, { resolve, reject });
    shimSend({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pendingRpc.delete(id)) reject(new Error(`rpc timeout: ${method}`));
    }, 15_000);
  });
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  return res.content[0].text;
}

before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972571000001', { firstName: 'Alice' });
  bob = await makeUser(db.pool, '+972571000002', { firstName: 'Bob' });

  brokerd = spawn('node', [path.join(BIN, 'olma-brokerd.js')], {
    env: { ...process.env, OLMA_DB_URL: db.url, OLMA_SOCK: SOCK, OLMA_HEARTBEAT: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    brokerd.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    brokerd.stderr.on('data', (d) => console.error('[brokerd]', String(d)));
    brokerd.on('exit', (code) => reject(new Error('brokerd exited ' + code)));
    setTimeout(() => reject(new Error('brokerd start timeout')), 10_000);
  });

  shim = spawn('node', [path.join(BIN, 'olma-mcp.js')], {
    env: { ...process.env, OLMA_SOCK: SOCK },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  shim.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pendingRpc.get(msg.id);
      if (p) { pendingRpc.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
});

after(async () => {
  if (shim) shim.kill();
  if (brokerd) brokerd.kill();
  if (db) await db.teardown();
});

test('MCP handshake and tool listing', async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(init.serverInfo.name, 'olma');
  const list = await rpc('tools/list', {});
  const names = list.tools.map((t) => t.name);
  assert.ok(names.includes('turn_start'));
  assert.ok(names.includes('add_tasks_bulk'));
  assert.ok(names.includes('start_meeting_coordination'));
  assert.ok(names.includes('start_contacts_connection'));
  assert.ok(names.includes('import_google_contacts'));
  assert.ok(names.includes('import_contacts_file'));
  for (const t of list.tools) {
    assert.ok(t.inputSchema.required.includes('olma_identity'), `${t.name} must require olma_identity`);
    // The old name must not appear ANYWHERE in a schema. OpenClaw masks
    // tool-call arguments whose name normalises to token/key/secret/… before
    // persisting them, and the persisted call is what the model imitates next
    // turn — which is how a masked value came back as the token and produced
    // 118 auth failures in one day. One tool left on the old name would keep
    // manufacturing that precedent for every model that sees it.
    const schema = JSON.stringify(t.inputSchema);
    assert.ok(!schema.includes('identity_token'), `${t.name} still mentions identity_token`);
  }
});

test('tool calls execute end-to-end and are isolated per token', async () => {
  const added = await callTool('add_task', { olma_identity: alice.identity_token, title: 'e2e task' });
  assert.match(added, /^OK /);

  const aliceList = await callTool('list_my_tasks', { olma_identity: alice.identity_token });
  assert.match(aliceList, /e2e task/);
  const bobList = await callTool('list_my_tasks', { olma_identity: bob.identity_token });
  assert.ok(!bobList.includes('e2e task'), 'bob must not see alice\'s task');
});

test('bad token rejected; token never echoed back', async () => {
  const bad = await callTool('list_my_tasks', { olma_identity: 'olma_tok_' + '0'.repeat(32) });
  assert.match(bad, /^ERROR forbidden/);
  assert.ok(!bad.includes('olma_tok_'), 'tokens must be scrubbed from output');

  const profile = await callTool('get_my_profile', { olma_identity: alice.identity_token });
  assert.ok(!profile.includes('olma_tok_'), 'no token in any output');
});

test('turn_start returns proceed for a healthy user', async () => {
  const r = await callTool('turn_start', { olma_identity: alice.identity_token });
  assert.match(r, /"directive":"proceed"/);
});

// Observed live 2026-08-27: two connection requests sat 'night'-held until
// morning while the recipient was actively chatting — the worker never
// re-reads a held row before its release_after, so the gate's 15-minute
// mid-conversation grace could not fire. An inbound message now wakes
// night-held rows for an immediate re-hearing; the gate stays the judge.
test('an inbound message wakes night-held rows for the gate to re-decide', async () => {
  const tomorrow = new Date(Date.now() + 10 * 3600_000);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, hold_reason, release_after)
     VALUES ($1, 'connection_request', '{}', 'normal', 'night', $2),
            ($1, 'checkin', '{}', 'normal', 'budget', $2)`,
    [alice.id, tomorrow]);

  await callTool('turn_start', { olma_identity: alice.identity_token });

  const { rows } = await db.pool.query(
    `SELECT hold_reason, release_after <= now() AS woken FROM outbox
      WHERE user_id = $1 AND sent_at IS NULL ORDER BY hold_reason`, [alice.id]);
  const byReason = Object.fromEntries(rows.map((r) => [r.hold_reason, r.woken]));
  assert.equal(byReason.night, true, 'night hold gets an immediate re-hearing');
  // A budget hold's budget is still spent — waking it would override the
  // gate, not re-ask it.
  assert.equal(byReason.budget, false, 'budget hold keeps its schedule');

  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1 AND sent_at IS NULL`, [alice.id]);
});

// The failure this covers ran live for two days: the WhatsApp display name was
// in the model's context on every single turn while users.first_name stayed
// NULL, so the card, the dashboard and every invitation showed a phone number.

test('turn_start writes down the display name of someone we have no name for', async () => {
  const nameless = await makeUser(db.pool, '+972571000003', { firstName: null });
  const r = await callTool('turn_start', {
    olma_identity: nameless.identity_token, sender_name: 'חיים דדוש',
  });
  assert.match(r, /"directive":"proceed"/);
  assert.ok(!r.includes('cardStale'), 'the card flag is plumbing, not something the model reads');

  const { rows } = await db.pool.query(
    'SELECT first_name, last_name, name_confirmed FROM users WHERE id = $1', [nameless.id]);
  assert.equal(rows[0].first_name, 'חיים');
  assert.equal(rows[0].last_name, 'דדוש');
  assert.equal(rows[0].name_confirmed, false, 'a display name is a lead, not their answer');
});

test('turn_start never lets a display name overwrite the name someone gave us', async () => {
  await callTool('set_my_name', { olma_identity: alice.identity_token, first_name: 'Alice', confirmed: true });
  const r = await callTool('turn_start', {
    olma_identity: alice.identity_token, sender_name: '😈 Not Alice',
  });
  assert.match(r, /"directive":"proceed"/, 'and the turn carries on regardless');
  const { rows } = await db.pool.query('SELECT first_name FROM users WHERE id = $1', [alice.id]);
  assert.equal(rows[0].first_name, 'Alice');
});

test('turn_start ignores a sender field that is just the number back', async () => {
  const nameless = await makeUser(db.pool, '+972571000004', { firstName: null });
  await callTool('turn_start', {
    olma_identity: nameless.identity_token, sender_name: '+972571000004',
  });
  const { rows } = await db.pool.query('SELECT first_name FROM users WHERE id = $1', [nameless.id]);
  assert.equal(rows[0].first_name, null);
});

test('set_my_name defaults to unconfirmed, so a guess is never mistaken for an answer', async () => {
  const u = await makeUser(db.pool, '+972571000005', { firstName: null });
  await callTool('set_my_name', { olma_identity: u.identity_token, first_name: 'עמית' });
  let { rows } = await db.pool.query('SELECT first_name, name_confirmed FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].first_name, 'עמית');
  assert.equal(rows[0].name_confirmed, false);

  await callTool('set_my_name', { olma_identity: u.identity_token, first_name: 'עמית', confirmed: true });
  ({ rows } = await db.pool.query('SELECT name_confirmed FROM users WHERE id = $1', [u.id]));
  assert.equal(rows[0].name_confirmed, true);
});

test('turn_start drives the block flow: notice once, then silent', async () => {
  const flags = require('../src/domain/flags');
  // The flag is shared across every test in this file's one DB — left at 1,
  // any later test making more than one turn_start call for the same user
  // silently starts hitting 'blocked' instead of 'proceed'. Restore it in a
  // finally so a later test failing does not also poison the ones after it.
  const c = await db.pool.connect();
  try { await flags.setFlag(c, 'quota_daily_free', 1); } finally { c.release(); }
  try {
    // bob's first message passes, second crosses the limit
    let r = await callTool('turn_start', { olma_identity: bob.identity_token });
    assert.match(r, /"directive":"proceed"/);
    r = await callTool('turn_start', { olma_identity: bob.identity_token });
    assert.match(r, /"directive":"send_block_notice"/);
    assert.match(r, /"blockView"/);
    assert.match(r, /"openTasks"/); // counts-only personal data present
    r = await callTool('turn_start', { olma_identity: bob.identity_token });
    assert.match(r, /"directive":"silent"/); // one notice per window, never two
  } finally {
    const c2 = await db.pool.connect();
    try { await flags.setFlag(c2, 'quota_daily_free', 50); } finally { c2.release(); }
  }
});

// The tools that did not exist the night a user asked to stop and Olma, with
// nothing to call, said goodbye and messaged him again in the morning.
test('pause_olma stops everything and resume_olma puts it back', async () => {
  const u = await makeUser(db.pool, '+972571000009', { firstName: 'קפיש' });

  const paused = await callTool('pause_olma', {
    olma_identity: u.identity_token, note: 'זהו',
  });
  assert.match(paused, /^OK /);
  let { rows } = await db.pool.query('SELECT paused_at FROM users WHERE id = $1', [u.id]);
  assert.ok(rows[0].paused_at, 'the goodbye is a tool call, not a sentence');

  // and they can still talk to Olma — pausing stops Olma initiating, not Olma answering
  const stillWorks = await callTool('turn_start', { olma_identity: u.identity_token });
  assert.match(stillWorks, /"directive":"proceed"/);

  const resumed = await callTool('resume_olma', { olma_identity: u.identity_token });
  assert.match(resumed, /^OK /);
  ({ rows } = await db.pool.query('SELECT paused_at FROM users WHERE id = $1', [u.id]));
  assert.equal(rows[0].paused_at, null);

  // resuming twice is refused rather than silently accepted
  assert.match(await callTool('resume_olma', { olma_identity: u.identity_token }),
    /^ERROR invalid/);
});

test('the first message after pausing offers to resume; nothing after that does', async () => {
  const u = await makeUser(db.pool, '+972571000011', { firstName: 'קפיש' });
  await callTool('pause_olma', { olma_identity: u.identity_token });

  const first = await callTool('turn_start', { olma_identity: u.identity_token });
  assert.match(first, /"offerResume":true/, 'the first turn after pausing must offer, unprompted');

  const second = await callTool('turn_start', { olma_identity: u.identity_token });
  assert.doesNotMatch(second, /offerResume/, 'never twice in the same pause — that is the pitch-to-retain pattern the doctrine forbids');

  const third = await callTool('turn_start', { olma_identity: u.identity_token });
  assert.doesNotMatch(third, /offerResume/);
});

test('turn_start hands the agent the reminders it never saw go out', async () => {
  // Reminders ride the raw pipe now (channels/openclaw.js), which never
  // touches the session, so a bare "סיימתי" would reach an agent with no idea
  // a reminder just fired. The outbox row is the record; turn_start reads it.
  const u = await makeUser(db.pool, '+972571000030', { firstName: 'דנה' });

  // an ordinary turn carries nothing — the field must not cost every message
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }),
    /recentReminders/);

  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, urgency, payload, idempotency_key, sent_at)
     VALUES ($1, 'reminder', 'urgent', '{"taskId":1,"title":"לקחת תרופה"}', 'rrem:1', now() - interval '10 minutes'),
            ($1, 'reminder', 'urgent', '{"taskId":2,"title":"ישן מדי"}',   'rrem:2', now() - interval '2 days'),
            ($1, 'reminder', 'urgent', '{"taskId":3,"title":"בוטל"}',      'rrem:3', now() - interval '5 minutes')`,
    [u.id]);
  // a cancelled/expired row was never delivered — it must not show up either
  await db.pool.query(
    `UPDATE outbox SET hold_reason = 'cancelled_by_admin' WHERE idempotency_key = 'rrem:3'`);

  const r = await callTool('turn_start', { olma_identity: u.identity_token });
  assert.match(r, /recentReminders/);
  assert.match(r, /לקחת תרופה/, 'the reminder delivered minutes ago is the likely referent');
  assert.doesNotMatch(r, /ישן מדי/, 'older than a day is stale context, not help');
  assert.doesNotMatch(r, /בוטל/, 'a cancelled row was never delivered, so it is not context');
});

test('turn_start carries the overnight plan headline — USER.md alone cannot, mid-session', async () => {
  // contextInjection: continuation-skip means the card is injected on session
  // START only, so a plan built while a session sleeps is invisible to it for
  // the session's whole remaining life. Observed live on the feature's first
  // evening: "מה התוכניות שלי להיום" answered from the digest tool while a
  // fresh plan sat unread in the card. turn_start is the every-turn channel.
  const u = await makeUser(db.pool, '+972571000031', { firstName: 'רון' });

  // no plan → no field
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }),
    /planHeadline/);

  await db.pool.query(
    `INSERT INTO user_plans (user_id, headline) VALUES ($1, 'יום עמוס: הדרכון דחוף')`, [u.id]);
  assert.match(await callTool('turn_start', { olma_identity: u.identity_token }),
    /יום עמוס: הדרכון דחוף/);

  // a stale plan is yesterday presented as today — worse than nothing
  await db.pool.query(
    `UPDATE user_plans SET built_at = now() - interval '30 hours' WHERE user_id = $1`, [u.id]);
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }),
    /planHeadline/);

  // a paused person's turns must not lean forward
  await db.pool.query(
    `UPDATE user_plans SET built_at = now() WHERE user_id = $1`, [u.id]);
  await callTool('pause_olma', { olma_identity: u.identity_token });
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }),
    /planHeadline/);
});

test('resuming and pausing again offers exactly once more', async () => {
  const u = await makeUser(db.pool, '+972571000012', { firstName: 'קפיש' });
  await callTool('pause_olma', { olma_identity: u.identity_token });
  assert.match(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume":true/);
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume/);

  await callTool('resume_olma', { olma_identity: u.identity_token });
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume/,
    'not paused — nothing to offer');

  await callTool('pause_olma', { olma_identity: u.identity_token });
  assert.match(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume":true/,
    'a new pause period is a fresh chance to offer — the old timestamp must not block it');
  assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume/);
});

test('a user who was never paused never sees offerResume', async () => {
  const u = await makeUser(db.pool, '+972571000013', { firstName: 'לא הושהה' });
  for (let i = 0; i < 3; i++) {
    assert.doesNotMatch(await callTool('turn_start', { olma_identity: u.identity_token }), /offerResume/);
  }
});

test('one user can never pause another', async () => {
  const victim = await makeUser(db.pool, '+972571000010', { firstName: 'לא אני' });
  // there is no user-id parameter to abuse: identity is the token, full stop
  await callTool('pause_olma', { olma_identity: alice.identity_token, user_id: victim.id });
  const { rows } = await db.pool.query('SELECT paused_at FROM users WHERE id = $1', [victim.id]);
  assert.equal(rows[0].paused_at, null);
  // clean up so later tests see alice running
  await callTool('resume_olma', { olma_identity: alice.identity_token });
});

test('unknown tool yields a clean error', async () => {
  const r = await callTool('summon_demons', { olma_identity: alice.identity_token });
  assert.match(r, /^ERROR not_found/);
});

// ---- identity self-healing --------------------------------------------------
// The shim repairs a MALFORMED token (truncated / placeholder / missing) with
// the one that already succeeded on this connection — and never "corrects" a
// well-formed token, which would be an identity swap waiting to happen if
// shims were ever shared between sessions.

test('a truncated token heals to the session\'s proven identity', async () => {
  // seed: one honest call proves alice on this connection (earlier tests did
  // too, but this test must not depend on their ordering)
  const seed = await callTool('list_my_tasks', { olma_identity: alice.identity_token });
  assert.match(seed, /^OK/);

  const truncated = await callTool('list_my_tasks', { olma_identity: alice.identity_token.slice(0, 20) });
  assert.match(truncated, /^OK/, 'a truncated token must be repaired, not failed');

  const missing = await callTool('list_my_tasks', {});
  assert.match(missing, /^OK/, 'a missing token must be repaired too');

  const placeholder = await callTool('list_my_tasks', { olma_identity: '<from .olma-identity>' });
  assert.match(placeholder, /^OK/, 'a placeholder must be repaired too');
});

test('a well-formed wrong token still fails — no identity swap on typos', async () => {
  const wrong = await callTool('list_my_tasks', { olma_identity: 'olma_tok_' + 'f'.repeat(32) });
  assert.match(wrong, /^ERROR forbidden/);
  assert.match(wrong, /\.olma-identity/, 'the failure must name the recovery');
});

// The rename ships to code first and to workspaces second — deploy.sh resyncs
// AGENTS.md only after the new release is live and healthy — and a session
// already under way keeps copying the old name from its own earlier turns for
// a while regardless. Both names authenticating is what makes that gap
// invisible to a live user instead of a window where nobody can call anything.
test('the old parameter name still authenticates, and the new one wins', async () => {
  const legacy = await callTool('list_my_tasks', { identity_token: bob.identity_token });
  assert.match(legacy, /^OK/, 'an agent on the pre-rename doctrine must keep working');

  // Both present: the new name is the answer. A model half-migrated within one
  // session sends both, and the legacy slot is the one carrying the masked
  // value it copied out of its own transcript — so preferring it would
  // reintroduce the exact failure the rename removes.
  const both = await callTool('get_my_profile', {
    olma_identity: bob.identity_token, identity_token: 'olma_t…beef',
  });
  assert.match(both, /^OK/, 'the valid new-name identity must win over a masked legacy one');
});

test('the identity never reaches a handler under either name', async () => {
  // A handler that could read the identity out of its own args would be a
  // second door into auth. add_task echoes its task back, so a leaked
  // parameter would surface here; the DB is the real check.
  const { stripIdentity } = require('../src/adapters/mcp/identity-param');
  assert.deepEqual(
    stripIdentity({ olma_identity: 'a', identity_token: 'b', title: 'keep me' }),
    { title: 'keep me' });

  const added = await callTool('add_task', {
    identity_token: bob.identity_token, title: 'legacy-named call',
  });
  assert.match(added, /^OK/);
  const { rows } = await db.pool.query(
    `SELECT owner_id FROM tasks WHERE title = 'legacy-named call'`);
  assert.equal(rows.length, 1, 'the legacy-named call did real work');
  assert.equal(Number(rows[0].owner_id), Number(bob.id), 'as the right person');
});
