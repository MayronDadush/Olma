'use strict';
// A turn that answered NO_REPLY after its tool calls is asked AGAIN by the
// gateway ("settled post-tool turn lacked a final answer"), and the second
// answer used to go out. The founding case is Padel Gang, 2026-10-03 10:40:
// the coordination was settled by hand with one member out, the result said
// to answer NO_REPLY, the model did — and four seconds later the retry wrote
// "כל המשתתפים בתוך" to the room (docs/incidents.md, "The silence the gateway
// asked again").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `after-silence-plugin-test-${process.pid}.log`);

let plugin;
before(async () => { plugin = await import('../gateway-plugin/olma-turn/index.js'); });

const ROOM = 'agent:g-9:whatsapp:group:120363000000000000@g.us';
const PERSON = 'agent:u-10:whatsapp:direct:+972500000000';
const PADEL = 'סגרנו את התיאום להיום ב-17:00, כל המשתתפים בתוך, והיומן עודכן. 🗓️';

function fakeBroker(answers = {}) {
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
const quiet = { log: () => {} };
const said = (sessionKey, runId, texts) =>
  plugin.buildSilenceHandler(quiet)({ assistantTexts: texts, runId }, { sessionKey, runId });

test('a run decided silence only when every text it said was the sentinel', () => {
  assert.equal(plugin.decidedSilence(['NO_REPLY']), true);
  assert.equal(plugin.decidedSilence(['', '  NO_REPLY  ']), true, 'an empty text before the tool call is not a word');
  assert.equal(plugin.decidedSilence([]), false, 'an empty answer is not a decision — its retry is the gateway doing its job');
  assert.equal(plugin.decidedSilence(['', '   ']), false);
  assert.equal(plugin.decidedSilence(['בוצע NO_REPLY']), false, 'words in front of the sentinel are delivered');
  assert.equal(plugin.decidedSilence(['רשמתי', 'NO_REPLY']), false, 'a run that already said something is not silent');
  assert.equal(plugin.decidedSilence(null), false);
});

test('Padel Gang: the retry after the room turn\'s NO_REPLY is cancelled and filed, without the text', async () => {
  plugin._resetSilentRuns();
  await said(ROOM, 'run-padel', ['NO_REPLY']);
  const broker = fakeBroker({ reply_gate: { ok: true, filed: true } });
  const gate = plugin.buildReplyGateHandler({ connect: broker.connect, ...quiet });
  const out = await gate({ payload: { text: PADEL }, sessionKey: ROOM, runId: 'run-padel', channel: 'whatsapp' }, {});
  assert.deepEqual(out, { cancel: true, reason: 'olma_after_silence' });
  const report = broker.sent.find((m) => m.method === 'reply_gate');
  assert.equal(report.params.agentId, 'g-9');
  assert.equal(report.params.action, 'cancel');
  assert.deepEqual(report.params.leaks.map((l) => l.kind), ['after_silence']);
  assert.ok(!JSON.stringify(broker.sent).includes('המשתתפים'), 'the reply never leaves the gateway');

  // The run id rides the hook context on some paths and the event on others.
  plugin._resetSilentRuns();
  await said(ROOM, 'run-ctx', ['NO_REPLY']);
  assert.deepEqual(await gate({ payload: { text: PADEL }, sessionKey: ROOM }, { runId: 'run-ctx' }),
    { cancel: true, reason: 'olma_after_silence' });
});

test('only THAT run is gagged: the next turn, an empty answer\'s retry and a stale record all go out', async () => {
  plugin._resetSilentRuns();
  const gate = plugin.buildReplyGateHandler({ connect: fakeBroker().connect, ...quiet });
  await said(PERSON, 'run-silent', ['NO_REPLY']);
  assert.equal(await gate({ payload: { text: 'מה שלומך?' }, sessionKey: PERSON, runId: 'run-next' }, {}), undefined,
    'a fresh run id is a fresh turn');

  // 2026-09-26 08:30: the first answer was EMPTY and the retry was the list he asked for.
  await said(PERSON, 'run-empty', ['']);
  assert.equal(await gate({ payload: { text: 'הנה מה שיש לך, הקרוב קודם:' }, sessionKey: PERSON, runId: 'run-empty' }, {}), undefined);

  // No run id at all: nothing to match, so the reply goes, as it always did.
  assert.equal(await gate({ payload: { text: 'מה שלומך?' }, sessionKey: PERSON }, {}), undefined);

  plugin._resetSilentRuns();
  plugin.rememberSilentRun('run-old', Date.now() - 3 * 60 * 1000);
  assert.equal(plugin.silentRun('run-old'), false, 'dead after two minutes');
});

test('a card in a silent run still lands; only its words are dropped', async () => {
  plugin._resetSilentRuns();
  await said(PERSON, 'run-card', ['NO_REPLY']);
  const gate = plugin.buildReplyGateHandler({ connect: fakeBroker().connect, ...quiet });
  const payload = { text: 'הנה הלו"ז שלך', mediaUrl: '/tmp/card.png' };
  assert.deepEqual(await gate({ payload, sessionKey: PERSON, runId: 'run-card' }, {}), { payload: { ...payload, text: '' } });
});

test('a session the gate does not watch is never remembered', async () => {
  plugin._resetSilentRuns();
  await said('agent:main:whatsapp:direct:+972500000000', 'run-main', ['NO_REPLY']);
  assert.equal(plugin.silentRun('run-main'), false);
});

test('the plugin listens on llm_output', () => {
  const hooks = [];
  plugin.default.register({ pluginConfig: {}, on: (name) => hooks.push(name) });
  assert.ok(hooks.includes('llm_output'));
});

// The cancelled text sits last in the transcript with no send behind it,
// which is most of `unanswered`'s definition of a lost reply. What keeps the
// repair sweep from putting it back on the phone is the other half: the turn
// before it must be the PERSON's, and here it is the NO_REPLY. This holds that
// half to the transcript shape the gateway really writes (g-9, rows 71-73).
let db;
before(async () => { db = await freshDb(); });
after(async () => { if (db) await db.teardown(); });

test('the repair sweep does not re-send what the gate stopped after a NO_REPLY', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const u = await makeUser(db.pool, '+972644008801', { firstName: 'Tal' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  const t = Date.now();
  const ago = (min) => new Date(t - min * 60_000).toISOString();
  const msgs = [
    { role: 'user', text: 'תוסיף לרשימה גם חמאה', at: ago(10) },
    { role: 'assistant', text: 'NO_REPLY', at: ago(9.9) },
    { role: 'assistant', text: 'הוספתי ✅ חמאה — הכל ברשימת הסופר.', at: ago(9.8) },
  ];
  const sweep = () => withTx(db.pool, (c) => unanswered.sweepUnanswered(c, {
    readDroppedTurns: () => new Map(), readMessages: () => msgs,
    readSentEvents: () => ({ events: [], windows: [{ from: 0, to: Infinity }] }), now: t,
  }));
  assert.deepEqual((await sweep()).repaired, []);

  // Proof the sweep is live here: without the NO_REPLY in between, the same
  // text IS a lost reply and is re-sent.
  msgs.splice(1, 1);
  assert.deepEqual((await sweep()).repaired, [u.id]);
});
