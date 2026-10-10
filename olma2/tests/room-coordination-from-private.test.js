'use strict';
// A private coordination is never the room's business — except when it IS the
// room's (owner, 2026-10-08): asked for "for this group", or with everybody in
// one of their rooms. Then it becomes that room's coordination, so the room
// sees the board and acts on it like one it asked for itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036322222222${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + ('p' + String(n).padStart(2, '0')).repeat(11).slice(0, 32);

// Three people who wrote to her, one roster row who never did, none of them
// connected to each other.
async function room(n, { subject = 'פוקר', silent = true } = {}) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726066${n}000${i}`, { firstName: ['מירון', 'מאיה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const quiet = silent ? await makeUser(db.pool, `+9726066${n}0009`, { firstName: 'שקט' }) : null;
  const members = [...people, ...(quiet ? [quiet] : [])].map((u) => ({ phone: u.phone }));
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, { externalId: JID(n), members, subject });
    assert.ok(reg.ok, 'the fixture group registered');
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people, quiet };
}

const start = (user, args) => withTx(db.pool, (c) => BY_NAME.get('start_meeting_coordination').handler(c, user, args));

test('"for this group" opens the ROOM\'s coordination, with nobody connected to anybody', async () => {
  const { group, people } = await room(1);
  const res = await start(people[0], { title: 'פוקר חמישי', group_id: Number(group.id) });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.data.created, true);
  assert.equal(res.data.group, 'פוקר');
  assert.match(res.data.hints.group, /group's own coordination/);

  const { rows } = await db.pool.query(`SELECT group_id, initiator_id FROM meetings WHERE id = $1`, [res.data.meetingId]);
  assert.equal(Number(rows[0].group_id), Number(group.id), 'it is the room\'s');
  assert.equal(Number(rows[0].initiator_id), Number(people[0].id));

  // The room's own door now finds it.
  const running = await withTx(db.pool, (c) => groupMeetings.currentMeeting(c, group.id));
  assert.equal(Number(running.id), res.data.meetingId);

  const { rows: invites } = await db.pool.query(
    `SELECT user_id, payload FROM outbox WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1`,
    [res.data.meetingId]);
  assert.deepEqual(invites.map((r) => Number(r.user_id)).sort(), [people[1].id, people[2].id].map(Number).sort(),
    'the others are asked; the asker is in the conversation where they said it');
  assert.ok(invites.every((r) => r.payload.groupSubject === 'פוקר'));
  assert.ok(invites.every((r) => !r.payload.askedItYourself));

  const { rows: a } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'group.coordination_started' AND (detail->>'meetingId')::bigint = $1`,
    [res.data.meetingId]);
  assert.equal(a[0].detail.fromPrivate, true);
});

test('the room\'s once-ever kind question is not spent from a private chat', async () => {
  const { group, people } = await room(2);
  await start(people[0], { title: 'משחק', group_id: Number(group.id) });
  const { rows } = await db.pool.query(`SELECT kind_asked_at FROM chat_groups WHERE id = $1`, [group.id]);
  assert.equal(rows[0].kind_asked_at, null, 'only the room can be asked it');
});

test('everybody in the room by phone is the room — the member who never wrote is not required', async () => {
  const { group, people } = await room(3);
  const res = await start(people[0], { title: 'פוקר', phones: [people[1].phone, people[2].phone] });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.data.group, 'פוקר');
  const { rows } = await db.pool.query(`SELECT group_id FROM meetings WHERE id = $1`, [res.data.meetingId]);
  assert.equal(Number(rows[0].group_id), Number(group.id));
});

test('some of the room by phone stays a private coordination', async () => {
  const { people } = await room(4);
  const res = await start(people[0], { title: 'קפה', phones: [people[1].phone] });
  // They are not connected to each other, so the private door refuses — which
  // is exactly the proof it never became the room's.
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_connected');
});

test('somebody who is not in the room makes it a private coordination', async () => {
  const { people } = await room(5);
  const stranger = await makeUser(db.pool, '+972606659999', { firstName: 'זר' });
  const res = await start(people[0], { title: 'פוקר', phones: [people[1].phone, people[2].phone, stranger.phone] });
  assert.equal(res.ok, false);
  assert.notEqual(res.error.reason, 'which_group');
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meetings WHERE initiator_id = $1`, [people[0].id]);
  assert.equal(rows[0].n, 0);
});

test('a member who paused her themselves is not required, and somebody who wrote is', () => {
  const m = (id, extra = {}) => ({ user_id: id, phone: `+97250000000${id}`, last_inbound_at: new Date(), ...extra });
  const members = [m(1), m(2), m(3), m(4, { paused_at: new Date(), paused_reason: 'said_stop' }),
    m(5, { last_inbound_at: null }), { user_id: null, phone: '123456789012345' }];
  assert.equal(groupMeetings.coversRoom(members, 1, ['+972500000002', '+972500000003']), true);
  assert.equal(groupMeetings.coversRoom(members, 1, ['+972500000002']), false, 'member 3 wrote and was not named');
  assert.equal(groupMeetings.coversRoom(members, 1, ['+972500000002', '+972 50-000-0003', '+972500000005']), true,
    'formatting aside, and a non-writer may be named');
  assert.equal(groupMeetings.coversRoom(members, 9, ['+972500000002', '+972500000003']), false, 'the asker must be in it');
  assert.equal(groupMeetings.coversRoom(members, 1, ['+972500000001']), false, 'only themselves is nobody');
});

test('everybody in TWO of their rooms is a question, not a guess', async () => {
  const { group, people } = await room(6, { silent: false });
  const twin = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, { externalId: JID(66), members: people.map((u) => ({ phone: u.phone })), subject: 'פאדל' });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(66)]);
    return rows[0];
  });
  const res = await start(people[0], { title: 'ערב', phones: [people[1].phone, people[2].phone] });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'which_group');
  assert.deepEqual(res.error.groups.map((g) => g.groupId).sort(), [Number(group.id), Number(twin.id)].sort());
});

test('a room they are not in does not exist, as far as their chat can tell', async () => {
  const { group } = await room(7);
  const outsider = await makeUser(db.pool, '+972606679999', { firstName: 'אחר' });
  const res = await start(outsider, { title: 'פוקר', group_id: Number(group.id) });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_your_group');
  const missing = await start(outsider, { title: 'פוקר', group_id: 987654 });
  assert.equal(missing.error.reason, 'not_your_group');
});

test('the room\'s coordination already running is handed back, not opened twice', async () => {
  const { group, people } = await room(8);
  const first = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[1], 'פוקר'));
  const res = await start(people[0], { title: 'פוקר', group_id: Number(group.id) });
  assert.equal(res.ok, true);
  assert.equal(res.data.created, false);
  assert.equal(res.data.meetingId, Number(first.data.meeting.id));
  assert.match(res.data.hints.group, /already has this running/);
});

test('neither phones nor a group is refused', async () => {
  const { people } = await room(9);
  const res = await start(people[0], { title: 'משהו' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
});
