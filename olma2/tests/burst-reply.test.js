'use strict';
// Messages sent in a row are answered ONCE, at the reply gate
// (gateway-plugin/olma-turn, "a burst is answered once"; owner, 2026-10-02).
// Shimon's three messages and Miron's test that day each got a reply of their
// own; the gateway's inbound debounce could not join them (docs/incidents.md,
// "Three messages in a row got three replies").
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const flags = require('../src/domain/flags');

process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `burst-reply-plugin-test-${process.pid}.log`);

let plugin;
before(async () => { plugin = await import('../gateway-plugin/olma-turn/index.js'); });
beforeEach(() => { plugin && plugin._resetBurst(); plugin && plugin._resetInbound(); });

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

const KEY = 'agent:u-54:whatsapp:direct:+972500000054';
const quiet = { log: () => {} };
const arrive = (messageId, body) => plugin.buildArrivalHandler(quiet)({ sessionKey: KEY, messageId, body }, {});
const turnStarts = (prompt, broker = fakeBroker({ turn_context: { ok: true, enabled: false } })) =>
  plugin.buildHandler({ connect: broker.connect, ...quiet })({ prompt }, { agentId: 'u-54', sessionKey: KEY });
const gate = (text, broker) => plugin.buildReplyGateHandler({ connect: broker.connect, ...quiet })({ payload: { text }, sessionKey: KEY }, {});
const holding = () => fakeBroker({ burst_hold: { ok: true, hold: true } });

test('three messages in a row: the first two replies are held, the third turn is told and answers', async () => {
  await arrive('M1', 'אני יכול בשבת');
  await turnStarts('אני יכול בשבת');
  // A single message, nothing behind it: out it goes, and brokerd is not asked.
  const lone = holding();
  assert.equal(await gate('מעולה, רשמתי', lone), undefined);
  assert.ok(!lone.sent.some((m) => m.method === 'burst_hold'), 'an ordinary reply never waits on a socket');

  // The second message is dispatched while the first turn is still running.
  await arrive('M2', 'גם וגם');
  const b1 = holding();
  assert.deepEqual(await gate('רשמתי שאתה יכול בשבת', b1), { cancel: true, reason: 'olma_burst' });
  const asked = b1.sent.find((m) => m.method === 'burst_hold');
  assert.equal(asked.params.waiting, 1);
  assert.ok(!JSON.stringify(b1.sent).includes('רשמתי'), 'the reply never leaves the gateway');

  // Turn 2 starts on M2 while M3 has already arrived.
  await arrive('M3', 'אחרי 21');
  const t2 = await turnStarts('גם וגם');
  assert.match(t2.prependContext, /\[Burst\].*NONE of these replies/s, 'turn 2 hears about turn 1');
  assert.ok(t2.prependContext.includes('רשמתי שאתה יכול בשבת'), 'and is handed what turn 1 said, word for word');
  assert.deepEqual(await gate('הבנתי, גם וגם', holding()), { cancel: true, reason: 'olma_burst' }, 'M3 is still waiting');

  // Turn 3 has nothing behind it: it is told about one held reply, and goes out.
  const t3 = await turnStarts('אחרי 21');
  // Miron, 2026-10-02: the third turn was told only that "earlier replies did
  // not arrive", saw the second turn's answer in its history, took it as sent
  // and answered the newest message alone. It is handed BOTH held replies now.
  assert.ok(t3.prependContext.includes('רשמתי שאתה יכול בשבת'), 'turn 1\'s reply reaches turn 3');
  assert.ok(t3.prependContext.includes('הבנתי, גם וגם'), 'turn 2\'s reply reaches turn 3');
  assert.match(t3.prependContext, /ONLY message they will get/);
  assert.equal(await gate('רשמתי: שבת, שתי האפשרויות, אחרי 21', holding()), undefined);
  // …and the note is said once.
  assert.equal(await turnStarts('תודה'), undefined);
});

test('brokerd decides: no, a dead socket or a refusal all send the reply', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  await arrive('M2', 'ב');
  assert.equal(await gate('תשובה', fakeBroker({ burst_hold: { ok: true, hold: false } })), undefined, 'flag off');
  assert.equal(await gate('תשובה', fakeBroker({ burst_hold: { ok: false, error: 'x' } })), undefined);
  const dead = { connect: () => { throw new Error('ECONNREFUSED'); } };
  assert.equal(await gate('תשובה', dead), undefined, 'brokerd down');
  // Nothing was held, so the next turn is told nothing.
  assert.equal(await turnStarts('ב'), undefined);
});

test('a turn Olma started is never held, whatever is waiting', async () => {
  // A delivery turn's prompt is our instruction, not a message of theirs.
  await arrive('M1', 'מה קורה');
  await turnStarts('[olma delivery] tell them the meeting moved');
  const b = holding();
  assert.equal(await gate('הפגישה זזה', b), undefined);
  assert.ok(!b.sent.some((m) => m.method === 'burst_hold'));
  // The message is still waiting for its own turn, which takes it.
  await turnStarts('מה קורה');
  assert.equal(plugin.waitingBehind('u-54'), 0);
});

test('a message with no words is taken by the next turn only when nothing else matched', async () => {
  await arrive('IMG', '');
  await arrive('M2', 'מה זה?');
  await turnStarts('<media:image>');
  assert.equal(plugin.waitingBehind('u-54'), 1, 'the photo was taken, the question waits');
  assert.deepEqual(await gate('תמונה יפה', holding()), { cancel: true, reason: 'olma_burst' });
});

test('one turn that read two messages takes both off the list', async () => {
  await arrive('M1', 'תזכיר לי לשלם חשבון');
  await arrive('M2', 'עד יום חמישי');
  await turnStarts('תזכיר לי לשלם חשבון\nעד יום חמישי');
  assert.equal(await gate('אזכיר לך עד חמישי', holding()), undefined);
});

test('a waiting message that never gets a turn stops holding anything after three minutes', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  plugin.rememberArrival('u-54', { messageId: 'LOST', body: 'ב' }, Date.now() - 4 * 60 * 1000);
  assert.equal(plugin.waitingBehind('u-54'), 0);
  assert.equal(await gate('תשובה', holding()), undefined);
});

test('a message the link shortcut answered itself is not waiting for a turn', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  await arrive('LINK', 'שלח לי קישור');
  const shortcut = plugin.buildLinkShortcutHandler({
    connect: fakeBroker({ dashboard_link_shortcut: { ok: true, claim: true, text: 'הנה 👇\nhttps://allma.world/d/x' } }).connect, ...quiet });
  await shortcut({ sessionKey: KEY, messageId: 'LINK', body: 'שלח לי קישור' }, {});
  assert.equal(plugin.waitingBehind('u-54'), 0);
  assert.equal(await gate('תשובה', holding()), undefined);
});

test('a room, the greeter and a message with no id are never counted', async () => {
  await plugin.buildArrivalHandler(quiet)({ sessionKey: 'agent:g-7:whatsapp:group:1@g.us', messageId: 'G', body: 'x', isGroup: true }, {});
  await plugin.buildArrivalHandler(quiet)({ sessionKey: KEY, body: 'no id' }, {});
  assert.equal(plugin.startTurn('u-54', 'no id'), false);
  assert.equal(plugin.waitingBehind('u-54'), 0);
});

test('a held reply with a schedule card keeps the card', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  await arrive('M2', 'ב');
  const out = await plugin.buildReplyGateHandler({ connect: holding().connect, ...quiet })(
    { payload: { text: 'הנה הלו"ז', mediaUrl: '/x.png' }, sessionKey: KEY }, {});
  assert.deepEqual(out, { payload: { text: '', mediaUrl: '/x.png' } });
});

// ── brokerd: the switch ──────────────────────────────────────────────────────

let db, broker;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: true }) });
});
after(async () => { if (db) await db.teardown(); });

let seq = 0;
async function agentUser() {
  seq += 1;
  const u = await makeUser(db.pool, `+9726441${String(seq).padStart(4, '0')}`, { firstName: 'Shimon' });
  const agentId = `u-${880 + seq}`;
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, agentId]);
  return { ...u, agentId };
}
const hold = (agentId) => broker.dispatch({ id: 1, method: 'burst_hold', params: { agentId, waiting: 1, chars: 40 } });

test('brokerd holds for everybody by default, and files the hold without the text', async () => {
  const u = await agentUser();
  assert.deepEqual(await hold(u.agentId), { ok: true, hold: true });
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'reply.burst_held'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].detail, { agentId: u.agentId, waiting: 1, chars: 40 });
});

test('the flag off sends every reply, from the next one on; a list covers only the people on it', async () => {
  const u = await agentUser();
  const other = await agentUser();
  await flags.setFlag(db.pool, 'burst_reply_phones', '');
  assert.deepEqual(await hold(u.agentId), { ok: true, hold: false });
  await flags.setFlag(db.pool, 'burst_reply_phones', ` ${u.phone} `);
  assert.deepEqual(await hold(u.agentId), { ok: true, hold: true });
  assert.deepEqual(await hold(other.agentId), { ok: true, hold: false });
  await flags.setFlag(db.pool, 'burst_reply_phones', 'all');
});

test('brokerd refuses what is not a person\'s agent, and holds nothing for nobody', async () => {
  assert.equal((await hold('g-7')).ok, false);
  assert.deepEqual(await hold('u-99999'), { ok: true, hold: false });
});

test('a message dispatched before the one a turn answers has had its turn, matched or not', async () => {
  // The gateway dressed M1's prompt differently, so its turn matched nothing…
  await arrive('M1', 'שלום');
  await turnStarts('[quoted] שלום');
  // …and M2's turn must not find M1 still "waiting" behind it.
  await arrive('M2', 'מה נשמע');
  await turnStarts('מה נשמע');
  assert.equal(plugin.waitingBehind('u-54'), 0);
  assert.equal(await gate('הכל טוב', holding()), undefined);
});

test('the model\'s own working-out in a held reply is not handed back; a reply cut whole is noted without text', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  await arrive('M2', 'ב');
  // A reply the leak gate would drop whole carries nothing worth repeating.
  await gate('NO_REPLY is the right answer here because the turn context says so', holding());
  const t2 = await turnStarts('ב');
  assert.ok(!/turn context says so/.test(t2.prependContext || ''), 'working-out stays out');
});

test('the held replies stay until a reply actually reaches them, and expire after five minutes', async () => {
  await arrive('M1', 'א');
  await turnStarts('א');
  await arrive('M2', 'ב');
  await gate('תשובה ראשונה', holding());
  // Turn 2 is told, says nothing (no payload at all), and turn 3 must still be told.
  await turnStarts('ב');
  await arrive('M3', 'ג');
  const t3 = await turnStarts('ג');
  assert.ok(t3.prependContext.includes('תשובה ראשונה'));
  assert.equal(await gate('הכל ביחד', holding()), undefined);
  assert.equal(plugin.heldNote('u-54'), '', 'answered: nothing is carried any more');
});
