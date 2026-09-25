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

// ── A repeat of the SAME message is not a second message ───────────────────
// Miron, 2026-09-13: the eyes reappeared on a message Olma had already
// answered. Nothing here required the model to make a mistake — `turn_open`
// itself had no memory of a message it had already opened a turn for, so a
// hook retry past its own deadline (see handleTurnOpen's comment) or a
// redelivered webhook would be read as a brand new message every time.
test('a repeated turn_open for the SAME message — a hook retry, a redelivered webhook — is not a second turn', async () => {
  const u = await agentUser('+972641100020', 'u-920');
  await open({ agentId: 'u-920', messageId: '3EB0RETRY0001', kind: 'text' });
  assert.equal(marks.length, 1);
  assert.equal(await received(u.id), 1);
  const before = broker.pendingCount();

  const r2 = await open({ agentId: 'u-920', messageId: '3EB0RETRY0001', kind: 'text' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.opened, false, 'a duplicate is reported as not opened');
  assert.equal(r2.skipped, 'duplicate_message');
  assert.equal(marks.length, 1, 'the eyes do not go on a second time');
  assert.equal(await received(u.id), 1, 'not counted twice');
  assert.equal(broker.pendingCount(), before, 'nothing new queued for a tool call to adopt');

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'turn.duplicate_open_skipped'`, [u.id]);
  assert.equal(rows[0].n, 1, 'the duplicate is on the record, never silently dropped');
});

test('a different message right after is untouched by the duplicate guard', async () => {
  const u = await agentUser('+972641100021', 'u-921');
  await open({ agentId: 'u-921', messageId: '3EB0TWO0001', kind: 'text' });
  const r2 = await open({ agentId: 'u-921', messageId: '3EB0TWO0002', kind: 'text' });
  assert.equal(r2.opened, true);
  assert.equal(marks.length, 2);
  assert.equal(await received(u.id), 2);
});

test('the same message id from a DIFFERENT person is never read as a retry of this one', async () => {
  const a = await agentUser('+972641100022', 'u-922');
  const b = await agentUser('+972641100023', 'u-923');
  await open({ agentId: 'u-922', messageId: 'SHARED-ID-EDGE', kind: 'text' });
  const r2 = await open({ agentId: 'u-923', messageId: 'SHARED-ID-EDGE', kind: 'text' });
  assert.equal(r2.opened, true, 'the guard is scoped per person, never global on the id alone');
  assert.equal(await received(a.id), 1, 'the first person is untouched by the second one\'s open');
  assert.equal(await received(b.id), 1);
});

test('past the retry window, a repeat of the same id is a genuinely new turn again', async () => {
  const u = await agentUser('+972641100024', 'u-924');
  await open({ agentId: 'u-924', messageId: '3EB0LATE0001', kind: 'text' });
  now += 16 * 60_000; // past reactions.LIVE_WINDOW_MS (15 minutes) — not a retry any more
  const r2 = await open({ agentId: 'u-924', messageId: '3EB0LATE0001', kind: 'text' });
  assert.equal(r2.opened, true, 'sixteen minutes on, whatever this is, it is not the retry the guard exists for');
  assert.equal(marks.length, 2);
  assert.equal(await received(u.id), 2);
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
  assert.deepEqual(msg.params, { agentId: 'u-3', messageId: '3EB0HOOK0001', kind: 'voice', senderName: 'Miron', replyToId: null, thanks: false, stopReminders: false, chase: null, openList: false, at: '2026-09-05T10:00:00.000Z' });
  assert.ok(!written[0].includes('סודי'), 'the text never leaves the gateway');
  // The shape the gateway ACTUALLY sends (OpenClaw 2026.8.1, measured
  // 2026-09-06): `message:preprocessed`, sender name and media type flat on
  // the context, no `media` array, no `metadata`. `received` never comes.
  assert.equal(await hook({
    type: 'message', action: 'preprocessed', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', timestamp: new Date('2026-09-05T10:00:05Z'),
    context: { from: '+972500000000', body: 'סודי', bodyForAgent: 'סודי', messageId: '3EB0HOOK0002', senderName: 'Miron', mediaType: 'audio/ogg', transcript: 'שלום', provider: 'whatsapp', cfg: {} },
  }, { connect: fakeSocket }), true);
  assert.equal(written.length, 2);
  assert.deepEqual(JSON.parse(written[1]).params, { agentId: 'u-3', messageId: '3EB0HOOK0002', kind: 'voice', senderName: 'Miron', replyToId: null, thanks: false, stopReminders: false, chase: null, openList: false, at: '2026-09-05T10:00:05.000Z' });
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
  const yes = ['תודה', 'תודה רבה', 'תודה רבה לך!', 'מעולה, תודה 🙏', 'thanks!', 'Thank you so much', 'ty',
    // every language, each with its "very much" (owner, 2026-09-26)
    'شكرا', 'شكراً جزيلاً', 'Спасибо большое', 'merci beaucoup', 'Muchas gracias!',
    'Vielen Dank', 'Danke schön', 'grazie mille', 'muito obrigado', 'አመሰግናለሁ', 'תנקס'];
  const no = [
    'תודה?',                       // a question is never a closed exchange
    'תודה, ותוסיף חלב לרשימה',      // thanks AND an ask is an ask
    'תודה על התזכורת',              // long-form gratitude takes the ordinary path
    'מעולה',                        // acknowledgement is not thanks
    'спасибо, а завтра?',           // a question in any language is a question
    'gracias por todo',             // long-form, in any language
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

// 2026-09-07, u-3: the hook's 2s timer fired at 3.8s with `connected:false`.
// The gateway's own loop was blocked by its pre-model bookkeeping, and when it
// came back the timer ran before the connect callback and killed a socket
// that was about to succeed. So the brokerd budget starts at CONNECT; a
// socket that never opens has its own, longer cap. Mock clock: a stall is
// modelled as connect arriving late, and neither case waits real seconds.
test('a connect the gateway delivered late is not a brokerd timeout; a socket that never connects still gives up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const lines = () => require('node:fs').readFileSync(process.env.OLMA_HOOK_TRACE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lateSocket = (connectAfterMs, answerAfterMs) => () => {
    const h = {};
    const s = { on(ev, fn) { h[ev] = fn; return s; }, write() { setTimeout(() => h.data && h.data('{"ok":true}\n'), answerAfterMs); }, end() { h.close && h.close(); }, destroy() {} };
    setTimeout(() => h.connect && h.connect(), connectAfterMs);
    return s;
  };
  const ev = (id) => ({ type: 'message', action: 'preprocessed', sessionKey: 'agent:u-3:whatsapp:direct:+972500000000', context: { messageId: id, body: 'x' } });

  // Connect at 3.5s — past the old 2s deadline — then brokerd answers in 300ms.
  const p1 = hook(ev('3EB0STALL0001'), { connect: lateSocket(3500, 300) });
  t.mock.timers.tick(3500); t.mock.timers.tick(300);
  return p1.then(async (ok1) => {
    assert.equal(ok1, true, 'a stalled gateway must not be read as a slow brokerd');
    const l1 = lines().at(-1);
    assert.equal(l1.outcome, 'sent');
    assert.equal(l1.connected, true);
    assert.equal(l1.connectMs, 3500);
    assert.equal(l1.ms, 3800);

    // Connected promptly, brokerd silent: the 2s budget runs from connect.
    const p2 = hook(ev('3EB0STALL0002'), { connect: lateSocket(100, 60_000) });
    t.mock.timers.tick(100); t.mock.timers.tick(2000);
    assert.equal(await p2, false);
    const l2 = lines().at(-1);
    assert.equal(l2.outcome, 'timeout');
    assert.equal(l2.connected, true);
    assert.equal(l2.ms, 2100, 'two seconds after connect, not after start');

    // Never connects: the longer cap, and the line says so.
    const p3 = hook(ev('3EB0STALL0003'), { connect: lateSocket(60_000, 0) });
    t.mock.timers.tick(10_000);
    assert.equal(await p3, false);
    const l3 = lines().at(-1);
    assert.equal(l3.outcome, 'timeout');
    assert.equal(l3.connected, false);
    assert.equal(l3.ms, 10_000);
  });
});

// ── "להפסיק להזכיר" is answered by stopping, not by asking which ─────────────
// מאיה, 2026-09-16 11:02. Four messages about a hospital bag she had already
// packed, then "להפסיק להזכיר" — and what came back was "מה להפסיק? 1. התזכורת
// על לארוז 2. שתיהן 3. לדחות", with nothing cancelled. An hour later another
// rung landed, and the morning after the hospital, two more.

test('the hook reads a stop request and sends the verdict, never the words', () => {
  const yes = [
    'להפסיק להזכיר', 'תפסיקי עם התזכורות', 'די עם התזכורות', 'בלי תזכורות',
    'מספיק תזכורות', 'תפסיק להזכיר לי', 'stop reminding me', 'תפסיקי לנדנד',
  ];
  const no = [
    // A new time is a RESCHEDULE and only the model can do it — this is the
    // exact message from the 2026-09-09 incident, and it must keep taking the
    // ordinary path (tests/reminder-stop.test.js holds that half).
    'תפסיק עם התזכורות לזמן הקרוב, התזכורת הבאה רק ביום שני',
    'תפסיקי להזכיר לי על זה עד מחר בבוקר',
    'להפסיק?',                      // a question is never a decision
    'תזכיר לי מחר ב9',              // asking FOR one
    'להזכיר לי לקנות חלב',
    'תודה',
    'דירה חדשה עם תזכורת',          // די inside a word — \b is dead against Hebrew
    '',
  ];
  for (const t of yes) assert.equal(hook.stopRemindersOnly(t), true, `stop: ${JSON.stringify(t)}`);
  for (const t of no) assert.equal(hook.stopRemindersOnly(t), false, `not stop: ${JSON.stringify(t)}`);
  // The quoted half of a WhatsApp reply is not what they just wrote.
  assert.equal(hook.stopRemindersOnly('[Replying to Olma id:3EB0X]\nתזכורת: לארוז תיק\n[/Replying]\nלהפסיק להזכיר'), true);
});

// "מה פתוח לי?" — a question about their whole list, which brokerd answers by
// leaving the today block out of the turn. Every "yes" below but the English
// ones and the eval's own is a real message from the box (879 read, 8 hits,
// 2026-09-24); every "no" is what must keep its today block, or is not about
// their list at all.
test('the hook reads a question about their whole list, and not one about a day', () => {
  const yes = [
    'מה פתוח לי?', 'מה עוד פתוח?', 'מה פתוח אצלי בינתיים', 'מה על הפרק',
    'מה המשימות הפתוחות שיש לי?', 'מה המשימות שלי?', 'איזה משימות פתוחות?',
    'איזה משימות משותפות יש לי עם מאיה?', 'מה יש ברשימה עכשיו?', 'מה נשאר לי לעשות?',
    "what's open?", 'show me my tasks',
  ];
  const no = [
    'מה פתוח לי היום?', 'מה המשימות שלי להיום?', 'מה המשימות שלי של מחר', 'מה יש לי היום',
    'מה יש לי מחר בבוקר?', 'מה יש לי שבוע הבא?', 'מה יש לי היום ביומן?',
    'מה פתוח במשרד בשבת?',            // a day, and not their list
    'מה פתוח עכשיו באזור?',           // a shop — "פתוח" is about THEM or it is nothing
    'תוסיף משימה לקנות חלב', 'תעשי לי סדר — מה יש לי על הראש?', 'תודה', '',
    'מה המשימות שלי? '.repeat(20),    // a long message only mentions it
  ];
  for (const t of yes) assert.equal(hook.asksOpenList(t), true, `open list: ${JSON.stringify(t)}`);
  for (const t of no) assert.equal(hook.asksOpenList(t), false, `not: ${JSON.stringify(t)}`);
  assert.equal(hook.asksOpenList('[Replying to Olma id:3EB0X]\nמה פתוח לי היום?\n[/Replying]\nמה פתוח לי?'), true,
    'the quoted half of a reply is not what they just wrote');
});

// Two ladders chasing her, one message, and both stop — with no question about
// which, because "stop" was never ambiguous to the person who wrote it.
test('"להפסיק להזכיר" stops every ladder that has spoken to them, and earns a 👍', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const sweeps = require('../src/jobs/sweeps');
  const { withTx } = require('../src/db/pool');
  const u = await agentUser('+972641100041', 'u-941');

  // Her evening, in the shape production reaches it: a task she asked to be
  // reminded about, plus the duplicate the extraction job wrote, both chasing.
  //
  // Every moment here is computed ONCE off the suite's own clock and is hours
  // rather than a date: the stop looks back a day (reminders.STOP_WINDOW_HOURS),
  // so a hard-coded evening would pass today and stop passing tomorrow
  // (.claude/rules/testing.md).
  const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();
  const ids = await withTx(db.pool, async (c) => {
    const bag = await tasks.addTask(c, u.id, { title: 'לארוז תיק לבית חולים' });
    const dup = await tasks.addTask(c, u.id, { title: 'להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה' });
    const a = await reminders.setReminder(c, u.id, bag.data.task.id, hoursAgo(5));
    const b = await reminders.setReminder(c, u.id, dup.data.task.id, hoursAgo(6));
    return { a: Number(a.data.reminder.id), b: Number(b.data.reminder.id) };
  });
  // Both were asked to chase, which is the only way they chase at all now.
  await db.pool.query(`UPDATE task_reminders SET nudge = true`);
  await withTx(db.pool, (c) => sweeps.sweepReminders(c, hoursAgo(4.9)));
  await db.pool.query(
    `UPDATE outbox SET sent_at = $1::timestamptz, hold_reason = NULL WHERE kind = 'reminder'`,
    [hoursAgo(4.8)]);
  // And one rung is already queued, the way a night-held follow-up would be:
  // the row that made "ביטלתי" a lie for hours.
  await withTx(db.pool, (c) => sweeps.sweepReminders(c, hoursAgo(1)));
  const queued = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE kind = 'reminder' AND sent_at IS NULL`);
  assert.ok(queued.rows[0].n >= 1, 'a follow-up is in the queue when she writes');

  const r = await open({ agentId: 'u-941', messageId: '3EB0STOP01', kind: 'text', stopReminders: true });
  assert.equal(r.opened, true);
  assert.equal(marks[0].state, 'done', '👀 promises a reply; this message is already answered');
  assert.equal(marks[0].emoji, '👍');

  const { rows: left } = await db.pool.query(
    `SELECT r.id, r.sent_at, r.cancelled_at FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id WHERE t.owner_id = $1 ORDER BY r.id`, [u.id]);
  assert.equal(left.filter((x) => !x.sent_at && !x.cancelled_at).length, 0, 'no ladder is left walking');
  for (const row of left) assert.equal(row.cancelled_at, null, 'retired, not cancelled — she answered them');
  const { rows: ob } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'reminder' AND hold_reason IS NOT NULL`, [u.id]);
  assert.ok(ob.length >= 1 && ob.every((x) => x.hold_reason === 'stopped'),
    'the rung already in the queue is withdrawn, not left to land at dawn');
  // The tasks are hers and stay exactly as they were.
  const { rows: open2 } = await db.pool.query(
    `SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1 AND status = 'open'`, [u.id]);
  assert.equal(open2[0].n, 2);
  assert.equal(ids.a > 0 && ids.b > 0, true);

  const res = await call(u, 'turn_start', { message_id: '3EB0STOP01' }, newTurn());
  assert.match(res.text, /stoppedReminders/, 'the model is told it is already done');
  assert.match(res.text, /NO_REPLY/);
  assert.match(res.text, /Never ask WHICH/, 'the question מאיה actually got is the one this forbids');

  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'reminder.ladder_stopped'`, [u.id]);
  assert.equal(audit.length, 1, 'a stop nobody can see is a stop nobody can count');
  assert.equal(audit[0].detail.stopped.length, 2);
});

// The other direction, and the one that keeps this from becoming a way to lose
// a reminder: nothing was chasing, so nothing is stopped, the mark is the
// ordinary 👀 and the turn owes a real answer.
test('a stop request with nothing chasing changes nothing and asks for no silence', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { withTx } = require('../src/db/pool');
  const u = await agentUser('+972641100042', 'u-942');
  await withTx(db.pool, async (c) => {
    const t = await tasks.addTask(c, u.id, { title: 'לקחת תרופה' });
    await reminders.setReminder(c, u.id, t.data.task.id, '2026-12-01T06:00:00Z');
  });

  await open({ agentId: 'u-942', messageId: '3EB0STOP02', kind: 'text', stopReminders: true });
  assert.equal(marks[0].state, 'working');
  const { rows: [pending] } = await db.pool.query(
    `SELECT r.sent_at, r.cancelled_at FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id WHERE t.owner_id = $1`, [u.id]);
  assert.equal(pending.sent_at, null, 'an hour they have never heard is not what "stop" is about');
  assert.equal(pending.cancelled_at, null);
  const res = await call(u, 'turn_start', { message_id: '3EB0STOP02' }, newTurn());
  assert.doesNotMatch(res.text, /stoppedReminders/,
    'a hint that asks for silence must never reach a turn that owes an answer');
});

// ── "help me until next week": the chase is armed by code ────────────────────
// חיים, 2026-09-22 (tests/reminder-chase.test.js holds the whole story). The
// hook reads a deadline plus a request for help and sends a KIND; brokerd
// resolves it against the person's clock and add_task arms the chase, whatever
// date the model gave the errand. `days: 5` rather than a weekday, so nothing
// here depends on the day it runs (rules/testing.md).
test('a deadline heard by the hook becomes a daily chase on the task the turn saves', async () => {
  const u = await agentUser('+972641100061', 'u-961');
  await open({ agentId: 'u-961', messageId: '3EB0CHASE01', kind: 'text', chase: { kind: 'days', n: 5, namedHour: false } });
  const turn = newTurn();
  const ts = await call(u, 'turn_start', { message_id: '3EB0CHASE01' }, turn);
  assert.match(ts.text, /is a CHASE/, 'the model is told what the server will do');

  // The model's own reading: the errand tomorrow, an hour it picked. Neither stands.
  const tomorrow = new Date(now + 86400_000).toISOString().replace('Z', '+00:00');
  const res = await call(u, 'add_task', { title: 'לקחת את המצלמה לתיקון', due_at: tomorrow, remind_at: tomorrow }, turn);
  assert.equal(res.ok, true, res.text);
  const { rows } = await db.pool.query(
    `SELECT t.due_at, r.repeat_rule, r.repeat_until, r.nudge FROM tasks t
       JOIN task_reminders r ON r.task_id = t.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL
      WHERE t.owner_id = $1`, [u.id]);
  assert.equal(rows.length, 1, 'one row: the chase replaced the automatic one, never joined it');
  assert.equal(rows[0].repeat_rule, 'daily');
  assert.equal(rows[0].nudge, true);
  const day = require('../src/domain/chase-deadline').forTurn({ kind: 'days', n: 5 },
    { now: new Date(now), timezone: u.timezone }).day;
  assert.ok(require('../src/domain/chase-deadline').onDay(rows[0].due_at, day, u.timezone),
    'the task is due on the day they said, not the day the model guessed');
  assert.ok(require('../src/domain/chase-deadline').onDay(rows[0].repeat_until, day, u.timezone),
    'and the chase ends with it');
  assert.match(res.text, /daily chase is armed/);

  // Spent once: a second task in the same turn is an ordinary one.
  const other = await call(u, 'add_task', { title: 'לקנות סוללה', due_at: tomorrow }, turn);
  assert.equal(other.ok, true, other.text);
  assert.doesNotMatch(other.text, /daily chase is armed/);
});

test('a task already on their list is chased to the heard deadline through set_task_reminder', async () => {
  const u = await agentUser('+972641100062', 'u-962');
  const tomorrow = new Date(now + 86400_000).toISOString().replace('Z', '+00:00');
  const first = await call(u, 'add_task', { title: 'לשלוח את הדוח', due_at: tomorrow }, newTurn());
  assert.equal(first.ok, true, first.text);
  const taskId = (await db.pool.query(`SELECT id FROM tasks WHERE owner_id = $1`, [u.id])).rows[0].id;
  await open({ agentId: 'u-962', messageId: '3EB0CHASE02', kind: 'text', chase: { kind: 'days', n: 4, namedHour: false } });
  const turn = newTurn();
  const res = await call(u, 'set_task_reminder', { task_id: taskId, remind_at: tomorrow }, turn);
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /daily chase is armed/);
  const { rows } = await db.pool.query(
    `SELECT repeat_rule, repeat_until FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, [taskId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repeat_rule, 'daily');
  const day = require('../src/domain/chase-deadline').forTurn({ kind: 'days', n: 4 },
    { now: new Date(now), timezone: u.timezone }).day;
  assert.ok(require('../src/domain/chase-deadline').onDay(rows[0].repeat_until, day, u.timezone));
});

test('a turn with no deadline heard arms nothing it was not asked to', async () => {
  const u = await agentUser('+972641100063', 'u-963');
  await open({ agentId: 'u-963', messageId: '3EB0CHASE03', kind: 'text' });
  const turn = newTurn();
  const ts = await call(u, 'turn_start', { message_id: '3EB0CHASE03' }, turn);
  assert.doesNotMatch(ts.text, /is a CHASE/);
  const res = await call(u, 'add_task', { title: 'לקנות חלב', due_at: new Date(now + 3 * 86400_000).toISOString().replace('Z', '+00:00') }, turn);
  assert.equal(res.ok, true, res.text);
  assert.doesNotMatch(res.text, /daily chase is armed/);
  // and a verdict that is not one is dropped at the door
  await open({ agentId: 'u-963', messageId: '3EB0CHASE04', kind: 'text', chase: { kind: 'forever' } });
  const ts2 = await call(u, 'turn_start', { message_id: '3EB0CHASE04' }, newTurn());
  assert.doesNotMatch(ts2.text, /is a CHASE/);
});
