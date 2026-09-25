'use strict';
// "להוסיף לך את המשימה ליומן?" → "תודה". The thanks was read as a closed
// exchange: 🙏 on it, NO_REPLY asked for, and the offer silently dropped.
// Owner, 2026-09-26: after a question of Olma's the model decides what the
// thanks meant, and it most likely means yes. The plugin says whether each
// reply ended on a question; brokerd remembers the newest one per person.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const flagsDomain = require('../src/domain/flags');
const turnDomain = require('../src/domain/turn');
const selfInitiated = require('../src/domain/self-initiated');
const reactions = require('../src/domain/reactions');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `thanks-question-plugin-test-${process.pid}.log`);

let db, broker, marks, now;
before(async () => {
  db = await freshDb();
  now = Date.now();
  marks = [];
  broker = createBrokerServer({
    pool: db.pool, now: () => now, endSignalsLive: () => false,
    placeMark: (o) => { marks.push(o); return { attempted: true }; },
  });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, 'all'));
});
after(async () => { await db.teardown(); });
beforeEach(() => { marks.length = 0; selfInitiated._reset(); });

let seq = 0;
async function person() {
  seq += 1;
  const u = await makeUser(db.pool, `+9726431${String(seq).padStart(4, '0')}`);
  const agentId = `u-${800 + seq}`;
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [u.id, agentId]);
  return { ...u, agentId };
}
const dispatch = (method, params) => broker.dispatch({ id: 1, method, params });
const replied = (u, asked) => dispatch('turn_progress', { agentId: u.agentId, what: 'reply', asked });
const thanks = (u, messageId) => dispatch('turn_open', { agentId: u.agentId, messageId, kind: 'text', thanks: true });
const hints = async (u) => {
  const res = await dispatch('turn_context', { agentId: u.agentId, sessionKey: `agent:${u.agentId}:whatsapp:direct:${u.phone}` });
  return JSON.parse(res.context.split('\n')[1].replace(/^OK /, '')).hints;
};

test('a thanks right after a question is an answer: no 🙏, the ordinary 👀, and the model decides', async () => {
  const u = await person();
  await replied(u, true);
  await thanks(u, '3EB0THXQ0001');
  assert.deepEqual(marks.map((m) => m.state), ['working']);
  const h = await hints(u);
  assert.equal(h.thanksOnly, undefined, 'no request for silence');
  assert.match(h.thanksAfterQuestion, /most likely a yes/);
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'turn.thanks_after_question'`, [u.id]);
  assert.equal(rows[0].n, 1, 'counted, so the rate can be read');
});

test('a thanks after a reply that asked nothing closes the exchange as before', async () => {
  const u = await person();
  await replied(u, false);
  await thanks(u, '3EB0THXQ0002');
  assert.deepEqual(marks.map((m) => m.state), ['thanks']);
  const h = await hints(u);
  assert.match(h.thanksOnly, /NO_REPLY/);
  assert.equal(h.thanksAfterQuestion, undefined);
});

test('only the NEWEST reply counts, and the question is spent by the answer', async () => {
  const u = await person();
  await replied(u, true);
  await replied(u, false); // a later reply that closed it
  await thanks(u, '3EB0THXQ0003');
  assert.deepEqual(marks.map((m) => m.state), ['thanks']);
  await hints(u);
  marks.length = 0;
  await replied(u, true);
  await thanks(u, '3EB0THXQ0004');
  await hints(u);
  await thanks(u, '3EB0THXQ0005'); // a second thanks with nothing said between
  assert.deepEqual(marks.map((m) => m.state), ['working', 'thanks']);
});

test('a question too old to be answering is a closed day', async () => {
  const u = await person();
  await replied(u, true);
  now += reactions.THANKS_AFTER_QUESTION_MS + 1000;
  await thanks(u, '3EB0THXQ0006');
  assert.deepEqual(marks.map((m) => m.state), ['thanks']);
});

test('one person\'s question is nobody else\'s', async () => {
  const a = await person();
  const b = await person();
  await replied(a, true);
  await thanks(b, '3EB0THXQ0007');
  assert.deepEqual(marks.map((m) => m.state), ['thanks']);
});

test('the plugin reads the question off the END of what is sent', async () => {
  const plugin = await import('../gateway-plugin/olma-turn/index.js');
  const yes = ['רשמתי 👍\nלהוסיף לך את המשימה ליומן?', 'להוסיף ליומן? 🙂', 'Want me to add it?', 'أضيفها؟',
    'רוצה שאזכיר גם מחר?\nhttps://allma.world/me'];
  const no = ['רשמתי', 'מה?\nרשמתי.', '', 'נוח לך שלישי?\nאפשר לענות לי כאן בצ\'אט או דרך הקישור:\nhttps://allma.world/me?meeting=5'];
  for (const t of yes) assert.equal(plugin.endsWithQuestion(t), true, t);
  for (const t of no) assert.equal(plugin.endsWithQuestion(t), false, t);

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
  const gate = plugin.buildReplyGateHandler({ connect, log: () => {} });
  const key = 'agent:u-5:whatsapp:direct:+972500000000';
  await gate({ sessionKey: key, payload: { text: 'רשמתי. להוסיף לך את זה ליומן?' } }, {});
  await gate({ sessionKey: key, payload: { text: 'רשמתי 👍' } }, {});
  await gate({ sessionKey: key, payload: { text: '', mediaUrl: 'file:///x.png' } }, {});
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent.filter((m) => m.method === 'turn_progress').map((m) => m.params.asked), [true, false, false]);
});
