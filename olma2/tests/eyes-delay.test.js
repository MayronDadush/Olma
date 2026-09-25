'use strict';
// The 👀 waits for a slow answer (owner, 2026-09-25). Measured on 123 real
// messages: the 👀 landed UNDER the reply in 57 of 77, and a quarter of all
// replies came inside 10s. So brokerd holds the opening mark for
// `eyes_delay_seconds` and puts it on only if nothing has answered by then —
// a reply going out, a closing mark, or the turn ending all drop it
// (`incidents.md`, "The eyes arrived after the answer").
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const flagsDomain = require('../src/domain/flags');
const turnDomain = require('../src/domain/turn');
const selfInitiated = require('../src/domain/self-initiated');
const reactions = require('../src/domain/reactions');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `eyes-delay-plugin-test-${process.pid}.log`);

// Timers the test fires by hand: which delay was asked for, and nothing
// depends on the wall clock.
function fakeTimers() {
  let seq = 0;
  const live = new Map();
  return {
    set(fn, ms) { seq += 1; live.set(seq, { fn, ms }); return seq; },
    clear(id) { live.delete(id); },
    fireAll() { const due = [...live.values()]; live.clear(); for (const t of due) t.fn(); },
    pending() { return [...live.values()].map((t) => t.ms); },
  };
}

let db, broker, marks, now, timers, signals;
before(async () => {
  db = await freshDb();
  now = Date.now();
  marks = [];
  timers = fakeTimers();
  signals = true;
  broker = createBrokerServer({
    pool: db.pool, now: () => now, timers, endSignalsLive: () => signals,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
  });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, 'all'));
});
after(async () => { await db.teardown(); });
beforeEach(async () => {
  marks.length = 0; timers.fireAll(); marks.length = 0; signals = true;
  selfInitiated._reset(); selfInitiated._setGraceMs(0);
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, reactions.EYES_DELAY_FLAG, 15));
});

let seq = 0;
async function person() {
  seq += 1;
  const u = await makeUser(db.pool, `+9726430${String(seq).padStart(4, '0')}`);
  const agentId = `u-${700 + seq}`;
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [u.id, agentId]);
  return { ...u, agentId };
}
const dispatch = (method, params, turn) => broker.dispatch({ id: 1, method, params }, turn);
const open = (u, messageId, extra = {}) => dispatch('turn_open', { agentId: u.agentId, messageId, kind: 'text', ...extra });
const prompt = (u) => dispatch('turn_context', { agentId: u.agentId, sessionKey: `agent:${u.agentId}:whatsapp:direct:${u.phone}` });
const progress = (u, what) => dispatch('turn_progress', { agentId: u.agentId, what });
const eyes = () => marks.filter((m) => m.state === 'working' || m.state === 'listening');

test('openingDelayMs: only the marks that promise an answer wait, and only when something can cancel them', () => {
  assert.equal(reactions.openingDelayMs('working', 15, true), 15_000);
  assert.equal(reactions.openingDelayMs('listening', 15, true), 15_000, '👂 is the voice-note 👀');
  assert.equal(reactions.openingDelayMs('thanks', 15, true), 0, '🙏 is the answer');
  assert.equal(reactions.openingDelayMs('done', 15, true), 0, 'the stop-reminders 👍 is the answer');
  assert.equal(reactions.openingDelayMs('working', 15, false), 0, 'a plugin that cannot say "answered" gets the old immediate 👀');
  assert.equal(reactions.openingDelayMs('working', 0, true), 0);
  assert.equal(reactions.openingDelayMs('working', 'nonsense', true), 0);
  assert.equal(reactions.openingDelayMs('working', 9999, true), 120_000, 'capped: a typo must not mean "never"');
});

test('endSignalsLive reads the plugin stamp, and unreadable is false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-eyes-stamp-'));
  const file = path.join(dir, 'stamp');
  const saved = process.env.OLMA_PLUGIN_REGISTER_STAMP;
  process.env.OLMA_PLUGIN_REGISTER_STAMP = file;
  try {
    reactions._resetStampCache();
    assert.equal(reactions.endSignalsLive({ now: 1 }), false, 'no stamp');
    fs.writeFileSync(file, JSON.stringify({ hooks: ['before_prompt_build', 'reply_payload_sending'] }));
    reactions._resetStampCache();
    assert.equal(reactions.endSignalsLive({ now: 1 }), false, 'a gateway on the build before agent_end');
    fs.writeFileSync(file, JSON.stringify({ hooks: ['reply_payload_sending', 'agent_end'] }));
    assert.equal(reactions.endSignalsLive({ now: 2 }), false, 'cached for a minute');
    assert.equal(reactions.endSignalsLive({ now: 70_000 }), true);
  } finally {
    if (saved === undefined) delete process.env.OLMA_PLUGIN_REGISTER_STAMP; else process.env.OLMA_PLUGIN_REGISTER_STAMP = saved;
    reactions._resetStampCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fast reply: no 👀 at all', async () => {
  const u = await person();
  await open(u, '3EB0EYES0001');
  assert.deepEqual(eyes(), [], 'nothing placed at open');
  assert.deepEqual(timers.pending(), [15_000]);
  await prompt(u);
  assert.deepEqual(await progress(u, 'reply'), { ok: true, held: true });
  timers.fireAll();
  assert.deepEqual(eyes(), []);
});

test('a slow reply: the 👀 goes on at fifteen seconds, on the right message', async () => {
  const u = await person();
  await open(u, '3EB0EYES0002');
  await prompt(u);
  timers.fireAll();
  assert.equal(eyes().length, 1);
  assert.equal(eyes()[0].messageId, '3EB0EYES0002');
  assert.equal(eyes()[0].target, u.phone);
  // the reply after it cancels nothing that is not there
  assert.deepEqual(await progress(u, 'reply'), { ok: true, held: false });
});

test('a turn that ends in silence drops the 👀 too', async () => {
  const u = await person();
  await open(u, '3EB0EYES0003');
  await prompt(u);
  await progress(u, 'end');
  timers.fireAll();
  assert.deepEqual(eyes(), []);
});

test('a 👍 before fifteen seconds says more than the 👀 would have', async () => {
  const u = await person();
  await open(u, '3EB0EYES0004');
  const turn = { userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null };
  const added = await dispatch('tool_call', { name: 'add_task', args: { olma_identity: u.identity_token, title: 'לקנות חלב' } }, turn);
  assert.equal(added.ok, true, added.text);
  timers.fireAll();
  assert.deepEqual(marks.map((m) => m.state), ['done']);
});

test('a message that waits behind another turn keeps its own 👀', async () => {
  const u = await person();
  await open(u, '3EB0EYES0005');
  await prompt(u);
  await open(u, '3EB0EYES0006'); // arrives while the first turn runs
  await progress(u, 'reply');   // the FIRST turn answers
  timers.fireAll();              // fifteen seconds on: the second is still waiting
  assert.deepEqual(eyes().map((m) => m.messageId), ['3EB0EYES0006']);
  await progress(u, 'end');
  await prompt(u);               // its own turn starts
  assert.deepEqual(await progress(u, 'reply'), { ok: true, held: false }, 'already on — nothing to drop');
});

test('a turn Olma started cancels nobody\'s 👀', async () => {
  const u = await person();
  await open(u, '3EB0EYES0007');
  selfInitiated.begin(u.id);
  await prompt(u); // a --deliver turn builds its prompt with no open
  assert.deepEqual(await progress(u, 'reply'), { ok: true, held: false });
  selfInitiated._reset();
  timers.fireAll();
  assert.deepEqual(eyes().map((m) => m.messageId), ['3EB0EYES0007']);
});

test('the answers that ARE the mark are never held, and an old plugin gets the immediate 👀', async () => {
  const u = await person();
  await open(u, '3EB0EYES0008', { thanks: true });
  assert.deepEqual(marks.map((m) => m.state), ['thanks']);
  assert.deepEqual(timers.pending(), []);
  signals = false;
  await open(u, '3EB0EYES0009');
  assert.deepEqual(eyes().map((m) => m.messageId), ['3EB0EYES0009']);
  assert.deepEqual(timers.pending(), []);
  signals = true;
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, reactions.EYES_DELAY_FLAG, 0));
  await open(u, '3EB0EYES0010');
  assert.equal(eyes().at(-1).messageId, '3EB0EYES0010', 'the flag at 0 is the old behaviour');
});

test('turn_progress refuses what is not a person\'s agent or a known signal', async () => {
  assert.equal((await dispatch('turn_progress', { agentId: 'g-7', what: 'reply' })).ok, false);
  assert.equal((await dispatch('turn_progress', { agentId: 'u-1', what: 'maybe' })).ok, false);
  assert.deepEqual(await dispatch('turn_progress', { agentId: 'u-99999', what: 'end' }), { ok: true, held: false });
});

test('the plugin says "end" for a person\'s turn, never for a room\'s, and never touches the turn', async () => {
  const plugin = await import('../gateway-plugin/olma-turn/index.js');
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; if (ev === 'connect') setTimeout(() => fn(), 0); return s; },
      write(line) { sent.push(JSON.parse(line)); setTimeout(() => h.data && h.data(JSON.stringify({ id: 1, ok: true }) + '\n'), 0); },
      end() {}, destroy() {},
    };
    return s;
  };
  const handler = plugin.buildTurnEndHandler({ connect });
  assert.equal(await handler({ success: true, messages: [] }, { agentId: 'u-3' }), undefined);
  assert.equal(await handler({ success: false, messages: [] }, { sessionKey: 'agent:u-4:whatsapp:direct:+972500000000' }), undefined);
  await handler({ success: true, messages: [] }, { agentId: 'g-7' });
  await handler({ success: true, messages: [] }, { agentId: 'main' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.map((m) => [m.method, m.params]), [
    ['turn_progress', { agentId: 'u-3', what: 'end' }],
    ['turn_progress', { agentId: 'u-4', what: 'end' }],
  ]);
});
