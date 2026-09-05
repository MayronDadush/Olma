'use strict';
// channels/sessions-async.js promises exactly what sessions.js returns, one
// worker thread later. That equivalence is the whole contract — every sweep
// in brokerd now reads through it — so it is checked function by function
// against the same sqlite fixture sessions-sqlite.test.js uses, not assumed.
//
// The three guarantees the facade makes beyond "same answer" are each driven
// here too: an error inside the worker rejects by name (a malformed store
// must fail its sweep loudly), a read that outlives its deadline rejects and
// is replaced rather than holding the sweep open, and the worker never keeps
// this process alive (the test child's exit is the proof).
//
// No database: these are filesystem tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
// Before the first worker spawns: a worker copies its env at birth, and the
// deadline test below needs the guarded stall hook switched on in it.
process.env.OLMA_SESSIONS_WORKER_TEST_HOOKS = '1';
const sessions = require('../src/channels/sessions');
const facade = require('../src/channels/sessions-async');

let HOME_DIR, PREV_HOME;
const AGENT = 'u-async';
const PEER = '+972595990101';
const SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';
const KEY = `agent:${AGENT}:whatsapp:direct:${PEER}`;

function agentDir(...parts) { return path.join(HOME_DIR, 'agents', AGENT, ...parts); }

function seedDb({ nodes = [], events = [] }) {
  fs.mkdirSync(agentDir('agent'), { recursive: true });
  fs.mkdirSync(agentDir('sessions'), { recursive: true });
  const db = new DatabaseSync(agentDir('agent', 'openclaw-agent.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_nodes (
      session_key TEXT NOT NULL PRIMARY KEY, current_session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER);
    CREATE TABLE IF NOT EXISTS transcript_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
  `);
  const node = db.prepare(
    'INSERT OR REPLACE INTO session_nodes (session_key, current_session_id, entry_json, updated_at, archived_at) VALUES (?,?,?,?,?)');
  for (const n of nodes) node.run(n.key, n.sessionId, JSON.stringify(n.entry), n.entry.updatedAt || 0, n.archivedAt || null);
  const ev = db.prepare(
    'INSERT OR REPLACE INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)');
  for (const e of events) ev.run(e.sessionId, e.seq, JSON.stringify(e.event), e.at || 0);
  db.close();
}

const msg = (role, text, at = '2026-09-01T10:00:00.000Z') => ({
  type: 'message', timestamp: at, message: { role, content: [{ type: 'text', text }] },
});

before(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-sessions-async-'));
  PREV_HOME = process.env.OLMA_OPENCLAW_HOME;
  process.env.OLMA_OPENCLAW_HOME = HOME_DIR;
  const now = Date.now();
  seedDb({
    nodes: [{ key: KEY, sessionId: SESSION, entry: { sessionId: SESSION, updatedAt: now, lastInteractionAt: now, model: 'm' } }],
    events: [
      { sessionId: SESSION, seq: 1, at: now - 3000, event: msg('user', 'שלום, תזכירי לי מחר') },
      { sessionId: SESSION, seq: 2, at: now - 2000, event: msg('assistant', 'בטח, באיזו שעה?') },
      { sessionId: SESSION, seq: 3, at: now - 1000, event: msg('user', 'בתשע') },
    ],
  });
});
after(async () => {
  await facade.close();
  if (PREV_HOME === undefined) delete process.env.OLMA_OPENCLAW_HOME; else process.env.OLMA_OPENCLAW_HOME = PREV_HOME;
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
});

// Anything with a clock in it (ageMs) is normalised before comparing: the two
// reads happen milliseconds apart and that field is derived from Date.now().
const stable = (rows) => rows.map((r) => ({ ...r, ageMs: r.ageMs == null ? null : 'n' }));

test('listSessionsForAgent: same rows through the worker as in-thread', async () => {
  const sync = sessions.listSessionsForAgent(AGENT);
  const viaWorker = await facade.listSessionsForAgent(AGENT);
  assert.equal(sync.length, 1);
  assert.deepEqual(stable(viaWorker), stable(sync));
});

test('readRecentMessages / readPeerUserText / hasInboundUserTurn / scanAssistantTextSince agree', async () => {
  assert.deepEqual(await facade.readRecentMessages(AGENT, 10, undefined, PEER),
    sessions.readRecentMessages(AGENT, 10, undefined, PEER));
  assert.deepEqual(await facade.readPeerUserText(AGENT, PEER), sessions.readPeerUserText(AGENT, PEER));
  assert.equal(await facade.hasInboundUserTurn(AGENT, KEY), sessions.hasInboundUserTurn(AGENT, KEY));
  assert.deepEqual(await facade.scanAssistantTextSince(AGENT, 0), sessions.scanAssistantTextSince(AGENT, 0));
  // And the answer is the real one, not an empty stand-in.
  assert.match(await facade.readPeerUserText(AGENT, PEER), /תזכירי/);
});

test('an agent with no store reads as empty through the worker, exactly as in-thread', async () => {
  assert.deepEqual(await facade.listSessionsForAgent('u-nobody'), sessions.listSessionsForAgent('u-nobody'));
  assert.equal(await facade.readPeerUserText('u-nobody', PEER), sessions.readPeerUserText('u-nobody', PEER));
});

test('the worker reads the HOME the caller has at call time, not the one it was born with', async () => {
  // The worker already exists from the tests above, spawned under HOME_DIR.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-sessions-async-other-'));
  process.env.OLMA_OPENCLAW_HOME = other;
  try {
    assert.deepEqual(await facade.listSessionsForAgent(AGENT), [], 'the empty tree, not the seeded one');
  } finally {
    process.env.OLMA_OPENCLAW_HOME = HOME_DIR;
    fs.rmSync(other, { recursive: true, force: true });
  }
  assert.equal((await facade.listSessionsForAgent(AGENT)).length, 1, 'and back again');
});

test('an error inside the worker rejects by name — a malformed store must fail its sweep loudly', async () => {
  // A store that exists but is not sqlite: withAgentDb opens it and the
  // query throws. That must reach the caller as the error, not as [].
  const broken = 'u-broken';
  fs.mkdirSync(path.join(HOME_DIR, 'agents', broken, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, 'agents', broken, 'agent', 'openclaw-agent.sqlite'), 'this is not a database');
  let syncErr = null;
  try { sessions.listSessionsForAgent(broken); } catch (e) { syncErr = e; }
  assert.ok(syncErr, 'the sync read throws on this fixture');
  await assert.rejects(facade.listSessionsForAgent(broken), (e) => e.message === syncErr.message);
  // The worker survived the throw: the next call is answered normally.
  assert.equal((await facade.listSessionsForAgent(AGENT)).length, 1);
});

test('a name that is not a sessions function rejects, it does not resolve to nothing', async () => {
  await assert.rejects(facade._call('noSuchReader', []), /sessions\.noSuchReader is not a function/);
});

test('a read that outlives its deadline rejects and the worker is replaced, not waited on', async () => {
  // The cap is read when the module loads, so this drives a fresh copy with
  // a tiny one. The stall is the worker's own guarded test hook (a bounded
  // Atomics.wait on the worker thread) — the only way to make a read hang on
  // demand without a fixture that could hang the suite itself.
  const key = require.resolve('../src/channels/sessions-async');
  const saved = process.env.OLMA_SESSIONS_READ_TIMEOUT_MS;
  process.env.OLMA_SESSIONS_READ_TIMEOUT_MS = '200';
  delete require.cache[key];
  const fast = require('../src/channels/sessions-async');
  if (saved === undefined) delete process.env.OLMA_SESSIONS_READ_TIMEOUT_MS; else process.env.OLMA_SESSIONS_READ_TIMEOUT_MS = saved;
  delete require.cache[key];
  try {
    assert.equal(fast.CALL_TIMEOUT_MS, 200);
    // Sanity: the hook is live in the worker (a short stall completes).
    assert.equal(await fast._call('__stall', [10]), 'stalled');
    const t0 = Date.now();
    await assert.rejects(fast._call('__stall', [1500]), /did not return within 200ms; worker replaced/);
    assert.ok(Date.now() - t0 < 1_000, 'gave up on the deadline, not on the stall ending');
    // The replacement worker answers, and reads the real fixture.
    assert.equal((await fast.listSessionsForAgent(AGENT)).length, 1);
  } finally {
    await fast.close();
  }
});

test('an idle worker sheds itself, and the next call simply starts another', async () => {
  // Measured (see the module header): an unref'd worker still holds the loop
  // through its MessagePort, so the idle shutdown is what lets a one-off
  // script or a test process exit. Shown here by watching that handle go.
  const key = require.resolve('../src/channels/sessions-async');
  const saved = process.env.OLMA_SESSIONS_WORKER_IDLE_MS;
  process.env.OLMA_SESSIONS_WORKER_IDLE_MS = '150';
  delete require.cache[key];
  const brief = require('../src/channels/sessions-async');
  if (saved === undefined) delete process.env.OLMA_SESSIONS_WORKER_IDLE_MS; else process.env.OLMA_SESSIONS_WORKER_IDLE_MS = saved;
  delete require.cache[key];
  const ports = () => process.getActiveResourcesInfo().filter((r) => r === 'MessagePort').length;
  try {
    assert.equal(brief.IDLE_MS, 150);
    const before = ports();
    assert.equal((await brief.listSessionsForAgent(AGENT)).length, 1);
    assert.equal(ports(), before + 1, 'a live worker holds one MessagePort');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(ports(), before, 'gone after the idle window');
    // Respawn is invisible to the caller.
    assert.equal((await brief.listSessionsForAgent(AGENT)).length, 1);
  } finally {
    await brief.close();
  }
});

test('the hook is inert without the switch — production workers do not stall on request', async () => {
  const key = require.resolve('../src/channels/sessions-async');
  const saved = process.env.OLMA_SESSIONS_WORKER_TEST_HOOKS;
  delete process.env.OLMA_SESSIONS_WORKER_TEST_HOOKS;
  delete require.cache[key];
  const plain = require('../src/channels/sessions-async');
  delete require.cache[key];
  try {
    // The worker is spawned by the first call, so the switch has to be OFF
    // until then — it copies its env at birth.
    await assert.rejects(plain._call('__stall', [10]), /sessions\.__stall is not a function/);
  } finally {
    process.env.OLMA_SESSIONS_WORKER_TEST_HOOKS = saved;
    await plain.close();
  }
});
