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
  for (const t of list.tools) {
    assert.ok(t.inputSchema.required.includes('identity_token'), `${t.name} must require identity_token`);
  }
});

test('tool calls execute end-to-end and are isolated per token', async () => {
  const added = await callTool('add_task', { identity_token: alice.identity_token, title: 'e2e task' });
  assert.match(added, /^OK /);

  const aliceList = await callTool('list_my_tasks', { identity_token: alice.identity_token });
  assert.match(aliceList, /e2e task/);
  const bobList = await callTool('list_my_tasks', { identity_token: bob.identity_token });
  assert.ok(!bobList.includes('e2e task'), 'bob must not see alice\'s task');
});

test('bad token rejected; token never echoed back', async () => {
  const bad = await callTool('list_my_tasks', { identity_token: 'olma_tok_' + '0'.repeat(32) });
  assert.match(bad, /^ERROR forbidden/);
  assert.ok(!bad.includes('olma_tok_'), 'tokens must be scrubbed from output');

  const profile = await callTool('get_my_profile', { identity_token: alice.identity_token });
  assert.ok(!profile.includes('olma_tok_'), 'no token in any output');
});

test('turn_start returns proceed for a healthy user', async () => {
  const r = await callTool('turn_start', { identity_token: alice.identity_token });
  assert.match(r, /"directive":"proceed"/);
});

test('turn_start drives the block flow: notice once, then silent', async () => {
  const flags = require('../src/domain/flags');
  const c = await db.pool.connect();
  try { await flags.setFlag(c, 'quota_daily_free', 1); } finally { c.release(); }

  // bob's first message passes, second crosses the limit
  let r = await callTool('turn_start', { identity_token: bob.identity_token });
  assert.match(r, /"directive":"proceed"/);
  r = await callTool('turn_start', { identity_token: bob.identity_token });
  assert.match(r, /"directive":"send_block_notice"/);
  assert.match(r, /"blockView"/);
  assert.match(r, /"openTasks"/); // counts-only personal data present
  r = await callTool('turn_start', { identity_token: bob.identity_token });
  assert.match(r, /"directive":"silent"/); // one notice per window, never two
});

test('unknown tool yields a clean error', async () => {
  const r = await callTool('summon_demons', { identity_token: alice.identity_token });
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
  const seed = await callTool('list_my_tasks', { identity_token: alice.identity_token });
  assert.match(seed, /^OK/);

  const truncated = await callTool('list_my_tasks', { identity_token: alice.identity_token.slice(0, 20) });
  assert.match(truncated, /^OK/, 'a truncated token must be repaired, not failed');

  const missing = await callTool('list_my_tasks', {});
  assert.match(missing, /^OK/, 'a missing token must be repaired too');

  const placeholder = await callTool('list_my_tasks', { identity_token: '<from .olma-identity>' });
  assert.match(placeholder, /^OK/, 'a placeholder must be repaired too');
});

test('a well-formed wrong token still fails — no identity swap on typos', async () => {
  const wrong = await callTool('list_my_tasks', { identity_token: 'olma_tok_' + 'f'.repeat(32) });
  assert.match(wrong, /^ERROR forbidden/);
  assert.match(wrong, /\.olma-identity/, 'the failure must name the recovery');
});
