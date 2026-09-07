'use strict';
// The turn opens itself. The gateway's message:preprocessed hook sends brokerd a
// `turn_open` before the model's first call; the record side of turn_start
// runs then, the 👀 goes on then, and whichever tool the model calls first
// adopts that turn — nothing counted twice, every mark on the right message.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const selfInitiated = require('../src/domain/self-initiated');
// The handler traces to a file next to the production socket by default, and
// the on-box suite runs as root on the box: four fixture events once landed in
// the live trace and read as the gateway having fired. Route it away first.
process.env.OLMA_HOOK_TRACE = require('node:path').join(require('node:os').tmpdir(), `turn-open-hook-test-${process.pid}.log`);
const hook = require('../gateway-hooks/olma-turn-open/handler');

let db, broker, marks, now;
before(async () => {
  db = await freshDb();
  now = Date.now();
  marks = [];
  broker = createBrokerServer({ pool: db.pool, placeMark: (o) => { marks.push(o); return { attempted: true }; }, now: () => now });
});
after(async () => { await db.teardown(); });
beforeEach(() => { marks.length = 0; selfInitiated._reset(); selfInitiated._setGraceMs(0); });

const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const call = (user, name, args, turn) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: user.identity_token, ...args } } }, turn);
const open = (params) => broker.dispatch({ id: 1, method: 'turn_open', params });
const received = async (id) => (await db.pool.query(
  `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'message.received'`, [id])).rows[0].n;
const state = async (id) => (await db.pool.query(
  `SELECT last_inbound_at, checkin_misses FROM users WHERE id = $1`, [id])).rows[0];

async function agentUser(phone, agentId) {
  const u = await makeUser(db.pool, phone);
  await db.pool.query(`UPDATE users SET agent_id = $2, checkin_misses = 2 WHERE id = $1`, [u.id, agentId]);
  return u;
}

test('turn_open counts the message, wakes the person, and puts the 👀 on before any tool call', async () => {
  const u = await agentUser('+972641100001', 'u-901');
  const r = await open({ agentId: 'u-901', messageId: '3EB0GATE0001', kind: 'text' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.opened, true);
  assert.equal(Number(r.userId), Number(u.id));
  assert.equal(await received(u.id), 1);
  const st = await state(u.id);
  assert.ok(st.last_inbound_at, 'awake');
  assert.equal(st.checkin_misses, 0, 'the check-in backoff resets on a real message');
  assert.equal(marks.length, 1);
  assert.equal(marks[0].state, 'working');
  assert.equal(marks[0].messageId, '3EB0GATE0001');
  assert.equal(marks[0].target, u.phone);
  const { rows } = await db.pool.query(`SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'turn.opened_by_gateway'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.messageId, '3EB0GATE0001');
});

test('the model\'s first tool call adopts the gateway-opened turn: no second count, no second 👀, marks on the same message', async () => {
  const u = await agentUser('+972641100002', 'u-902');
  const before = broker.pendingCount();
  await open({ agentId: 'u-902', messageId: '3EB0GATE0002', kind: 'text' });
  assert.equal(marks.length, 1);
  assert.equal(broker.pendingCount(), before + 1);
  const turn = newTurn();
  // the doctrine still says turn_start first — it must be a no-op on the record
  const ts = await call(u, 'turn_start', { message_id: '3EB0GATE0002' }, turn);
  assert.equal(ts.ok, true, ts.text);
  assert.equal(await received(u.id), 1, 'counted once, by the gateway');
  assert.equal(marks.length, 1, 'the 👀 already went out; turn_start does not repeat it');
  assert.equal(turn.openedByGateway, true);
  // and a capture in the same turn puts the 👍 on the gateway's message id
  const added = await call(u, 'add_task', { title: 'לקנות חלב' }, turn);
  assert.equal(added.ok, true);
  assert.equal(marks.length, 2);
  assert.equal(marks[1].state, 'done');
  assert.equal(marks[1].messageId, '3EB0GATE0002');
  assert.equal(broker.pendingCount(), before, 'adopted, not left behind');
});

test('a turn the model opens with any other tool first also adopts it, once', async () => {
  const u = await agentUser('+972641100003', 'u-903');
  await open({ agentId: 'u-903', messageId: '3EB0GATE0003', kind: 'voice' });
  assert.equal(marks[0].state, 'listening', 'a voice note is heard, not seen');
  const turn = newTurn();
  await call(u, 'add_task', { title: 'x' }, turn);
  assert.equal(await received(u.id), 1);
  assert.equal(turn.messageKind, 'voice');
  // a second connection for the same user (next message, no turn_open yet) is a fresh turn
  const turn2 = newTurn();
  await call(u, 'turn_start', {}, turn2);
  assert.equal(await received(u.id), 2, 'a new message without a gateway open is counted by turn_start as before');
});

test('a pending open the model never followed expires and is not adopted by a later turn', async () => {
  const u = await agentUser('+972641100004', 'u-904');
  const before = broker.pendingCount();
  await open({ agentId: 'u-904', messageId: '3EB0GATE0004', kind: 'text' });
  assert.equal(broker.pendingCount(), before + 1);
  now += 11 * 60_000;
  const turn = newTurn();
  await call(u, 'turn_start', { message_id: '3EB0GATE0005' }, turn);
  assert.equal(turn.openedByGateway, undefined);
  assert.equal(await received(u.id), 2, 'the stale open was dropped, the new message counted on its own');
  assert.equal(turn.messageId, '3EB0GATE0005');
});

// ── The connection outlives the turn ────────────────────────────────────────
// The shim caches one socket for the life of the MCP process, so the SAME
// `turn` object serves every turn that process ever handles. Adoption used to
// be latched to its first tool call, which froze the first message's id on it
// for ever. Both halves of the damage are pinned here: a mark on the wrong
// message while the frozen id was still live, and no mark at all once it aged
// out. Neither test passes a fresh `newTurn()` — reusing one IS the case.
test('a second gateway-opened turn on the SAME connection marks its own message, not the first one\'s', async () => {
  const u = await agentUser('+972641100010', 'u-910');
  const turn = newTurn(); // one connection, reused — this is the whole point
  await open({ agentId: 'u-910', messageId: '3EB0SAME0001', kind: 'text' });
  await call(u, 'add_task', { title: 'ראשונה' }, turn);
  assert.equal(marks.at(-1).state, 'done');
  assert.equal(marks.at(-1).messageId, '3EB0SAME0001');

  // Miron, 2026-09-06: three messages inside five minutes, each its own turn.
  now += 4 * 60_000;
  await open({ agentId: 'u-910', messageId: '3EB0SAME0002', kind: 'text' });
  const r = await call(u, 'add_task', { title: 'שנייה' }, turn);
  assert.equal(r.ok, true, r.text);
  assert.equal(turn.messageId, '3EB0SAME0002', 'the turn moved to the new message');
  assert.equal(marks.at(-1).messageId, '3EB0SAME0002', 'the 👍 landed on the message that earned it');
  assert.equal(await received(u.id), 2, 'two messages, counted once each');

  // and the dedup set moved with it: the second message earns its own 👍
  // rather than being swallowed as a repeat of the first message's.
  const done = marks.filter((m) => m.state === 'done');
  assert.equal(done.length, 2);
  assert.deepEqual(done.map((m) => m.messageId), ['3EB0SAME0001', '3EB0SAME0002']);
});

test('with no new opening, the message id is dropped once it ages out — never marked late', async () => {
  const u = await agentUser('+972641100011', 'u-911');
  const turn = newTurn();
  await open({ agentId: 'u-911', messageId: '3EB0STALE001', kind: 'text' });
  await call(u, 'add_task', { title: 'עכשיו' }, turn);
  assert.equal(marks.at(-1).messageId, '3EB0STALE001');

  // A turn with no gateway open behind it — a delivery, a cron lane — arriving
  // on the same socket half an hour later. `markFor` would refuse the dead id
  // on its own; what this pins is that the turn stops CARRYING it, so no later
  // reader has to know to distrust it. Yahav's 22:07 message was six hours
  // stale by the time a tool call reached it, and the test above is the half
  // that fails without the fix.
  now += 30 * 60_000;
  const before = marks.length;
  await call(u, 'add_task', { title: 'מאוחר' }, turn);
  assert.equal(turn.messageId, null, 'the dead id is dropped, not carried');
  assert.equal(marks.length, before, 'and nothing was marked on a message from half an hour ago');
});

// 2026-09-07, read straight off the gateway journal:
//   Sent reaction "👀" -> message manual
//   Sent reaction "👀" -> message auto-3
// A model with nothing to relay does not pass nothing, it passes something.
// `cleanMessageId` bounds the SHAPE and a hallucinated id is well-formed, so
// what separates them is provenance — which this layer already knows.
test('a message id the model made up is refused when we already know better', async () => {
  const u = await agentUser('+972641100012', 'u-912');

  // Olma's own delivery: there is no inbound message, so nothing the model
  // says here can be right. This is the mark `ourTurn` already applies to
  // last_inbound_at and the first-turn signal, applied to one more field.
  const ours = newTurn();
  await selfInitiated.around(u.id, () => call(u, 'turn_start', { message_id: 'manual' }, ours));
  assert.equal(ours.messageId, null, 'no inbound message means no id to mark');
  const before = marks.length;
  await selfInitiated.around(u.id, () => call(u, 'add_task', { title: 'x' }, ours));
  assert.equal(marks.length, before, 'and therefore nothing to react to');

  // A gateway-opened turn carries the REAL id off the WhatsApp envelope, and
  // the model must not be able to move the closing mark off it.
  const turn = newTurn();
  await open({ agentId: 'u-912', messageId: '3EB0REAL0001', kind: 'text' });
  await call(u, 'turn_start', { message_id: 'auto-3' }, turn);
  assert.equal(turn.messageId, '3EB0REAL0001', "the gateway's id stands");
  await call(u, 'add_task', { title: 'y' }, turn);
  assert.equal(marks.at(-1).messageId, '3EB0REAL0001');

  // With no gateway opening and a real person writing, the model is still the
  // only source there is — this narrows the field, it does not close it.
  const relayed = newTurn();
  await call(u, 'turn_start', { message_id: '3EB0RELAY0001' }, relayed);
  assert.equal(relayed.messageId, '3EB0RELAY0001');
});

test('a turn Olma started is not a message from the person — the hook path honours the mark too', async () => {
  const u = await agentUser('+972641100005', 'u-905');
  const r = await selfInitiated.around(u.id, () => open({ agentId: 'u-905', messageId: '3EB0GATE0006', kind: 'text' }));
  assert.equal(r.ok, true);
  assert.equal(r.opened, false);
  assert.equal(r.skipped, 'self_initiated');
  assert.equal(await received(u.id), 0);
  assert.deepEqual(marks, [], 'no 👀 on our own delivery');
});

test('an agent with no active user, or a malformed agent id, is refused and touches nothing', async () => {
  assert.equal((await open({ agentId: 'u-999999', messageId: 'x' })).ok, false);
  assert.equal((await open({ agentId: 'main', messageId: 'x' })).ok, false);
  assert.equal((await open({ agentId: '../etc', messageId: 'x' })).ok, false);
  assert.deepEqual(marks, []);
});

test('the hook handler sends exactly one turn_open line for an inbound message, nothing for anything else', async () => {
  const written = [];
  const fakeSocket = () => {
    const handlers = {};
    const s = { on(ev, fn) { handlers[ev] = fn; return s; }, write(x) { written.push(x); setTimeout(() => handlers.data && handlers.data('{"ok":true}\n'), 0); }, end() { handlers.close && handlers.close(); }, destroy() {} };
    setTimeout(() => handlers.connect && handlers.connect(), 0);
    return s;
  };
  const ok = await hook({
    type: 'message', action: 'received', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', timestamp: new Date('2026-09-05T10:00:00Z'),
    context: { from: '+972500000000', content: 'סודי', messageId: '3EB0HOOK0001', media: [{ mimeType: 'audio/ogg' }], metadata: { senderName: 'Miron' } },
  }, { connect: fakeSocket });
  assert.equal(ok, true);
  assert.equal(written.length, 1);
  const msg = JSON.parse(written[0]);
  assert.equal(msg.method, 'turn_open');
  assert.deepEqual(msg.params, { agentId: 'u-3', messageId: '3EB0HOOK0001', kind: 'voice', senderName: 'Miron', replyToId: null, thanks: false, at: '2026-09-05T10:00:00.000Z' });
  assert.ok(!written[0].includes('סודי'), 'the text never leaves the gateway');
  // The shape the gateway ACTUALLY sends (OpenClaw 2026.8.1, measured
  // 2026-09-06): `message:preprocessed`, sender name and media type flat on
  // the context, no `media` array, no `metadata`. `received` never comes.
  assert.equal(await hook({
    type: 'message', action: 'preprocessed', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', timestamp: new Date('2026-09-05T10:00:05Z'),
    context: { from: '+972500000000', body: 'סודי', bodyForAgent: 'סודי', messageId: '3EB0HOOK0002', senderName: 'Miron', mediaType: 'audio/ogg', transcript: 'שלום', provider: 'whatsapp', cfg: {} },
  }, { connect: fakeSocket }), true);
  assert.equal(written.length, 2);
  assert.deepEqual(JSON.parse(written[1]).params, { agentId: 'u-3', messageId: '3EB0HOOK0002', kind: 'voice', senderName: 'Miron', replyToId: null, thanks: false, at: '2026-09-05T10:00:05.000Z' });
  assert.ok(!written[1].includes('סודי') && !written[1].includes('שלום'), 'neither text nor transcript leaves the gateway');
  // A gateway that fires BOTH for one message opens it once.
  assert.equal(await hook({
    type: 'message', action: 'received', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000',
    context: { messageId: '3EB0HOOK0002', metadata: { senderName: 'Miron' } },
  }, { connect: fakeSocket }), false);
  assert.equal(written.length, 2, 'the same message id was not opened twice');
  // not ours: a command event, an agent that is not a user, a missing session key
  assert.equal(await hook({ type: 'command', action: 'new', sessionKey: 'agent:u-3:x' }, { connect: fakeSocket }), false);
  assert.equal(await hook({ type: 'message', action: 'received', sessionKey: 'agent:main:whatsapp:direct:+1' }, { connect: fakeSocket }), false);
  assert.equal(written.length, 2);
  // brokerd down: the hook fails quietly and the model's own opener takes over
  const failing = () => { const h = {}; const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} }; setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0); return s; };
  assert.equal(await hook({ type: 'message', action: 'received', sessionKey: 'agent:u-3:whatsapp:direct:+1', context: { messageId: 'x' } }, { connect: failing }), false);

  // Every outcome line carries how long brokerd took. A trace that says
  // "timeout" and not how far it got cannot tell a tight deadline from a slow
  // transaction, and the fix for one hides the other.
  const lines = require('node:fs').readFileSync(process.env.OLMA_HOOK_TRACE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const outcomes = lines.filter((l) => l.outcome);
  const sent = outcomes.filter((l) => l.outcome === 'sent');
  assert.ok(sent.length >= 2);
  for (const l of outcomes) assert.equal(typeof l.ms, 'number', `${l.outcome} line without ms: ${JSON.stringify(l)}`);
  assert.equal(outcomes.at(-1).outcome, 'error', 'the refused connect is the last line written');
});

// Miron, 2026-09-06: "בוצע" replying to one reminder, "עוד לא" replying to
// another three seconds later. The plugin that puts the opening in the prompt
// cannot see the reply (the prompt it gets is the bare text), so the hook —
// which sees the WhatsApp envelope with the quote marker — carries the id.
test('a WhatsApp reply reaches brokerd as replyToId, parsed from the quote marker; the quoted text stays behind', async () => {
  const written = [];
  const fakeSocket = () => {
    const handlers = {};
    const s = { on(ev, fn) { handlers[ev] = fn; return s; }, write(x) { written.push(x); setTimeout(() => handlers.data && handlers.data('{"ok":true}\n'), 0); }, end() { handlers.close && handlers.close(); }, destroy() {} };
    setTimeout(() => handlers.connect && handlers.connect(), 0);
    return s;
  };
  const body = '[WhatsApp +972500000000 +31m Sun 2026-09-06 11:04:59 UTC] +972500000000: בוצע\n\n[Replying to 12345678901234@lid id:3EB0QUOTED0001]\n⏰ תזכורת חוזרת: לאכול צהריים\n[/Replying]';
  hook._resetSeen();
  assert.equal(await hook({
    type: 'message', action: 'preprocessed', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', timestamp: new Date('2026-09-06T11:04:59Z'),
    context: { from: '+972500000000', body, bodyForAgent: 'בוצע', messageId: '3EB0REPLY0001', senderName: 'Miron', provider: 'whatsapp', cfg: {} },
  }, { connect: fakeSocket }), true);
  const params = JSON.parse(written[0]).params;
  assert.equal(params.replyToId, '3EB0QUOTED0001');
  assert.equal(params.messageId, '3EB0REPLY0001');
  assert.ok(!written[0].includes('צהריים') && !written[0].includes('בוצע'), 'neither the quote nor the text leaves the gateway');
  // no quote: null, never a guess from the body
  assert.equal(await hook({
    type: 'message', action: 'preprocessed', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000',
    context: { body: '[WhatsApp +972500000000] +972500000000: שלום id:notaquote', messageId: '3EB0REPLY0002', provider: 'whatsapp' },
  }, { connect: fakeSocket }), true);
  assert.equal(JSON.parse(written[1]).params.replyToId, null);
  // a gateway that puts the field on the event wins over the parse
  assert.equal(hook.replyToIdOf({ replyToId: '3EB0FIELD', body }), '3EB0FIELD');
  assert.equal(hook.replyToIdOf({}), null);
});

// One slot per user was the shape until 2026-09-06. Two messages a few seconds
// apart — the second's open overwrote the first's, and whichever turn's tools
// came first adopted the wrong message. Now each message keeps its own open.
test('two quick messages keep two opens; each turn adopts its own, and nothing older is left behind to be adopted by mistake', async () => {
  const u = await agentUser('+972641100009', 'u-909');
  const before = broker.pendingCount();
  await open({ agentId: 'u-909', messageId: '3EB0Q1', kind: 'text' });
  await open({ agentId: 'u-909', messageId: '3EB0Q2', kind: 'text' });
  assert.equal(await received(u.id), 2, 'both counted, by their opens');
  assert.equal(broker.pendingCount(), before + 2, 'the second did not overwrite the first');
  // No opening in any prompt (the turn_start path): the newest is the live
  // one and the older is dropped with it — that turn ended without a tool.
  const turn = newTurn();
  await call(u, 'add_task', { title: 'x' }, turn);
  assert.equal(turn.messageId, '3EB0Q2');
  assert.equal(await received(u.id), 2, 'no third count');
  assert.equal(broker.pendingCount(), before, 'the stale older open went with it');
  // Capped: a person who writes a dozen lines while the model thinks does
  // not grow the queue without bound.
  for (let i = 0; i < 12; i += 1) await open({ agentId: 'u-909', messageId: `3EB0CAP${i}`, kind: 'text' });
  assert.ok(broker.pendingCount() - before <= 8, `capped, got ${broker.pendingCount() - before}`);
  const t2 = newTurn();
  await call(u, 'add_task', { title: 'y' }, t2);
  assert.equal(t2.messageId, '3EB0CAP11', 'the newest survives the cap');
  assert.equal(broker.pendingCount(), before);
});

// ── "תודה" is answered by the mark, and by nothing else ──────────────────────

test('the hook reads a thanks and sends the verdict, never the words', () => {
  const yes = ['תודה', 'תודה רבה', 'תודה רבה לך!', 'מעולה, תודה 🙏', 'thanks!', 'Thank you so much', 'ty'];
  const no = [
    'תודה?',                       // a question is never a closed exchange
    'תודה, ותוסיף חלב לרשימה',      // thanks AND an ask is an ask
    'תודה על התזכורת',              // long-form gratitude takes the ordinary path
    'מעולה',                        // acknowledgement is not thanks
    '👍',                           // an emoji alone is not a thanks we can read
    '',
  ];
  for (const t of yes) assert.equal(hook.thanksOnly(t), true, `thanks: ${JSON.stringify(t)}`);
  for (const t of no) assert.equal(hook.thanksOnly(t), false, `not thanks: ${JSON.stringify(t)}`);
  // A WhatsApp reply quotes the earlier message into the body; the quoted text
  // is not what they just wrote and must not be read as if it were.
  assert.equal(hook.thanksOnly('[Replying to Olma id:3EB0X]\nתזכורת: לקנות חלב\n[/Replying]\nתודה רבה'), true);
  assert.equal(hook.thanksOnly('[Replying to Olma id:3EB0X]\nתודה\n[/Replying]\nתבטל את זה'), false);
});

test('a message that is only thanks gets 🙏 instead of 👀, and the turn is told to say nothing', async () => {
  const u = await agentUser('+972641100031', 'u-931');
  const r = await open({ agentId: 'u-931', messageId: '3EB0THANKS01', kind: 'text', thanks: true });
  assert.equal(r.opened, true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].state, 'thanks', '👀 promises a reply, and this one is not getting one');
  assert.equal(marks[0].emoji, '🙏');
  assert.equal(marks[0].messageId, '3EB0THANKS01');
  // It is still a real message: counted, awake, on the record like any other.
  assert.equal(await received(u.id), 1);

  const turn = newTurn();
  const res = await call(u, 'turn_start', { message_id: '3EB0THANKS01' }, turn);
  assert.match(res.text, /thanksOnly/, 'the hint rides the opening the model just read');
  assert.match(res.text, /NO_REPLY/);
});

test('an ordinary message carries no silence hint', async () => {
  const u = await agentUser('+972641100032', 'u-932');
  await open({ agentId: 'u-932', messageId: '3EB0THANKS02', kind: 'text' });
  assert.equal(marks[0].state, 'working');
  const res = await call(u, 'turn_start', { message_id: '3EB0THANKS02' }, newTurn());
  assert.doesNotMatch(res.text, /thanksOnly/,
    'a hint that asks for silence must never reach a turn that owes an answer');
});

// Eleven opens timed out on the hook's side and left nothing here — because
// this path had no catch, a transaction that threw would have been an
// unhandled rejection with no line in the journal, and a slow one had no
// clock on it at all. The failure is now an answer the hook can read and a
// line the journal keeps; a slow open says which step took the time.
test('a turn_open whose transaction fails answers with an error and logs it, instead of vanishing', async () => {
  const deadPool = { connect: async () => { throw new Error('pool exhausted'); } };
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  try {
    const b = createBrokerServer({ pool: deadPool, placeMark: () => ({ attempted: true }) });
    const r = await b.dispatch({ id: 1, method: 'turn_open', params: { agentId: 'u-902', messageId: '3EB0DEAD0001' } });
    assert.deepEqual(r, { ok: false, error: 'turn_open failed' });
  } finally { console.error = orig; }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /turn_open u-902 failed after \d+ms/);
  assert.match(logged[0], /pool exhausted/);
});
