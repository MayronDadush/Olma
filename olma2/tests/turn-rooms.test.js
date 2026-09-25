'use strict';
// The private side knows which rooms a person shares with Olma. ORGETZ joined
// her three minutes after "Shabi OG" had started a coordination, asked her
// privately "אני בקבוצה כלשהי שגם את נמצאת?", and was told no: list_my_meetings
// read meeting_participants, he had no row, and nothing else on the private
// side could see a room (2026-09-25, `incidents.md`, "She said there was no
// group"). Asserted through BOTH doors that open a turn, and through the tool.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const flagsDomain = require('../src/domain/flags');
const turnDomain = require('../src/domain/turn');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');

let db, broker, host, guest, late, stranger, group, meetingId;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: true }) });
  const person = async (phone, name, agent) => {
    const u = await makeUser(db.pool, phone, { firstName: name });
    await db.pool.query(`UPDATE users SET last_inbound_at = now(), agent_id = $2 WHERE id = $1`, [u.id, agent]);
    return { ...u, agentId: agent };
  };
  host = await person('+972509300001', 'Miron', 'u-9301');
  guest = await person('+972509300002', 'Dana', 'u-9302');
  late = await person('+972509300003', 'Or', 'u-9303');
  stranger = await person('+972509300004', 'Nobody', 'u-9304');
  group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: '120363555555555501@g.us', subject: 'Shabi OG',
      members: [{ phone: host.phone }, { phone: guest.phone }],
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + '93'.repeat(16)]);
    return rows[0];
  });
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, host, 'פגישה של הקבוצה'));
  assert.equal(started.ok, true, JSON.stringify(started));
  meetingId = Number(started.data.meeting.id);
  // He joins the ROOM after it started: a roster row, no participant row.
  await db.pool.query(
    `INSERT INTO chat_group_members (group_id, phone, user_id) VALUES ($1, $2, $3)`,
    [group.id, late.phone, late.id]);
});
after(async () => { if (db) await db.teardown(); });

const tool = async (user, name, args = {}) => {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call', params: { name, args: { olma_identity: user.identity_token, ...args } } },
    { opened: false, counted: false });
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
};

test('roomsOf: the room, its live coordination, and whether THIS person is in it', async () => {
  const mine = await groups.roomsOf(db.pool, late.id);
  assert.deepEqual(mine, [{
    groupId: Number(group.id), subject: 'Shabi OG', open: true,
    coordination: { meetingId, title: 'פגישה של הקבוצה', inIt: false },
  }]);
  const theirs = await groups.roomsOf(db.pool, guest.id);
  assert.equal(theirs[0].coordination.inIt, true);
  assert.deepEqual(await groups.roomsOf(db.pool, stranger.id), [], 'not in the room, no room');
});

test('turn_start carries the rooms, fenced, and says the list is complete', async () => {
  const t = await tool(late, 'turn_start');
  assert.deepEqual(t.rooms, [{
    subject: '<<<Shabi OG>>>', open: true,
    coordination: { meetingId, title: '<<<פגישה של הקבוצה>>>' },
  }]);
  assert.match(t.hints.rooms, /COMPLETE list/);
  assert.match(t.hints.rooms, /never that there is no group/);
  const inIt = await tool(guest, 'turn_start');
  assert.equal(inIt.rooms[0].coordination.inIt, true);
  const none = await tool(stranger, 'turn_start');
  assert.equal(none.rooms, undefined, 'no room, no block and no hint');
  assert.equal((none.hints || {}).rooms, undefined);
});

test('turn_context — the other door — carries the same rooms', async () => {
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, late.phone));
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: late.agentId, messageId: '3EB0ROOMS001', kind: 'text' } });
  const r = await broker.dispatch({ id: 1, method: 'turn_context', params: { agentId: late.agentId } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const data = JSON.parse(r.context.split('\n')[1].replace(/^OK /, ''));
  assert.equal(data.rooms[0].subject, '<<<Shabi OG>>>');
  assert.equal(data.rooms[0].coordination.meetingId, meetingId);
});

test('list_my_meetings answers "which group am I in with you" even with no meeting of their own', async () => {
  const res = await tool(late, 'list_my_meetings');
  assert.deepEqual(res.meetings, []);
  assert.equal(res.rooms.length, 1);
  assert.equal(res.rooms[0].subject, 'Shabi OG');
  assert.equal(res.rooms[0].coordination.inIt, false);
});

test('a room they LEFT, or one that is retired, is not a room they share with her', async () => {
  await db.pool.query(`UPDATE chat_group_members SET left_at = now() WHERE group_id = $1 AND user_id = $2`, [group.id, late.id]);
  assert.deepEqual(await groups.roomsOf(db.pool, late.id), []);
  await db.pool.query(`UPDATE chat_groups SET state = 'retired' WHERE id = $1`, [group.id]);
  assert.deepEqual(await groups.roomsOf(db.pool, guest.id), []);
});
