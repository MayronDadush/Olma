'use strict';
// The 2026.8.1 gateway upgrade deleted sessions.json and every *.jsonl
// transcript, moving both into agents/<id>/agent/openclaw-agent.sqlite —
// which silently blinded every consumer of channels/sessions.js at once
// (intake discovery, usage attribution, fact extraction, the unanswered
// nets, the dashboard's conversation view). These tests pin the sqlite
// reading mode against a fixture DB shaped exactly like the live one
// (schema and entry/event shapes verified on the box, 2026-08-31).
//
// The legacy file mode keeps its coverage through every OTHER test file's
// fixtures — the dual mode means none of them changed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const sessions = require('../src/channels/sessions');

let HOME_DIR, PREV_HOME;
const AGENT = 'u-sq';
const PEER = '+972595990001';
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';

function agentDir(...parts) { return path.join(HOME_DIR, 'agents', AGENT, ...parts); }

function seedDb(rows) {
  fs.mkdirSync(agentDir('agent'), { recursive: true });
  fs.mkdirSync(agentDir('sessions'), { recursive: true }); // pointers live here on the box
  const db = new DatabaseSync(agentDir('agent', 'openclaw-agent.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_nodes (
      session_key TEXT NOT NULL PRIMARY KEY,
      current_session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcript_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
  `);
  const node = db.prepare(
    'INSERT OR REPLACE INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?,?,?,?)');
  for (const n of rows.nodes || []) node.run(n.key, n.sessionId, JSON.stringify(n.entry), n.entry.updatedAt || 0);
  const ev = db.prepare(
    'INSERT OR REPLACE INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?,?,?,?)');
  for (const e of rows.events || []) ev.run(e.sessionId, e.seq, JSON.stringify(e.event), e.at || 0);
  db.close();
}

function msg(role, text, { at = '2026-08-31T10:00:00.000Z', usage = null, extra = {} } = {}) {
  return {
    type: 'message', timestamp: at,
    message: { role, content: [{ type: 'text', text }], ...(usage ? { usage } : {}), ...extra },
  };
}

before(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-sq-'));
  PREV_HOME = process.env.OLMA_OPENCLAW_HOME;
  process.env.OLMA_OPENCLAW_HOME = HOME_DIR;

  const now = Date.now();
  seedDb({
    nodes: [
      {
        key: `agent:${AGENT}:whatsapp:direct:${PEER}`,
        sessionId: SESSION,
        entry: {
          sessionId: SESSION, updatedAt: now, lastInteractionAt: now - 60_000,
          model: 'deepseek/deepseek-v4-flash', totalTokens: 35660, estimatedCostUsd: 0.0006,
        },
      },
      // the non-peer key shape the live index also carries; parseKey refuses
      // it, and the listing must simply skip it rather than throw
      { key: `agent:${AGENT}:main`, sessionId: 'other-session', entry: { sessionId: 'other-session', updatedAt: 1 } },
    ],
    events: [
      { sessionId: SESSION, seq: 0, event: { type: 'session', version: 3, id: SESSION } },
      { sessionId: SESSION, seq: 1, event: msg('user', 'מה שלומך?', { at: '2026-08-31T10:00:00.000Z' }) },
      // a pure tool-call assistant turn — no visible text, must be dropped
      {
        sessionId: SESSION, seq: 2,
        event: { type: 'message', timestamp: '2026-08-31T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'olma__turn_start' }] } },
      },
      {
        sessionId: SESSION, seq: 3,
        event: msg('assistant', 'הכל טוב!', {
          at: '2026-08-31T10:00:10.000Z',
          usage: { input: 251, output: 81, cacheRead: 35328, cacheWrite: 0, cost: { total: 0 } },
          extra: { responseModel: 'deepseek/deepseek-v4-flash' },
        }),
      },
      { sessionId: SESSION, seq: 4, event: msg('user', 'תודה רבה', { at: '2026-08-31T10:01:00.000Z' }) },
    ],
  });
});
after(() => {
  if (PREV_HOME === undefined) delete process.env.OLMA_OPENCLAW_HOME;
  else process.env.OLMA_OPENCLAW_HOME = PREV_HOME;
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
});

// ---- the session index ------------------------------------------------------

test('listSessionsForAgent reads session_nodes when sessions.json is gone', () => {
  const list = sessions.listSessionsForAgent(AGENT);
  assert.equal(list.length, 1); // the un-parseable "main" key is skipped, not fatal
  const s = list[0];
  assert.equal(s.channel, 'whatsapp');
  assert.equal(s.chatType, 'direct');
  assert.equal(s.peer, PEER);
  assert.equal(s.sessionId, SESSION);
  assert.equal(s.totalTokens, 35660);
  assert.ok(s.ageMs >= 0, 'ageMs derives from lastInteractionAt');
});

test('an agent with neither sessions.json nor a sqlite store lists as empty, not an error', () => {
  fs.mkdirSync(path.join(HOME_DIR, 'agents', 'u-empty'), { recursive: true });
  assert.deepEqual(sessions.listSessionsForAgent('u-empty'), []);
});

// ---- reading the conversation ----------------------------------------------

test('readRecentMessages returns the visible turns from transcript_events', () => {
  const msgs = sessions.readRecentMessages(AGENT, 10, undefined, PEER);
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [
    ['user', 'מה שלומך?'],
    ['assistant', 'הכל טוב!'],
    ['user', 'תודה רבה'],
  ]);
  assert.equal(msgs[2].at, '2026-08-31T10:01:00.000Z');
});

test('readPeerUserText joins only the user side, sqlite mode', () => {
  assert.equal(sessions.readPeerUserText(AGENT, PEER), 'מה שלומך?\nתודה רבה');
  assert.equal(sessions.readPeerUserText(AGENT, '+972590000000'), null);
});

// ---- cost accounting --------------------------------------------------------

test('listTranscripts exposes sqlite sessions with event-count sizes', () => {
  const t = sessions.listTranscripts().filter((x) => x.agentId === AGENT);
  assert.equal(t.length, 1);
  assert.equal(t[0].sessionId, SESSION);
  assert.equal(t[0].file, `sqlite:${AGENT}:${SESSION}`);
  assert.equal(t[0].size, 5); // max(seq) + 1
});

test('readTranscriptUsage reads billable calls incrementally by seq', () => {
  const file = `sqlite:${AGENT}:${SESSION}`;
  const first = sessions.readTranscriptUsage(file, 0);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].model, 'deepseek/deepseek-v4-flash');
  assert.equal(first.calls[0].cacheRead, 35328);
  assert.equal(first.offset, 5);
  // the watermark holds: nothing is ever charged twice
  const second = sessions.readTranscriptUsage(file, first.offset);
  assert.deepEqual(second, { calls: [], offset: 5 });
});

test('a byte-era watermark skips forward instead of re-charging history', () => {
  // Before the store migration this session's snapshot held a BYTE offset —
  // always far larger than the event count. Re-reading from zero would
  // re-attribute every call the file era already charged, so the watermark
  // must jump to "now" and read nothing.
  const r = sessions.readTranscriptUsage(`sqlite:${AGENT}:${SESSION}`, 480_000);
  assert.deepEqual(r, { calls: [], offset: 5 });
});

test('a sqlite path for a missing agent loses nothing and moves nothing', () => {
  const r = sessions.readTranscriptUsage('sqlite:u-gone:some-session', 3);
  assert.deepEqual(r, { calls: [], offset: 3 });
});

// ---- display-name backfill --------------------------------------------------

test('readPeerDisplayName also searches the migration archive of trajectory files', () => {
  const arch = agentDir('session-sqlite-import-archive');
  fs.mkdirSync(arch, { recursive: true });
  const prompt = 'Conversation info (untrusted metadata)\n```json\n'
    + JSON.stringify({ sender: 'דנה לוי', sender_id: PEER.replace('+', '') })
    + '\n```';
  fs.writeFileSync(
    path.join(arch, `agent_${AGENT}_whatsapp.${SESSION}.trajectory.jsonl.imported-1788204476064`),
    JSON.stringify({ data: { prompt } }) + '\n');
  assert.equal(sessions.readPeerDisplayName(AGENT, PEER), 'דנה לוי');
  assert.equal(sessions.readPeerDisplayName(AGENT, '+972590000000'), null);
});
