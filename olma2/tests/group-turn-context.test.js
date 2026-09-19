'use strict';
// The room's own state, in front of the model on every turn its agent takes.
// Until 2026-09-19 a group turn got nothing — the plugin's prompt handler
// bailed on anything that was not `u-N` — and the model answered the room from
// its conversation history: "2 of 4 group members answered" to a room of three
// where nobody had answered, and "there is already a coordination open" 74
// seconds after the only one was cancelled (`docs/incidents.md`, "The room
// heard its own state from memory"). Both of those sentences are what this file
// is about: the numbers, and the state of a coordination that is no longer one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const options = require('../src/domain/meeting-options');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `group-turn-plugin-test-${process.pid}.log`);

let db, broker, plugin;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });

const JID = (n) => `12036399999999${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);
const ask = (params) => broker.dispatch({ id: 1, method: 'group_turn_context', params });
// The block is header, one rendered result, then the rule — the JSON is the
// second line, exactly as the person's turn context is read.
const parse = (ctx) => JSON.parse(ctx.split('\n')[1].replace(/^OK /, ''));

// Three people who have all written to her privately, in an open room.
async function room(n, { subject = 'פאדל חמישי', people: howMany = 3 } = {}) {
  const people = [];
  for (let i = 0; i < howMany; i++) {
    const u = await makeUser(db.pool, `+9726099${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (client) => {
    const reg = await groups.registerGroup(client, {
      externalId: JID(n), subject, members: people.map((u) => ({ phone: u.phone })),
    });
    assert.ok(reg.ok, 'the fixture group registered');
    const { rows } = await client.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people, key: `agent:${group.agent_id}:whatsapp:group:${JID(n)}` };
}

test('a room with nothing running is told so, with the two numbers it got wrong', async () => {
  const { group, people } = await room(1);
  // One of the three has never written to her: in the room, not counted in.
  await db.pool.query(`UPDATE users SET last_inbound_at = NULL, opening_sent_at = NULL WHERE id = $1`, [people[2].id]);

  const r = await ask({ agentId: group.agent_id, externalId: group.external_id });
  assert.equal(r.ok, true);
  const data = parse(r.context);
  assert.deepEqual(data, { room: { members: 3, countedIn: 2, kind: null }, coordination: null });
  // The sentence that cannot be said from this: the room has no minimum
  // because nobody has told her what kind of room it is.
  assert.ok(!/minimum/.test(r.context), 'no quorum to reason from until somebody says the kind');
  assert.ok(r.context.includes('`coordination: null` means'), 'and the block says what null means');
});

test('a running coordination: the title, how many were asked, how many answered, and the times on the table', async () => {
  const { group, people } = await room(2, { subject: 'פוקר של רביעי' });
  const [danny, dana, yuval] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, danny, 'פוקר השבוע'));
  assert.equal(started.ok, true);
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('רביעי', { hours: 96 });
  const optionId = await withTx(db.pool, async (c) => {
    const added = await options.add(c, danny.id, meetingId, 'רביעי 21:00', when);
    assert.equal(added.ok, true);
    return Number(added.data.option.id);
  });
  await withTx(db.pool, async (c) => {
    await options.answer(c, dana.id, meetingId, optionId, 'n');
  });

  const data = parse((await ask({ agentId: group.agent_id, externalId: group.external_id })).context);
  assert.equal(data.room.members, 3);
  assert.equal(data.coordination.meetingId, meetingId);
  assert.equal(data.coordination.title, 'פוקר השבוע');
  assert.equal(data.coordination.asked, 3, 'everybody counted in, the person who asked included');
  // Putting a time on the table IS answering it — `options.add` writes the
  // proposer's own yes — so two of the three have answered and one has not.
  assert.equal(data.coordination.answered, 2);
  assert.deepEqual(data.coordination.waitingFor, ['יובל']);
  assert.equal(data.coordination.waitingFor.length, data.coordination.asked - data.coordination.answered,
    'the two numbers and the list are one fact and must agree');
  assert.deepEqual(data.coordination.onTable, [{ optionId, slot: 'רביעי 21:00', yes: 1, no: 1 }]);
  assert.equal(Number(yuval.id) > 0, true);
});

test('a cancelled coordination is not an open one, and the block can say which', async () => {
  const { group, people } = await room(3);
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פאדל'));
  assert.equal(started.ok, true);
  const meetingId = Number(started.data.meeting.id);

  let data = parse((await ask({ agentId: group.agent_id, externalId: group.external_id })).context);
  assert.equal(data.coordination.meetingId, meetingId);
  assert.equal(data.lastCoordination, undefined);

  await db.pool.query(`UPDATE meetings SET status = 'cancelled' WHERE id = $1`, [meetingId]);
  data = parse((await ask({ agentId: group.agent_id, externalId: group.external_id })).context);
  assert.equal(data.coordination, null, 'the one sentence she got wrong 74 seconds after a cancel');
  assert.deepEqual(data.lastCoordination, { meetingId, title: 'פאדל', status: 'cancelled' });
});

test('the block never carries the room\'s own row, and a nameless member is still counted', async () => {
  const { group, people } = await room(4);
  // Nobody has a name at all, which is where a room-facing label falls back to
  // the phone (`group-meetings.memberLabel`, and the gate notice tags people by
  // number for the same reason).
  await db.pool.query(`UPDATE users SET first_name = NULL WHERE id = ANY($1)`, [people.map((u) => u.id)]);
  await db.pool.query(`UPDATE chat_group_members SET display_name = NULL WHERE group_id = $1`, [group.id]);
  await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'משחק'));

  const { context } = await ask({ agentId: group.agent_id, externalId: group.external_id });
  assert.ok(!context.includes(TOKEN(4)), 'the room\'s identity token is its door and never travels');
  assert.ok(!context.includes('identity_token'));
  // The label is whatever the room's other surfaces already say — and it is
  // NOT dropped for being a number. A `waitingFor` short of `asked - answered`
  // would be the false sentence this whole block exists to stop.
  const data = parse(context);
  assert.equal(data.coordination.waitingFor.length, 3);
  assert.equal(data.coordination.asked - data.coordination.answered, 3);
});

test('brokerd answers only about the room the caller actually is', async () => {
  const { group } = await room(5);
  const other = await room(6);
  assert.deepEqual(await ask({ agentId: group.agent_id, externalId: other.group.external_id }),
    { ok: false, error: 'no group' }, 'one of the two names alone would be a lookup that trusts the caller');
  assert.deepEqual(await ask({ agentId: 'ggreet', externalId: group.external_id }), { ok: false, error: 'bad agentId' });
  assert.deepEqual(await ask({ agentId: 'u-3', externalId: group.external_id }), { ok: false, error: 'bad agentId' });
  assert.deepEqual(await ask({ agentId: group.agent_id, externalId: 'not-a-jid' }), { ok: false, error: 'bad externalId' });
  assert.deepEqual(await ask({ agentId: group.agent_id, externalId: `1203639999999999@g.us` }), { ok: false, error: 'no group' });
  // A locked room hears nothing but fixed text on the raw pipe, so there is no
  // state for its model to be given.
  await db.pool.query(`UPDATE chat_groups SET state = 'locked' WHERE id = $1`, [group.id]);
  assert.deepEqual(await ask({ agentId: group.agent_id, externalId: group.external_id }),
    { ok: true, context: null, state: 'locked' });
});

// ---- the plugin side, with no gateway and no socket ------------------------
function fakeConnect(reply) {
  const sent = [];
  const connect = () => {
    const h = {};
    const s = {
      on(ev, fn) { h[ev] = fn; return s; },
      write(x) { sent.push(JSON.parse(x)); setTimeout(() => h.data && h.data(JSON.stringify(reply) + '\n'), 0); },
      end() { h.close && h.close(); }, destroy() {},
    };
    setTimeout(() => h.connect && h.connect(), 0);
    return s;
  };
  return { connect, sent };
}

test('a group turn goes to group_turn_context by both names, and the greeter is left alone', async () => {
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, context: 'Room coordination (…):\nOK {"coordination":null}\nEvery sentence…' });
  // The `agents` list is which PEOPLE get their turn context; a room is never
  // on it and must not be gated by it.
  const handler = plugin.buildHandler({ agents: ['u-3'], connect, log: (o) => log.push(o) });
  const out = await handler(
    { prompt: 'מה עם הפאדל?' },
    { agentId: 'g-7', sessionKey: 'agent:g-7:whatsapp:group:120363431246653169@g.us' });
  assert.deepEqual(out, { prependContext: 'Room coordination (…):\nOK {"coordination":null}\nEvery sentence…' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'group_turn_context');
  assert.deepEqual(sent[0].params, { agentId: 'g-7', externalId: '120363431246653169@g.us' });
  assert.ok(!JSON.stringify(sent).includes('פאדל'), 'the room\'s words never leave the gateway');
  assert.equal(log.at(-1).turn, 'prepended');

  // The greeter speaks for a locked room and has no coordination to be told
  // about; `main` and a DM key are somebody else's route entirely.
  assert.equal(await handler({ prompt: 'x' }, { sessionKey: 'agent:ggreet:whatsapp:group:1203634@g.us' }), undefined);
  assert.equal(await handler({ prompt: 'x' }, { sessionKey: 'agent:main:whatsapp:group:1203634@g.us' }), undefined);
  assert.equal(sent.length, 1, 'and neither of them asked brokerd anything');
});

test('a group turn fails open: a refusal, a null context, a dead socket', async () => {
  const log = [];
  const ctx = { agentId: 'g-9', sessionKey: 'agent:g-9:whatsapp:group:1203634@g.us' };
  const mk = (reply) => plugin.buildHandler({ connect: fakeConnect(reply).connect, log: (o) => log.push(o) });
  assert.equal(await mk({ id: 1, ok: false, error: 'no group' })({ prompt: 'x' }, ctx), undefined);
  assert.equal(await mk({ id: 1, ok: true, context: null, state: 'locked' })({ prompt: 'x' }, ctx), undefined);
  assert.deepEqual(log.map((l) => l.turn), ['refused', 'no-context']);
  assert.equal(log.at(-1).state, 'locked', 'nothing to say and could not be read are different observations');
  const dead = () => {
    const h = {};
    const s = { on(ev, fn) { h[ev] = fn; return s; }, write() {}, end() {}, destroy() {} };
    setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0);
    return s;
  };
  assert.equal(await plugin.buildHandler({ connect: dead, log: (o) => log.push(o) })({ prompt: 'x' }, ctx), undefined);
  assert.equal(log.at(-1).turn, 'unreachable');
});
