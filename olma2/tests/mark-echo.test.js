'use strict';
// A reply that only restates the 👍 already on their message
// (domain/mark-echo.js). The founding case is Miron, 2026-09-30 23:36: the
// add_task result carried `hints.markPlaced` and nothing else, and the model
// still wrote "רשמתי: לעשות את הסרטון לגוגל בשביל היומן 👍" under the 👍.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const { withTx } = require('../src/db/pool');
const echo = require('../src/domain/mark-echo');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `mark-echo-plugin-test-${process.pid}.log`);

let plugin;
before(async () => { plugin = await import('../gateway-plugin/olma-turn/index.js'); });

const TITLE = 'לעשות את הסרטון לגוגל בשביל היומן';

// [reply, what the marked tool wrote]
const ECHOES = [
  // Miron's, byte for byte
  ['רשמתי: לעשות את הסרטון לגוגל בשביל היומן 👍', [TITLE]],
  ['הוספתי לרשימה ✅', [TITLE]],
  ['בוצע 👍', [TITLE]],
  ['👍', [TITLE]],
  ['סגור, רשמתי לך', [TITLE]],
  ['נוסף: "לקנות חלב"', ['לקנות חלב']],
  // a prefix on a word of the title is still the title
  ['רשמתי ולקנות חלב', ['לקנות חלב']],
  ['רשמתי את הסרטון', ['סרטון לגוגל']],
  ["Done — I've added it to your list", ['buy milk']],
  ['Added: buy milk ✅', ['buy milk']],
  // a digit the title itself holds is the title
  ['רשמתי: להתקשר ל-3 ספקים', ['להתקשר ל-3 ספקים']],
  // their OWN words are known too: "מחר" they said is not news to them
  ['רשמתי לקנות חלב מחר', ['לקנות חלב', 'תוסיף לי לקנות חלב מחר']],
  ['רשמתי: לעשות את הסרטון לגוגל בשביל היומן', ['תוסיף לי משימה לעשות את הסרטון לגוגל בשביל היומן']],
];

// Every one of these says something the mark cannot.
const NOT_ECHOES = [
  // when
  ['רשמתי למחר', [TITLE]],
  ['רשמתי, אזכיר לך ב-10:00', [TITLE]],
  ['רשמתי: להתקשר ל-4 ספקים', ['להתקשר ל-3 ספקים']],
  // a question
  ['רשמתי. רוצה שאזכיר לך?', [TITLE]],
  ['הוספתי?', [TITLE]],
  // a caveat, a correction, a category Olma chose
  ['רשמתי, אבל אין לזה תאריך', [TITLE]],
  ['רשמתי תחת עבודה', [TITLE]],
  // a link
  ['רשמתי https://allma.world/me', [TITLE]],
  // too long to be only an echo
  ['רשמתי\nלעשות את הסרטון\nלגוגל', [TITLE]],
  [`רשמתי ${'לעשות את הסרטון '.repeat(20)}`, [TITLE]],
  // a word the title does not hold, even a short one
  ['רשמתי את הסרטון החדש', [TITLE]],
  ['', [TITLE]],
  // nothing written: only filler is an echo, but a word of a title we were
  // not handed is not
  ['רשמתי לעשות סרטון', []],
  // "מחר" they did NOT say is Olma's reading, and they should see it
  ['רשמתי למחר', [TITLE, 'תוסיף לי משימה לעשות את הסרטון לגוגל בשביל היומן']],
  // a second request in the same message: its answer has words of its own
  ['רשמתי. מחר יש לך פגישה עם דנה', ['לקנות חלב', 'תוסיף לקנות חלב ומה יש לי מחר']],
];

test('an echo is the title and a save word and nothing else; one new word lets it through', () => {
  for (const [text, vocab] of ECHOES) assert.equal(echo.echoOnly(text, vocab), true, text);
  for (const [text, vocab] of NOT_ECHOES) assert.equal(echo.echoOnly(text, vocab), false, text);
});

// The plugin's copy is the one that runs (.claude/rules/turns-and-replies.md,
// "The plugin carries a PORT of domain/reply-leak.js").
test('the gateway plugin\'s port answers exactly as the domain module does', () => {
  for (const [text, vocab] of [...ECHOES, ...NOT_ECHOES]) {
    assert.equal(plugin.echoOnly(text, vocab), echo.echoOnly(text, vocab), text);
    assert.equal(plugin.echoCandidate(text), echo.echoCandidate(text), text);
  }
  assert.deepEqual([...plugin.ECHO_FILLER].sort(), [...echo.FILLER].sort());
});

test('the words come from what the person asked to be written — never a hint, never a category', () => {
  const words = echo.vocabOf({
    task: { id: 7, title: TITLE, category: 'עבודה', due_at: '2026-10-01T07:00:00Z', kind: 'todo' },
    hints: { markPlaced: 'A 👍 has already been put on their message', title: 'not this' },
  });
  assert.deepEqual(words, [TITLE]);
  assert.deepEqual(echo.vocabOf({ tasks: [{ title: 'א' }, { title: 'ב' }] }), ['א', 'ב']);
  assert.deepEqual(echo.vocabOf(null), []);
});

// ── through brokerd and the gate ─────────────────────────────────────────────

let db, broker, now;
before(async () => {
  db = await freshDb();
  now = Date.now();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: true }), now: () => now });
});
after(async () => { if (db) await db.teardown(); });

let seq = 0;
async function agentUser() {
  seq += 1;
  const u = await makeUser(db.pool, `+9726440${String(seq).padStart(4, '0')}`, { firstName: 'Miron' });
  const agentId = `u-${970 + seq}`;
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, agentId]);
  return { ...u, agentId };
}
const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null });
const call = (u, name, args, turn) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { identity_token: u.identity_token, ...args } } }, turn);
const held = (u) => broker.dispatch({ id: 1, method: 'mark_echo', params: { agentId: u.agentId } });

test('brokerd holds what the 👍-earning tool wrote, and forgets it the moment a sentence could be worth saying', async () => {
  const u = await agentUser();
  assert.deepEqual(await held(u), { ok: true, standing: false }, 'nothing marked yet');

  const turn = newTurn();
  await call(u, 'turn_start', { message_id: '3EB0ECHO0001' }, turn);
  const added = await call(u, 'add_task', { title: TITLE }, turn);
  assert.match(added.text, /markPlaced/);
  const h = await held(u);
  assert.equal(h.standing, true);
  assert.deepEqual(h.words, [TITLE]);

  // A tool with no 👍 after it — the model went and read something — may have
  // given it something to say.
  await call(u, 'list_my_tasks', {}, turn);
  assert.equal((await held(u)).standing, false);

  // …and it does not outlive its window.
  const turn2 = newTurn();
  await call(u, 'turn_start', { message_id: '3EB0ECHO0002' }, turn2);
  await call(u, 'add_task', { title: 'לקנות חלב' }, turn2);
  assert.equal((await held(u)).standing, true);
  now += 6 * 60 * 1000;
  assert.equal((await held(u)).standing, false);

  assert.equal((await broker.dispatch({ id: 1, method: 'mark_echo', params: { agentId: 'main' } })).ok, false);
});

// A fake brokerd for the hook: answers each method from a table and records
// what it was asked.
function fakeBroker(answers) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; return s; },
      write(x) {
        const msg = JSON.parse(x);
        sent.push(msg);
        const reply = answers[msg.method] || { ok: true };
        setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0);
      },
      end() { h.close && h.close(); }, destroy() {},
    };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}
const KEY = 'agent:u-3:whatsapp:direct:+972500000000';
const MIRON = 'רשמתי: לעשות את הסרטון לגוגל בשביל היומן 👍';

test('the gate cancels Miron\'s echo under a standing 👍, and files it without the text', async () => {
  const { connect, sent } = fakeBroker({ mark_echo: { ok: true, standing: true, words: [TITLE] }, reply_gate: { ok: true, filed: true } });
  const handler = plugin.buildReplyGateHandler({ connect, log: () => {} });
  const out = await handler({ payload: { text: MIRON }, sessionKey: KEY, channel: 'whatsapp' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_mark_echo' });
  const report = sent.find((m) => m.method === 'reply_gate');
  assert.equal(report.params.action, 'cancel');
  assert.deepEqual(report.params.leaks.map((l) => l.kind), ['echo']);
  assert.ok(!JSON.stringify(sent).includes('הסרטון'), 'the reply never leaves the gateway');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!sent.some((m) => m.method === 'reply_claim'), 'a reply that never went out claims nothing');
  assert.ok(!sent.some((m) => m.method === 'turn_progress' && m.params.what === 'reply'), 'nothing reached them');
});

test('the gate knows what the person just wrote, from the prompt hook, and nothing older', async () => {
  plugin._resetInbound();
  const promptHook = plugin.buildHandler({ connect: fakeBroker({ turn_context: { ok: true, enabled: false } }).connect, log: () => {} });
  await promptHook({ prompt: 'תוסיף לי לקנות חלב מחר' }, { agentId: 'u-3', sessionKey: KEY });
  assert.equal(plugin.inboundOf('u-3'), 'תוסיף לי לקנות חלב מחר');

  const reply = 'רשמתי לקנות חלב מחר';
  const standing = () => fakeBroker({ mark_echo: { ok: true, standing: true, words: ['לקנות חלב'] }, reply_gate: { ok: true } });
  const gate = (b) => plugin.buildReplyGateHandler({ connect: b.connect, log: () => {} })({ payload: { text: reply }, sessionKey: KEY }, {});
  assert.deepEqual(await gate(standing()), { cancel: true, reason: 'olma_mark_echo' }, '"מחר" was theirs');

  // Without their message the same reply says something new — "מחר" — and goes.
  plugin._resetInbound();
  assert.equal(await gate(standing()), undefined);

  // And their message is forgotten after five minutes.
  plugin.rememberInbound('u-3', 'תוסיף לי לקנות חלב מחר', Date.now() - 6 * 60 * 1000);
  assert.equal(plugin.inboundOf('u-3'), '');
  assert.equal(await gate(standing()), undefined);
  plugin._resetInbound();
});

test('the gate lets the same words through when no 👍 stands, when brokerd is gone, and for a room', async () => {
  const none = fakeBroker({ mark_echo: { ok: true, standing: false } });
  assert.equal(await plugin.buildReplyGateHandler({ connect: none.connect, log: () => {} })(
    { payload: { text: MIRON }, sessionKey: KEY }, {}), undefined);

  const dead = () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await plugin.buildReplyGateHandler({ connect: dead, log: () => {} })(
    { payload: { text: MIRON }, sessionKey: KEY }, {}), undefined, 'a dead socket is not an echo');

  const standing = fakeBroker({ mark_echo: { ok: true, standing: true, words: [TITLE] } });
  const room = 'agent:g-4:whatsapp:group:120363000000000000@g.us';
  assert.equal(await plugin.buildReplyGateHandler({ connect: standing.connect, log: () => {} })(
    { payload: { text: MIRON }, sessionKey: room }, {}), undefined);
  assert.ok(!standing.sent.some((m) => m.method === 'mark_echo'), 'a room has no 👍 of ours to echo');

  // a reply that says something new is never even asked about twice
  const asked = fakeBroker({ mark_echo: { ok: true, standing: true, words: [TITLE] } });
  assert.equal(await plugin.buildReplyGateHandler({ connect: asked.connect, log: () => {} })(
    { payload: { text: 'רשמתי. רוצה שאזכיר לך מחר?' }, sessionKey: KEY }, {}), undefined);
  assert.ok(!asked.sent.some((m) => m.method === 'mark_echo'), 'a question is not a candidate');
});

// The gate's cancel leaves an assistant turn in the transcript with no send
// behind it — case (b)'s whole definition of a lost reply. Without this the
// repair sweep would put the echo back on the phone from the raw pipe.
test('the repair sweep does not re-send an echo the gate cancelled', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const u = await makeUser(db.pool, '+972644009901', { firstName: 'Miron' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  const t = Date.now();
  const ago = (min) => new Date(t - min * 60_000).toISOString();
  const msgs = [
    { role: 'user', text: 'תוסיף לי משימה לעשות את הסרטון לגוגל בשביל היומן', at: ago(10) },
    { role: 'assistant', text: MIRON, at: ago(9) },
  ];
  const sweep = () => withTx(db.pool, (c) => unanswered.sweepUnanswered(c, {
    readDroppedTurns: () => new Map(), readMessages: () => msgs,
    readSentEvents: () => ({ events: [], windows: [{ from: 0, to: Infinity }] }), now: t,
  }));
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, detail, created_at) VALUES ($1, 'reply.gated', $2, $3)`,
    [u.id, { agentId: `u-${u.id}`, action: 'cancel', kinds: ['echo'] }, new Date(t - 9 * 60_000 + 2000).toISOString()]);
  const out = await sweep();
  assert.deepEqual(out.repaired, []);
  const { rows } = await db.pool.query(`SELECT 1 FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 0);

  // the same transcript with no cancel on file is still a lost reply
  await db.pool.query(`DELETE FROM audit_log WHERE actor_id = $1 AND event = 'reply.gated'`, [u.id]);
  assert.deepEqual((await sweep()).repaired, [u.id]);
});
