'use strict';
// A reply that says it saved something, on a turn where nothing was saved
// (domain/phantom-save.js). The founding case is nightly eval #91, 2026-09-25:
// "רשמתי לך הכל" to a brain-dump, and no tool call anywhere in the turn.
// Report-only — every test here is about what gets FILED, and the one about
// the gate is that the reply it was reading goes out untouched.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const selfInitiated = require('../src/domain/self-initiated');
const phantom = require('../src/domain/phantom-save');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `phantom-save-plugin-test-${process.pid}.log`);

let db, broker, now, plugin;
before(async () => {
  db = await freshDb();
  now = Date.now();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }), now: () => now });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });
beforeEach(() => { selfInitiated._reset(); selfInitiated._setGraceMs(0); });

// ---- the words ------------------------------------------------------------

// Claims, each as it would really be written, and the word that should come back.
const CLAIMS = [
  ['רשמתי לך הכל 👍', 'רשמתי'],
  ['סגור, הוספתי לרשימה', 'הוספתי'],
  ['שמרתי את זה ואזכיר לך מחר', 'שמרתי'],
  ['ורשמתי גם את החלב', 'רשמתי'],
  ['קבעתי תזכורת ל-17:00', 'קבעתי'],
  ['עדכנתי את התאריך ליום שלישי', 'עדכנתי'],
  ["Done — I've added it to your list", 'added'],
  ['I have saved that for you', 'saved'],
];
// Not claims: a question, a future, another person's verb, a word that only
// CONTAINS one of ours, and an English "I've" about something else.
const NOT_CLAIMS = [
  'להוסיף את זה לרשימה?',
  'אוסיף את זה מחר בבוקר',
  'הוא רשם את זה אצלו',
  'הרשמתי אותך לשיעור',
  'מה לרשום לך?',
  "I've been thinking about your week",
  'Let me know if that works',
  '',
];

test('a save claimed in the first person is read, in Hebrew and in English, and nothing else is', () => {
  for (const [text, word] of CLAIMS) assert.equal(phantom.claimedWrite(text), word, text);
  for (const text of NOT_CLAIMS) assert.equal(phantom.claimedWrite(text), null, text);
});

// The plugin's copy is the one that runs, and a port nobody holds against its
// original drifts (.claude/rules/turns-and-replies.md, "The plugin carries a
// PORT of domain/reply-leak.js").
test('the gateway plugin\'s port answers exactly as the domain module does', () => {
  for (const [text] of CLAIMS) assert.equal(plugin.claimedWrite(text), phantom.claimedWrite(text), text);
  for (const text of NOT_CLAIMS) assert.equal(plugin.claimedWrite(text), phantom.claimedWrite(text), text);
});

// ---- the verdict ----------------------------------------------------------

test('the verdict: a tool since the open backs it, none leaves it unbacked, and no open is unknown', () => {
  const t = 1_000_000_000;
  assert.equal(phantom.judge({ opens: [t], lastToolAt: t + 5000, now: t + 9000 }).verdict, 'backed');
  assert.equal(phantom.judge({ opens: [t], lastToolAt: t - 5000, now: t + 9000 }).verdict, 'unbacked');
  assert.equal(phantom.judge({ opens: [t], lastToolAt: null, now: t + 9000 }).verdict, 'unbacked');
  // Nothing on file is a restart or a turn this never saw — never "no tool ran".
  assert.equal(phantom.judge({ opens: [], lastToolAt: null, now: t }).verdict, 'unknown');
  assert.equal(phantom.judge({ opens: [t], now: t + phantom.OPEN_WINDOW_MS + 1 }).verdict, 'unknown');
  // A turn Olma started reports an earlier turn's write; it is not judged.
  assert.equal(phantom.judge({ ourTurn: true, opens: [t], now: t + 1 }).verdict, 'ours');
  // Two messages close together: the reply to the first may go out after the
  // second opened, so a tool since the EARLIEST open backs it.
  assert.equal(phantom.judge({ opens: [t, t + 20_000], lastToolAt: t + 10_000, now: t + 30_000 }).verdict, 'backed');
});

// ---- brokerd --------------------------------------------------------------

let seq = 0;
async function agentUser() {
  seq += 1;
  const phone = `+9726430${String(seq).padStart(4, '0')}`;
  const u = await makeUser(db.pool, phone);
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, `u-${950 + seq}`]);
  return { ...u, agentId: `u-${950 + seq}` };
}
const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const open = (u, id) => broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: u.agentId, messageId: id, kind: 'text' } });
const claim = (u, word = 'רשמתי') => broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: u.agentId, word } });
const tool = (u, name) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: u.identity_token } } }, newTurn());
const filed = async (u) => (await db.pool.query(
  `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'reply.claim' ORDER BY id DESC LIMIT 1`, [u.id])).rows[0];

test('brokerd files a claim with no tool behind it as unbacked, and the word — never the reply', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM01');
  now += 8000;
  assert.deepEqual(await claim(u), { ok: true, verdict: 'unbacked' });
  const row = await filed(u);
  assert.equal(row.detail.verdict, 'unbacked');
  assert.equal(row.detail.word, 'רשמתי');
  assert.equal(row.detail.toolAgoMs, null);
  assert.equal(row.detail.openedAgoMs, 8000);
});

test('a tool that ran on the turn backs the claim; turn_start alone does not', async () => {
  const u = await agentUser();
  await open(u, '3EBPHANTOM02');
  now += 1000;
  await tool(u, 'turn_start');
  now += 1000;
  assert.equal((await claim(u)).verdict, 'unbacked', 'turn_start runs on every message and saves nothing');
  await tool(u, 'list_my_tasks');
  now += 1000;
  assert.equal((await claim(u)).verdict, 'backed');
  // A second message inside the window: a tool after the FIRST open still
  // backs a claim, lenient on purpose (see the verdict test)…
  now += 60_000;
  await open(u, '3EBPHANTOM03');
  now += 60_000;
  assert.equal((await claim(u)).verdict, 'backed');
  // …and once the window has moved past that tool, it no longer does.
  now += phantom.OPEN_WINDOW_MS;
  await open(u, '3EBPHANTOM04');
  now += 5000;
  assert.equal((await claim(u)).verdict, 'unbacked');
});

test('a turn Olma started is filed as ours, and a person with no open on file as unknown', async () => {
  const u = await agentUser();
  assert.equal((await claim(u)).verdict, 'unknown', 'a restart that lost the open is not "no tool ran"');
  await open(u, '3EBPHANTOM05');
  selfInitiated.begin(u.id);
  assert.equal((await claim(u)).verdict, 'ours');
  selfInitiated.end(u.id);
  assert.deepEqual(await broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: 'g-4', word: 'רשמתי' } }),
    { ok: false, error: 'bad agentId' });
});

// ---- the gate -------------------------------------------------------------

function fakeConnect() {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; if (ev === 'connect') setTimeout(() => fn(), 0); return s; },
      write(line) { const m = JSON.parse(line); sent.push(m); setTimeout(() => h.data && h.data(JSON.stringify({ id: 1, ok: true }) + '\n'), 0); },
      end() {}, destroy() {},
    };
    return s;
  };
  return { connect, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('the gate tells brokerd the word, sends the reply untouched, and never asks about a room or a cut paragraph', async () => {
  const { connect, sent } = fakeConnect();
  const handler = plugin.buildReplyGateHandler({ connect, log: () => {} });
  const payload = { text: 'רשמתי לך הכל 👍' };
  // `turn_progress` rides every reply a person gets (the held 👀,
  // tests/eyes-delay.test.js); this test is about the claim.
  const claims = () => sent.filter((m) => m.method !== 'turn_progress');
  assert.equal(await handler({ payload, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {}), undefined);
  await settle();
  assert.equal(claims().length, 1);
  assert.equal(claims()[0].method, 'reply_claim');
  assert.deepEqual(claims()[0].params, { agentId: 'u-3', word: 'רשמתי' });
  assert.ok(!JSON.stringify(sent).includes('לך הכל'), 'the reply never leaves the gateway');

  sent.length = 0;
  await handler({ payload, sessionKey: 'agent:g-7:whatsapp:group:120363000000000000@g.us' }, {});
  await handler({ payload: { text: 'אוסיף את זה מחר' }, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {});
  await settle();
  assert.equal(claims().length, 0);
  // and a room has no held 👀 to drop
  assert.deepEqual(sent.map((m) => m.params.agentId), ['u-3']);
  sent.length = 0;
  // A claim inside working-out the gate cancels reaches nobody, so it is not asked about.
  const out = await handler({ payload: { text: 'remind_at שמרתי ל-2026-09-10T10:00:00Z' }, sessionKey: 'agent:u-3:whatsapp:direct:+972500000000' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_reply_leak' });
  await settle();
  // a reply the gate stops reached nobody: no `turn_progress` either
  assert.deepEqual(sent.map((m) => m.method), ['reply_gate']);
});
