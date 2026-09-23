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
const groupTurn = require('../src/domain/group-turn');
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
  // `people` is here even with nothing running, and that is the point: the
  // turn that failed on 2026-09-23 had a SETTLED coordination, so a roster
  // that only appeared during a negotiation would have been absent exactly
  // when a tag needed matching. No lid map in this fixture, so tags only.
  assert.deepEqual(data, {
    room: {
      members: 3, countedIn: 2, kind: null,
      people: people.map((u) => ({ tag: `@${u.phone}` })),
    },
    coordination: null,
  });
  // The sentence that cannot be said from this: the room has no minimum
  // because nobody has told her what kind of room it is.
  assert.ok(!/minimum/.test(r.context), 'no quorum to reason from until somebody says the kind');
  assert.ok(r.context.includes('`coordination: null` means'), 'and the block says what null means');
});

// The model speaks in the room, so the block names only the people this
// coordination has actually reached (`group-meetings.statusOf`'s `asked`,
// 2026-09-22). No worker runs here, so a test about the LIST marks the invites
// delivered by hand; a test about the gap holds one back.
async function deliverInvites(meetingId) {
  await db.pool.query(
    `UPDATE outbox SET sent_at = coalesce(sent_at, now()), hold_reason = NULL, release_after = NULL
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1`, [meetingId]);
}

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
  await deliverInvites(meetingId);

  const data = parse((await ask({ agentId: group.agent_id, externalId: group.external_id })).context);
  assert.equal(data.room.members, 3);
  assert.equal(data.coordination.meetingId, meetingId);
  assert.equal(data.coordination.title, 'פוקר השבוע');
  assert.equal(data.coordination.asked, 3, 'everybody counted in, the person who asked included');
  // Putting a time on the table IS answering it — `options.add` writes the
  // proposer's own yes — so two of the three have answered and one has not.
  assert.equal(data.coordination.answered, 2);
  // A TAG, not a name (owner, 2026-09-20): in the room she addresses people
  // with the token that actually notifies them, and the name each person sees
  // for somebody else is theirs, not ours. The block draws it so there is
  // nothing for the model to assemble — and nothing it could assemble wrong,
  // which is how "M&M" left the room as "מאיה ומירון".
  assert.deepEqual(data.coordination.waitingFor, [`@${yuval.phone}`]);
  assert.match(groupTurn.TAG_RULE, /To reach a person in this room, use their `tag`/);
  // Both halves of the incoming-tag rule, which has now been wrong in both
  // directions. 2026-09-20: she opened with her OWN LID — the token Yuval had
  // used to tag her — as if it were his. 2026-09-23: Miron tagged Yuval's lid
  // and she told the room she did not recognise it, about a man she had tagged
  // herself three hours earlier. So the rule has to send her to `room.people`
  // first, and to silence when nothing matches.
  assert.match(groupTurn.TAG_RULE, /match its digits against `lid` and `tag` in `room\.people`/);
  assert.match(groupTurn.TAG_RULE, /ignore it silently/);
  assert.match(groupTurn.TAG_RULE, /Never tell the room that you do not recognise a token/);
  assert.equal(data.coordination.waitingFor.length + (data.coordination.notYetAsked || 0),
    data.coordination.asked - data.coordination.answered,
    'the two numbers and the list are one fact and must agree');
  assert.equal(data.coordination.notYetAsked, undefined, 'everybody here has been written to');
  assert.deepEqual(data.coordination.onTable, [{ optionId, slot: 'רביעי 21:00', yes: 1, no: 1 }]);
  assert.equal(Number(yuval.id) > 0, true);

  // And the other half of the rule the owner asked for on 2026-09-22: while
  // Yuval's invite is still held for the night, he is not somebody who has not
  // answered — he is somebody nobody has asked. He is a COUNT with no tag, so
  // the model has nobody to name and the numbers still add up.
  await db.pool.query(
    `UPDATE outbox SET sent_at = NULL, hold_reason = 'night' WHERE kind = 'meeting_invite'
       AND user_id = $1 AND (payload->>'meetingId')::bigint = $2`, [yuval.id, meetingId]);
  const held = parse((await ask({ agentId: group.agent_id, externalId: group.external_id })).context);
  assert.deepEqual(held.coordination.waitingFor, []);
  assert.equal(held.coordination.notYetAsked, 1);
  assert.equal(held.coordination.answered, 2, 'the count of who answered does not move');
  assert.equal(held.coordination.waitingFor.length + held.coordination.notYetAsked,
    held.coordination.asked - held.coordination.answered);
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
  const nameless = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'משחק'));
  await deliverInvites(Number(nameless.data.meeting.id));

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

// 2026-09-23. Miron wrote in Padel Gang `@<Yuval's lid> סוגר לנו מקום?` and she
// answered the room "אני לא יודעת מי @יובל גליזרין — מזהה כזה לא מוכר לי
// מהקבוצה" — about a man she had tagged herself three hours earlier, in her own
// "בפנים" line. The coordination was settled, so the block carried no tags at
// all, and TAG_RULE told her every `@<digits>` in an incoming message was
// nobody's. She had a token she could not resolve, an instruction saying it
// meant nothing, and no data — and she narrated that to the room.
//
// The gateway's reverse map had the answer on disk the whole time
// (`lid-mapping-68758282444950_reverse.json` -> `972544686188`).
// (`incidents.md`, "The room that did not know its own member".)
test('an incoming tag is a member the block can name, even once the coordination has settled', async () => {
  const { group, people } = await room(7, { subject: 'Padel Gang' });
  const [ann, ben, yuval] = people;
  // The one thing the failing turn had that the fixture above does not: a
  // coordination that is over. It returns early in `draw`, which is why the
  // roster had to move up into `room`.
  const m = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, ann, 'פאדל'));
  assert.equal(m.ok, true, JSON.stringify(m.error));
  await db.pool.query(
    `UPDATE meetings SET status = 'confirmed', confirmed_slot = 'שבת 17:00' WHERE id = $1`,
    [m.data.meeting.id]);

  // The gateway's own map, injected rather than read: a test file must never
  // reach the live gateway's credentials directory.
  const lid = '68758282444950';
  const withMap = createBrokerServer({
    pool: db.pool,
    lidPhoneNumbers: async () => ({ [lid]: yuval.phone }),
  });
  const r = await withMap.dispatch({
    id: 1, method: 'group_turn_context',
    params: { agentId: group.agent_id, externalId: group.external_id },
  });
  assert.equal(r.ok, true);
  const data = parse(r.context);
  assert.equal(data.coordination, null, 'settled — the shape that carried no tags before');
  assert.deepEqual(data.room.people, [
    { tag: `@${ann.phone}` },
    { tag: `@${ben.phone}` },
    { tag: `@${yuval.phone}`, lid },
  ], 'every member here is a phone, and the one we can recognise carries the lid too');
  // The whole point: the digits that arrived in the message are findable, and
  // what she must write back is the tag beside them.
  assert.ok(r.context.includes(lid), 'the incoming token is in the block to match against');
  assert.ok(r.context.includes(`@${yuval.phone}`), 'and the tag that actually notifies him is beside it');
});

// Read off the live roster of the room this incident happened in: three of
// Padel Gang's eight rows are lids stored where a phone goes, and their
// lengths are 13, 14 and 15. `proactive-text.isTaggableNumber` caps a tag at
// 13, so the first of them gets one and the other two get `mentionToken` ->
// null. The first draft of `peopleOf` filtered those out, which put her back
// exactly where the incident started: a token that matches nobody, about
// somebody standing in the room.
test('a member we cannot tag is still a member, and a tag is never assembled from nothing', () => {
  assert.deepEqual(groupTurn.peopleOf([
    { phone: '+972544686188' },   // 12 — a phone, tagged
    { phone: '+6266525098172' },  // 13 — a lid short enough to tag, and tagging it works
    { phone: '+69320805752936' }, // 14 — no tag, and still somebody
    { phone: '+259201444126724' },// 15 — the same
    { phone: '' },                // nothing at all: not a person, not an entry
  ], { 68758282444950: '+972544686188' }), [
    { tag: '@+972544686188', lid: '68758282444950' },
    { tag: '@+6266525098172' },
    { lid: '69320805752936' },
    { lid: '259201444126724' },
  ]);
  // And the sentence that makes the third and fourth entries safe to hand over.
  assert.match(groupTurn.TAG_RULE, /a `lid` and NO `tag`[\s\S]*say nothing about them/);
});

test('an unreadable lid map costs the lids and nothing else', async () => {
  const { group, people } = await room(8, { subject: 'Padel Gang' });
  // `lidPhoneNumbers` throwing is an unreadable credentials directory, and the
  // same direction `groups.resolveLidMembers` takes: a roster quietly emptied
  // of its people would read as every one of them leaving the room. A turn
  // with no block at all is the one outcome worse than one with no lids.
  const broken = createBrokerServer({
    pool: db.pool,
    lidPhoneNumbers: async () => { throw new Error('credentials unreadable'); },
  });
  const r = await broken.dispatch({
    id: 1, method: 'group_turn_context',
    params: { agentId: group.agent_id, externalId: group.external_id },
  });
  assert.equal(r.ok, true, 'the block is still drawn');
  const data = parse(r.context);
  assert.deepEqual(data.room.people, people.map((u) => ({ tag: `@${u.phone}` })));
  assert.ok(!/"lid"/.test(r.context), 'no lid claimed for anybody');
});

// 2026-09-23, פחם הסעות: she called Bar "את" to his face and "היא" about him,
// in front of the room. Nothing in the block said how to address anybody, and
// the room's doctrine had no default, so she guessed from "בר". The owner:
// what she knows of a person's NAME and how to ADDRESS them may cross into the
// room, and only that. Three people, the three sources of the answer.
test('the block carries a confirmed name and how to address them, and nothing else of theirs', async () => {
  const { group, people } = await room(9, { subject: 'פחם הסעות' });
  const [miron, maya, guy] = people;
  // Miron set it on his own page; Maya told her private agent in words; Guy
  // has said neither, and the name on his row came off WhatsApp unconfirmed.
  await db.pool.query(`UPDATE users SET name_confirmed = true, first_name = 'מירון', gender = 'male' WHERE id = $1`, [miron.id]);
  await db.pool.query(`UPDATE users SET name_confirmed = true, first_name = 'מאיה' WHERE id = $1`, [maya.id]);
  await db.pool.query(
    `INSERT INTO user_preferences (user_id, key, value) VALUES ($1, 'gender_forms', 'נשי')`, [maya.id]);
  await db.pool.query(`UPDATE users SET first_name = 'Guy', timezone = 'Asia/Jerusalem' WHERE id = $1`, [guy.id]);

  const { context } = await ask({ agentId: group.agent_id, externalId: group.external_id });
  const data = parse(context);
  assert.deepEqual(data.room.people, [
    { tag: `@${miron.phone}`, name: 'מירון', address: 'masculine' },
    { tag: `@${maya.phone}`, name: 'מאיה', address: 'feminine' },
    { tag: `@${guy.phone}` },
  ], 'a name nobody confirmed is a guess, and a guess is how "M&M" became "מאיה ומירון"');
  // The two fields and not one more: nothing else from a private record is
  // one join away from the room.
  for (const leak of ['Asia/Jerusalem', 'user_id', 'userId', 'gender_forms', 'נשי', 'name_confirmed']) {
    assert.ok(!context.includes(leak), `the block carries no ${leak}`);
  }
  // And what the model is told to do with them, including the case that
  // happened: no `address` is masculine, never a guess from the name.
  assert.match(groupTurn.TAG_RULE, /may also be called by that name/);
  assert.match(groupTurn.TAG_RULE, /without it gets masculine forms, never a guess from the name/);
  assert.match(groupTurn.TAG_RULE, /never the name WhatsApp shows/);
});

test('how a person is addressed is read only from what they said, and a muddle is nothing', () => {
  assert.equal(groupTurn.addressOf({ gender: 'female', gender_forms: 'זכר' }), 'feminine', 'their own page wins');
  assert.equal(groupTurn.addressOf({ gender: 'male' }), 'masculine');
  for (const said of ['נשי', 'נקבה — לפנות אליה בלשון נקבה', 'feminine', 'female please']) {
    assert.equal(groupTurn.addressOf({ gender_forms: said }), 'feminine', said);
  }
  for (const said of ['זכר', 'לשון זכר', 'masculine', 'male']) {
    assert.equal(groupTurn.addressOf({ gender_forms: said }), 'masculine', said);
  }
  for (const said of [null, '', 'לא משנה לי', 'זכר או נקבה, לא משנה']) {
    assert.equal(groupTurn.addressOf({ gender_forms: said }), null, String(said));
  }
});
