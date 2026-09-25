'use strict';
// A message in the room that never named her: the stamp that opens her
// fifteen-minute window is taken, and the message ends before any model turn
// exists. The owner asked for the first half twice; the second half is why it
// could not be built until `before_dispatch` — a claiming hook — was found
// (domain/group-context.js, "A message in the room that never named her").
//
// The corpus below is run against BOTH implementations of the addressing rule:
// the domain module and the plugin's port of it, which is the copy that
// actually runs inside the gateway. Same shape as tests/reply-leak.test.js,
// for the same reason — the port being missed is a real failure this repo has
// already had.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const groups = require('../src/domain/groups');
const groupContext = require('../src/domain/group-context');
const groupMeetings = require('../src/domain/group-meetings');
const flagsDomain = require('../src/domain/flags');
process.env.OLMA_PLUGIN_TRACE = path.join(os.tmpdir(), `group-untagged-plugin-test-${process.pid}.log`);

let db, broker, plugin;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool });
  plugin = await import('../gateway-plugin/olma-turn/index.js');
});
after(async () => { await db.teardown(); });

const SELF = groupContext.SELF_DIGITS();
const JID = (n) => `12036377777777${n}@g.us`;
const write = (params) => broker.dispatch({ id: 1, method: 'group_room_write', params });

// Every case names what it is and what the answer must be. `true` = addressed
// to her, so the turn runs exactly as it does today.
const CORPUS = [
  ['a tag, as WhatsApp puts it in the body', { body: `@${SELF} תתאמי לנו משחק` }, true],
  ['a tag with the room saying nothing else', { body: `@${SELF}` }, true],
  ['a reply to one of her own messages', { body: 'כן בשבילי מסתדר', replyToSender: `${SELF}@s.whatsapp.net` }, true],
  ['her number written out in the message', { body: `תשמרו את המספר שלה ${SELF}` }, true],
  ['a plain message to the room', { body: 'אני יכול מחר בערב' }, false],
  ['a tag of somebody ELSE in the room', { body: '@972526269826 אתה בא?' }, false],
  ['a reply to another member', { body: 'גם אני', replyToSender: '972526269826@s.whatsapp.net' }, false],
  ['no body at all', {}, false],
  ['an empty body', { body: '' }, false],
];

test('the addressing rule, on one corpus, in both implementations', () => {
  for (const [name, event, expected] of CORPUS) {
    assert.equal(groupContext.addressedToHer(event), expected, `domain: ${name}`);
    assert.equal(plugin.addressedToHer(event), expected, `plugin port: ${name}`);
  }
});

test('not knowing her own number means never claiming anything', () => {
  for (const [, event] of CORPUS) {
    assert.equal(groupContext.addressedToHer(event, ''), true, 'domain');
    assert.equal(plugin.addressedToHer(event, ''), true, 'plugin port');
  }
});

test('a LID is not a phone number and is never read as one', () => {
  assert.equal(groupContext.senderPhone('972526269826@s.whatsapp.net'), '+972526269826');
  assert.equal(groupContext.senderPhone('972526269826'), '+972526269826');
  assert.equal(groupContext.senderPhone('184736251029384@lid'), null, 'the mapping lives in the channel store, which is not a source');
  assert.equal(groupContext.senderPhone(''), null);
  assert.equal(groupContext.senderPhone('12345'), null);
  assert.equal(groupContext.senderPhone(null), null);
});

test('the flag is empty by default, and names rooms one at a time', () => {
  assert.equal(flagsDomain.DEFAULTS[groupContext.UNTAGGED_FLAG], '', 'nobody until somebody says so');
  assert.equal(groupContext.roomClaimEnabled('', JID(1)), false);
  assert.equal(groupContext.roomClaimEnabled(null, JID(1)), false);
  assert.equal(groupContext.roomClaimEnabled(JID(1), JID(1)), true);
  assert.equal(groupContext.roomClaimEnabled(`${JID(2)}, ${JID(1)}`, JID(1)), true);
  assert.equal(groupContext.roomClaimEnabled(JID(2), JID(1)), false, 'one room named is not another room named');
  assert.equal(groupContext.roomClaimEnabled('all', JID(1)), true);
});

// Three people who have written to her privately, in an open room with a
// coordination running and one invite held for the night.
async function roomWithAHeldInvite(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726077${String(n).padStart(2, '0')}00${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (client) => {
    const reg = await groups.registerGroup(client, {
      externalId: JID(n), subject: 'פאדל', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await client.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פאדל השבוע'));
  assert.equal(started.ok, true);
  // Their invite, held for the night — the row the window is supposed to reach.
  const tomorrow = new Date(Date.now() + 8 * 3600_000);
  await db.pool.query(
    `UPDATE outbox SET hold_reason = 'night', release_after = $2
      WHERE user_id = $1 AND kind = 'meeting_invite' AND sent_at IS NULL`,
    [people[1].id, tomorrow]);
  return { group, people, meetingId: Number(started.data.meeting.id) };
}

const heldRelease = async (userId) => (await db.pool.query(
  `SELECT release_after FROM outbox WHERE user_id = $1 AND kind = 'meeting_invite' AND sent_at IS NULL`,
  [userId])).rows[0].release_after;

test('an untagged message stamps the window and re-hears the held invite, with the flag still empty', async () => {
  const { group, people } = await roomWithAHeldInvite(1);
  const before = await heldRelease(people[1].id);
  const at = Date.now();

  const r = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: `${people[1].phone.replace('+', '')}@s.whatsapp.net`, addressed: false, at,
  });
  assert.deepEqual(r, { ok: true, addressed: false, stamped: true, sender: true, claim: false },
    'the stamp is always right; the silencing waits for the flag');

  const { rows } = await db.pool.query(
    `SELECT last_wrote_at FROM chat_group_members WHERE group_id = $1 AND phone = $2`,
    [group.id, people[1].phone]);
  assert.equal(rows[0].last_wrote_at.getTime(), at, 'stamped at the moment they wrote, not at now()');
  const after = await heldRelease(people[1].id);
  assert.ok(after < before, 'and the invite they are owed is re-heard');
  assert.equal(after.getTime(), at);
});

test('with the room named in the flag, the message is claimed — and only that room', async () => {
  const { group, people } = await roomWithAHeldInvite(2);
  const other = await roomWithAHeldInvite(3);
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, groupContext.UNTAGGED_FLAG, group.external_id));

  const mine = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: `${people[1].phone.replace('+', '')}@s.whatsapp.net`, addressed: false, at: Date.now(),
  });
  assert.equal(mine.claim, true, 'no model turn is ever started for this message');

  const theirs = await write({
    agentId: other.group.agent_id, externalId: other.group.external_id,
    senderId: `${other.people[1].phone.replace('+', '')}@s.whatsapp.net`, addressed: false, at: Date.now(),
  });
  assert.equal(theirs.claim, false, 'one room named is not every room named');
  assert.equal(theirs.stamped, true, 'and its window opened anyway');

  // An ADDRESSED message is never claimed, whatever the flag says: it keeps the
  // turn it has always had, and `group_context` stamps it off the Conversation
  // info block with the sender the gateway named.
  const tagged = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: `${people[1].phone.replace('+', '')}@s.whatsapp.net`, addressed: true, at: Date.now(),
  });
  assert.deepEqual(tagged, { ok: true, addressed: true, stamped: false, sender: true, claim: false });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, groupContext.UNTAGGED_FLAG, ''));
});

test('a locked room, another room\'s agent, a stranger, a LID — none of them claim', async () => {
  const { group } = await roomWithAHeldInvite(4);
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, groupContext.UNTAGGED_FLAG, 'all'));

  // Somebody in the room WhatsApp knows only by LID: nothing to stamp, and the
  // message is still claimed, because whether she answers is about the message
  // and not about whether we could name the person.
  const lid = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: '184736251029384@lid', addressed: false, at: Date.now(),
  });
  assert.deepEqual(lid, { ok: true, addressed: false, stamped: false, sender: false, claim: true });

  // A phone that is not in this room's roster: same answer, no stamp.
  const stranger = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: '972500000999@s.whatsapp.net', addressed: false, at: Date.now(),
  });
  assert.equal(stranger.stamped, false);
  assert.equal(stranger.claim, true);

  await db.pool.query(`UPDATE chat_groups SET state = 'locked' WHERE id = $1`, [group.id]);
  const locked = await write({
    agentId: group.agent_id, externalId: group.external_id,
    senderId: '972500000999@s.whatsapp.net', addressed: false, at: Date.now(),
  });
  assert.equal(locked.claim, false, 'a locked room has no coordination and hears only fixed text');

  assert.deepEqual(await write({ agentId: 'ggreet', externalId: group.external_id }), { ok: false, error: 'bad agentId' });
  assert.deepEqual(await write({ agentId: 'u-3', externalId: group.external_id }), { ok: false, error: 'bad agentId' });
  assert.deepEqual(await write({ agentId: group.agent_id, externalId: 'not-a-jid' }), { ok: false, error: 'bad externalId' });
  assert.deepEqual(await write({ agentId: group.agent_id, externalId: JID(9) }), { ok: false, error: 'no group' });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, groupContext.UNTAGGED_FLAG, ''));
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
const KEY = 'agent:g-7:whatsapp:group:120363431246653169@g.us';

test('the plugin claims only on an explicit claim, and the room\'s words never leave the gateway', async () => {
  const log = [];
  const { connect, sent } = fakeConnect({ id: 1, ok: true, addressed: false, stamped: true, sender: true, claim: true });
  const handler = plugin.buildRoomWriteHandler({ connect, log: (o) => log.push(o) });

  const out = await handler({ sessionKey: KEY, body: 'אני יכול מחר', senderId: '972526269826@s.whatsapp.net' }, {});
  assert.deepEqual(out, { handled: true }, 'the message ends here: no turn, so nothing that could answer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'group_room_write');
  assert.deepEqual(Object.keys(sent[0].params).sort(), ['addressed', 'agentId', 'at', 'externalId', 'senderId']);
  assert.equal(sent[0].params.addressed, false);
  assert.equal(sent[0].params.externalId, '120363431246653169@g.us');
  assert.ok(!JSON.stringify(sent).includes('אני יכול מחר'), 'the body is read here and sent nowhere');
  assert.deepEqual(log.at(-1).addressed, false);
  assert.equal(log.at(-1).claim, true);
  assert.equal(log.at(-1).senderShape, 'phone');
  assert.ok(!JSON.stringify(log).includes('972526269826'), 'and the trace says the SHAPE, never the number');

  // A tagged message is reported and never claimed — and this fake brokerd
  // answers `claim: true` to everything, so what refuses it here is the
  // plugin's own second refusal and nothing else.
  const tagged = await handler({ sessionKey: KEY, body: `@${SELF} מה קורה`, senderId: '972526269826@s.whatsapp.net' }, {});
  assert.equal(tagged, undefined, 'two independent refusals, so a brokerd bug cannot silence a real question');
  assert.equal(sent[1].params.addressed, true);
});

test('the plugin fails open: a refusal, claim:false, a dead socket, and anything that is not a room', async () => {
  const log = [];
  const mk = (reply) => plugin.buildRoomWriteHandler({ connect: fakeConnect(reply).connect, log: (o) => log.push(o) });
  const ev = { sessionKey: KEY, body: 'שלום', senderId: '972526269826@s.whatsapp.net' };
  assert.equal(await mk({ id: 1, ok: true, addressed: false, stamped: true, sender: true, claim: false })(ev, {}), undefined);
  assert.equal(await mk({ id: 1, ok: false, error: 'no group' })(ev, {}), undefined);
  assert.equal(log.at(-1).outcome, 'refused');
  const dead = () => {
    const h = {};
    const s = { on(ev2, fn) { h[ev2] = fn; return s; }, write() {}, end() {}, destroy() {} };
    setTimeout(() => h.error && h.error(new Error('ECONNREFUSED')), 0);
    return s;
  };
  assert.equal(await plugin.buildRoomWriteHandler({ connect: dead, log: (o) => log.push(o) })(ev, {}), undefined);
  assert.equal(log.at(-1).outcome, 'unreachable');

  // A DM, the greeter's locked room, and the default agent: not ours to claim.
  const { connect, sent } = fakeConnect({ id: 1, ok: true, claim: true });
  const h = plugin.buildRoomWriteHandler({ connect, log: () => {} });
  assert.equal(await h({ sessionKey: 'agent:u-3:whatsapp:direct:+972526269826', body: 'x' }, {}), undefined);
  assert.equal(await h({ sessionKey: 'agent:ggreet:whatsapp:group:1203634@g.us', body: 'x' }, {}), undefined);
  assert.equal(await h({ sessionKey: 'agent:main:whatsapp:group:1203634@g.us', body: 'x' }, {}), undefined);
  assert.equal(await h({ body: 'x' }, {}), undefined);
  assert.equal(sent.length, 0, 'and none of them asked brokerd anything');
});

test('the plugin registers before_dispatch beside its other hooks', async () => {
  const hooks = [];
  plugin.default.register({
    pluginConfig: {},
    on: (name) => hooks.push(name),
  });
  assert.deepEqual(hooks, ['before_prompt_build', 'llm_input', 'before_dispatch', 'before_dispatch', 'reply_payload_sending', 'agent_end']);
});
