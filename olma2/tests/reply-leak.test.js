'use strict';
// The gate between the model's text and somebody's phone.
//
// The founding case is Yahav's, 2026-09-10 08:28: he asked for a reminder at
// 13:00, the reminder was armed correctly, and what arrived was the model
// working out whether it had been — our column names, an ISO instant, a
// paragraph about the turn context, in English, about him in the third person.
// It is replayed here whole, exactly as it reached his phone, because a check
// whose failure cannot be written down is one nobody will trust in six weeks.
//
// The second case is the one this repo already recorded and could not stop:
// two English paragraphs of working notes above a Hebrew answer (2026-09-07).
// That one must lose the notes and KEEP the answer, which is the whole reason
// the rule is "everything up to the last dropping line" and not "cancel".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const leak = require('../src/domain/reply-leak');
const hebrewQuality = require('../src/domain/hebrew-quality');
const { createBrokerServer } = require('../src/brokerd/server');
const { resendableVerbatim } = require('../src/jobs/unanswered');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `reply-leak-plugin-test-${process.pid}.log`);

let db, broker, plugin;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }) });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });

// Yahav's message, as delivered. The last line is the sentinel the whole thing
// was building towards: the model had decided there was nothing to say, and
// said all of that instead.
const YAHAV = [
  'הם אמרו 13:00 — due_at נקבע ל-13:00. remind_at שמרתי 13:00, שזה הזמן שהם אמרו — לא צריך להזכיר לפני, זה בדיוק בשעה שהם ביקשו. The reminder is set for 13:00 their time.',
  '',
  "Wait, let me re-check — remind_at was set to 2026-09-10T10:00:00Z which is 13:00 in Asia/Jerusalem. That's correct — the reminder will fire at 13:00 exactly as they asked. And due_at also at 13:00. Good.",
  '',
  "The hints say a 👍 was placed and the reminder is armed for the hour they named, so nothing to add — unless there's an undelivered reply from before.",
  '',
  'Looking at the turn context: it says one of their recent messages was read but produced no reply. The only message I see in this session is theirs.',
  '',
  'NO_REPLY',
].join('\n');

// The 2026-09-07 shape: notes first, the message last.
const NOTES_ABOVE = [
  'I see they replied about the credit card. Let me check what due_at was stored for that task before answering.',
  'The task is there and the reminder is armed.',
  '',
  'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏',
].join('\n');

// Ordinary messages, the shapes Olma really sends. None of them may move.
const ORDINARY = [
  'סגור, אזכיר לך ב-13:00 🙏',
  'רשמתי לך: לבטל את האשראי, היום ב-13:00.',
  'בוקר טוב! יש לך היום פגישה ב-11:00 ושתי משימות פתוחות.',
  'Got it — I will remind you at 13:00 today.',
  'הנה קישור לחיפוש: https://www.google.com/search?q=bank_leumi+service_hours',
  'ביטלתי את התזכורת. משהו נוסף?',
  'כתבת "due_at" — לא בטוחה שהבנתי, תוכל לנסח מחדש?',
  'אשמח לעזור. מתי נוח לך?',
];

test('Yahav\'s message: every paragraph of the working-out is found, and nothing was left to deliver', () => {
  const v = leak.gateReply(YAHAV);
  assert.equal(v.action, 'cancel');
  assert.equal(v.text, '');
  // What each paragraph was caught by, in the order it appears. The third
  // paragraph carries no marker of its own — it is dropped because a LATER
  // line does, which is the rule this case exists to hold open.
  assert.deepEqual(v.reported.map((l) => `${l.line}:${l.kind}:${l.at}`), [
    '0:internal:due_at',
    '2:internal:remind_at',
    '2:instant:2026-09-10T10:00:00Z',
    '6:block:turn context',
    '8:sentinel:NO_REPLY',
  ]);
  assert.ok(v.leaks.length >= 4, 'all of them changed the message');
});

test('notes above an answer lose the notes and keep the answer', () => {
  const v = leak.gateReply(NOTES_ABOVE);
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏');
});

test('an ordinary reply is delivered byte for byte', () => {
  for (const text of ORDINARY) {
    const v = leak.gateReply(text);
    assert.equal(v.action, 'pass', `moved: ${text} → ${JSON.stringify(v)}`);
    assert.equal(v.text, text);
    assert.deepEqual(v.leaks, []);
  }
});

// The sentinel is the one marker that never drops its line, because
// jobs/unanswered.js reads "בוצע NO_REPLY" as a real reply on purpose (the
// doctrine says the words in front of it are delivered). A gate that cancelled
// it would delete the one word the person was owed.
test('the silence sentinel: alone it is a decision, with words it is a stray token', () => {
  assert.deepEqual(leak.gateReply('NO_REPLY'), { action: 'pass', text: 'NO_REPLY', leaks: [], reported: [] });
  assert.deepEqual(leak.gateReply('  NO_REPLY\n').action, 'pass');
  const v = leak.gateReply('בוצע NO_REPLY');
  assert.equal(v.action, 'trim');
  assert.equal(v.text, 'בוצע');
  assert.equal(leak.gateReply('NO_REPLY\n\nNO_REPLY').action, 'cancel');
});

// The wide tier. Every internal name nobody has thought of is this shape — and
// so is a word a developer might have put in a task title, which is why it is
// reported and delivered rather than dropped. The audit row is where the next
// addition to the closed list comes from.
test('an unknown snake_case identifier is reported and still delivered', () => {
  const v = leak.gateReply('סיימתי את user_service, מה הלאה?');
  assert.equal(v.action, 'pass');
  assert.equal(v.text, 'סיימתי את user_service, מה הלאה?');
  assert.deepEqual(v.reported, [{ kind: 'identifier', at: 'user_service', line: 0 }]);
  assert.deepEqual(v.leaks, []);
  // and it never fires inside a link, an address or a quotation
  for (const t of ['ראה https://x.co/a_b/c_d', 'שלח ל-first_last@example.com', 'אמרת "hold_reason" נכון?']) {
    assert.deepEqual(leak.gateReply(t).reported, [], t);
  }
});

// A frame marker can BE a live credential, so the phrase that tripped the
// detector is redacted before anything writes it down (domain/token-leak.js
// learned this first).
test('a leaked identity token cancels the message and is never written down in the clear', () => {
  const tok = `olma_tok_${'a1b2c3d4'.repeat(4)}`;
  const v = leak.gateReply(`{"name": "olma_add_task", "olma_identity": "${tok}"}`);
  assert.equal(v.action, 'cancel');
  const written = JSON.stringify(v.reported);
  assert.ok(!written.includes(tok), 'the token is not in the finding');
  assert.match(written, /olma_\*\*\*|frame/);
  // hebrew-quality reads the same frame markers from this module now, so the
  // daily count and the delivery gate can never disagree about what a frame is
  assert.equal(hebrewQuality.MARKUP_RE, leak.FRAME_RE);
  assert.ok(hebrewQuality.flawsIn(`שלום <|tool_calls|>`).some((f) => f.kind === 'markup'));
});

// The plugin carries a port of domain/reply-leak.js because it loads in the
// gateway's own loader with nothing of ours beside it. This is what keeps the
// two from drifting: one corpus, both implementations, first disagreement wins.
test('the gateway plugin\'s copy and the domain module answer identically', () => {
  const corpus = [YAHAV, NOTES_ABOVE, ...ORDINARY, 'NO_REPLY', 'בוצע NO_REPLY', '', '   ',
    'סיימתי את user_service', 'DELIVERY: say good morning', 'הפגישה ב-2026-09-10T10:00:00Z',
    'Conversation info (untrusted metadata)', 'turn_start returned proceed'];
  assert.deepEqual(plugin.INTERNAL_NAMES, leak.INTERNAL_NAMES, 'the closed lists are the same list');
  for (const text of corpus) {
    assert.deepEqual(plugin.gateReply(text), leak.gateReply(text), `disagreed on: ${JSON.stringify(text)}`);
    assert.deepEqual(plugin.leaksIn(text), leak.leaksIn(text), `disagreed on: ${JSON.stringify(text)}`);
  }
});

// ---- the hook itself -------------------------------------------------------

function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = { on(ev, fn) { h[ev] = fn; return s; }, write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); }, end() { h.close && h.close(); }, destroy() {} };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}
const gateHandler = (reply = { id: 1, ok: true, filed: true }, log = () => {}) => {
  const { connect, sent } = fakeConnect(reply);
  return { handler: plugin.buildReplyGateHandler({ connect, log }), sent };
};
const KEY = 'agent:u-3:whatsapp:direct:+972500000000';

test('the hook cancels a reply that is only the working-out, and files it without the text', async () => {
  const log = [];
  const { handler, sent } = gateHandler(undefined, (o) => log.push(o));
  const out = await handler({ payload: { text: YAHAV }, sessionKey: KEY, channel: 'whatsapp' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_reply_leak' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'reply_gate');
  assert.equal(sent[0].params.action, 'cancel');
  assert.equal(sent[0].params.agentId, 'u-3');
  assert.ok(!JSON.stringify(sent).includes('Asia/Jerusalem'), 'the message never leaves the gateway');
  assert.deepEqual(sent[0].params.leaks.map((l) => l.kind), ['internal', 'internal', 'instant', 'block', 'sentinel']);
  assert.equal(log.at(-1).action, 'cancel');
});

test('the hook trims narration off the front and delivers the rest', async () => {
  const { handler, sent } = gateHandler();
  const payload = { text: NOTES_ABOVE, replyToId: '3EB0X' };
  const out = await handler({ payload, sessionKey: KEY }, {});
  assert.deepEqual(out, { payload: { text: 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏', replyToId: '3EB0X' } });
  assert.equal(sent[0].params.action, 'trim');
});

test('an ordinary reply never touches brokerd and is returned untouched', async () => {
  const { handler, sent } = gateHandler();
  for (const text of ORDINARY) {
    assert.equal(await handler({ payload: { text }, sessionKey: KEY }, {}), undefined, text);
  }
  assert.equal(sent.length, 0, 'the normal path costs no socket at all');
});

// The raw pipe sends as `main` and carries the owner's own wording with no
// model in the path (channels/openclaw.sendRawMessage) — a gate there could
// only ever do harm. Everything that puts MODEL output in front of somebody is
// covered, group agents and the intake greeter included.
test('the gate covers every agent that speaks with a model, and nothing that does not', async () => {
  const { handler, sent } = gateHandler();
  const gated = ['agent:u-3:whatsapp:direct:+1', 'agent:u-41:whatsapp:direct:+1',
    'agent:g-2:whatsapp:group:1@g.us', 'agent:ggreet:whatsapp:direct:+1'];
  for (const key of gated) {
    assert.deepEqual(await handler({ payload: { text: YAHAV }, sessionKey: key }, {}), { cancel: true, reason: 'olma_reply_leak' }, key);
  }
  const n = sent.length;
  for (const key of ['agent:main:whatsapp:direct:+1', 'agent:intake:whatsapp:direct:+1', '', 'nonsense']) {
    assert.equal(await handler({ payload: { text: YAHAV }, sessionKey: key }, {}), undefined, key);
  }
  assert.equal(sent.length, n, 'and nothing was filed for them');
  // the session key off the context when the event has none
  assert.ok(await handler({ payload: { text: YAHAV } }, { sessionKey: KEY }));
});

// A schedule card is not the thing that leaked. Cancelling would take it with
// the words, so the words go and the card lands.
test('a payload with media loses its caption instead of the whole delivery', async () => {
  const { handler } = gateHandler();
  const payload = { text: YAHAV, mediaUrls: ['/tmp/card.png'] };
  assert.deepEqual(await handler({ payload, sessionKey: KEY }, {}), { payload: { text: '', mediaUrls: ['/tmp/card.png'] } });
});

// A gate that can delay or break a reply is worse than no gate — but a gate
// that stops working the moment brokerd hiccups is not a gate at all. So the
// decision is local and only the REPORT needs the socket.
test('the hook still gates when brokerd is unreachable, and fails open on its own error', async () => {
  const log = [];
  const dead = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} }; setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0); return s; };
  const handler = plugin.buildReplyGateHandler({ connect: dead, log: (o) => log.push(o) });
  assert.deepEqual(await handler({ payload: { text: YAHAV }, sessionKey: KEY }, {}), { cancel: true, reason: 'olma_reply_leak' });
  assert.equal(log.at(-1).filed, false, 'and says so');
  // a payload shape it does not understand is not a reply it may cancel
  const { handler: h2 } = gateHandler();
  assert.equal(await h2({ payload: { text: null }, sessionKey: KEY }, {}), undefined);
  assert.equal(await h2({ sessionKey: KEY }, {}), undefined);
  assert.equal(await h2(null, null), undefined);
});

// ---- brokerd's side --------------------------------------------------------

const gateCall = (params) => broker.dispatch({ id: 1, method: 'reply_gate', params });

test('brokerd files the gate\'s report against the person, with the finding and never the message', async () => {
  const u = await makeUser(db.pool, '+972500999001');
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, 'u-801']);
  assert.deepEqual(await gateCall({
    agentId: 'u-801', sessionKey: 'agent:u-801:whatsapp:direct:+972500999001', action: 'cancel',
    channel: 'whatsapp', chars: 812, kept: 0,
    leaks: [{ kind: 'internal', at: 'due_at', line: 0 }, { kind: 'instant', at: '2026-09-10T10:00:00Z', line: 2 }],
  }), { ok: true, filed: true });
  const { rows } = await db.pool.query(
    `SELECT actor_id, detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.equal(Number(rows[0].actor_id), u.id);
  assert.equal(rows[0].detail.action, 'cancel');
  assert.equal(rows[0].detail.chars, 812);
  assert.deepEqual(rows[0].detail.kinds, ['internal', 'instant']);
  assert.equal(rows[0].detail.leaks[0].at, 'due_at');
  // a group agent has no user row behind it and the row is still the record
  assert.deepEqual(await gateCall({ agentId: 'ggreet', action: 'pass', leaks: [{ kind: 'identifier', at: 'user_service', line: 0 }] }), { ok: true, filed: true });
  const { rows: g } = await db.pool.query(
    `SELECT actor_id, detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.equal(g[0].actor_id, null);
  assert.equal(g[0].detail.agentId, 'ggreet');
});

test('brokerd refuses a report it cannot place, and redacts a token the plugin somehow did not', async () => {
  assert.equal((await gateCall({ agentId: 'main', action: 'cancel' })).ok, false);
  assert.equal((await gateCall({ agentId: '../x', action: 'cancel' })).ok, false);
  assert.equal((await gateCall({ agentId: 'u-801', action: 'send-it' })).ok, false);
  const tok = `olma_tok_${'9f8e7d6c'.repeat(4)}`;
  await gateCall({ agentId: 'u-801', action: 'cancel', leaks: [{ kind: 'frame', at: tok, line: 0 }] });
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'reply.gated' ORDER BY id DESC LIMIT 1`);
  assert.ok(!JSON.stringify(rows[0].detail).includes(tok));
});

// The gateway logs "no queued reply payloads" for a payload a HOOK cancelled,
// exactly as it does for a turn it swallowed — so without this the gate would
// manufacture the repair sweep's founding case on every message it stops,
// and a model turn would go and answer a message that was answered correctly.
test('a reply the gate cancelled is not a swallowed turn', () => {
  const laneLog = require('../src/jobs/lane-watchdog');
  const line = (messageId, cause) => JSON.stringify({
    time: new Date().toISOString(),
    message: 'visible channel turn dispatched with no queued reply payloads: '
      + `channel=whatsapp messageId=${messageId} sessionKey=${KEY} cause=${cause}`,
  });
  assert.deepEqual(laneLog.parseDroppedTurns(line('SWALLOWED1', 'completed')).map((d) => d.messageId), ['SWALLOWED1']);
  for (const cause of ['suppressed:cancelled_by_reply_payload_sending_hook', 'suppressed:empty_after_reply_payload_sending_hook']) {
    assert.deepEqual(laneLog.parseDroppedTurns(line('GATED1', cause)), [], cause);
  }
});

// ---- shipped is not running ------------------------------------------------
// Plugin code loads at gateway STARTUP and deploy.sh does not restart the
// gateway, so a merged gate is inert until somebody does — the state in which
// the suite is green, the code is on the box, and Yahav's message can happen
// again. The plugin stamps what it actually registered; config_guard reads it.
test('config_guard says when the running gateway predates the reply gate, and stays quiet when it cannot tell', async () => {
  const configGuard = require('../src/jobs/config-guard');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-gate-stamp-'));
  const file = path.join(dir, 'turn-context-plugin.registered');
  // what a gateway running today's plugin writes
  const on = [];
  plugin.default.register({ pluginConfig: {}, on: (name, fn) => on.push([name, fn]) });
  plugin.stampRegistration({ agents: 'all', hooks: on.map(([name]) => name) }, file);
  assert.deepEqual(configGuard.checkReplyGateLive({ registerStampPath: file }), { violations: [], skipped: null });
  assert.match(String(fs.readFileSync(file, 'utf8')), /reply_payload_sending/);
  // a gateway still running the build from before it
  plugin.stampRegistration({ agents: 'all', hooks: ['before_prompt_build', 'llm_input'] }, file);
  const stale = configGuard.checkReplyGateLive({ registerStampPath: file });
  assert.equal(stale.violations.length, 1);
  assert.match(stale.violations[0], /before the reply gate/);
  assert.match(stale.violations[0], /systemctl --user restart openclaw-gateway/);
  assert.equal(configGuard.breaksUsers(stale.violations[0]), false, 'nobody\'s tools are failing — a dashboard row');
  // overwritten, never appended: one file, one answer, however busy the box
  assert.equal(String(fs.readFileSync(file, 'utf8')).trim().split('\n').length, 1);
  // could not read is not a thing in trouble, and it says so rather than passing
  const missing = configGuard.checkReplyGateLive({ registerStampPath: path.join(dir, 'nope') });
  assert.deepEqual(missing.violations, []);
  assert.match(missing.skipped, /unreadable/);
  fs.writeFileSync(file, 'not json\n');
  assert.match(configGuard.checkReplyGateLive({ registerStampPath: file }).skipped, /unparseable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The gate creates the exact fingerprint the repair sweep reads as a delivery
// fault: an assistant turn in the transcript with no `Sent` line behind it. It
// must not put back what the gate has just kept off somebody's phone — and the
// raw pipe it would use has no gate in it at all.
test('a cancelled reply is never re-sent verbatim by the repair sweep', () => {
  assert.deepEqual(resendableVerbatim(YAHAV), { ok: false, why: 'leak' });
  assert.deepEqual(resendableVerbatim(NOTES_ABOVE), { ok: true, gated: true, text: 'סגור, אזכיר לך היום ב-13:00 לבטל את האשראי 🙏' });
  assert.deepEqual(resendableVerbatim('סגור, אזכיר לך ב-13:00 🙏'), { ok: true, text: 'סגור, אזכיר לך ב-13:00 🙏' });
  assert.deepEqual(resendableVerbatim('בוצע NO_REPLY'), { ok: true, gated: true, text: 'בוצע' });
  assert.deepEqual(resendableVerbatim('  '), { ok: false, why: 'empty' });
  assert.deepEqual(resendableVerbatim('הנה\nMEDIA: /tmp/x.png'), { ok: false, why: 'media' });
});
