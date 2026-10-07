'use strict';
// The same people already negotiating, across the two doors a coordination
// opens through. On 2026-10-05 user 57 opened "פוקר" privately with twelve
// people at 12:50 and user 3 asked the poker room for "פוקר לשבוע הקרוב" at
// 12:52: the same twelve, and everybody got two invites (`incidents.md`, "Two
// invites for one poker night"). `openWithSamePeople` only ever compared a
// private coordination with a private one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036333333333${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);

const groupTool = (name) => require('../src/adapters/mcp/tools/group').find((t) => t.name === name);
const userTool = (name) => require('../src/adapters/mcp/tools/meetings').find((t) => t.name === name);
const inRoom = (group, actingUser, args) =>
  withTx(db.pool, (c) => groupTool('start_group_coordination').handler(c, { group, actingUser }, args, {}));
const inChat = (user, args) =>
  withTx(db.pool, (c) => userTool('start_meeting_coordination').handler(c, user, args, {}));

// `size` people who have all written to her, in an open room, and the first of
// them connected to every other one so they can also open a private
// coordination with any of them.
async function room(n, size) {
  const people = [];
  for (let i = 0; i < size; i++) {
    const u = await makeUser(db.pool, `+9726077${n}00${String(i).padStart(2, '0')}`, { firstName: `p${n}-${i}` });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  await withTx(db.pool, async (c) => {
    for (const a of people.slice(0, 2)) {
      for (const b of people) {
        if (a.id === b.id) continue;
        const req = await connections.requestConnection(c, a.id, b.phone, {});
        if (req.ok && req.data.connection && req.data.connection.status !== 'approved') {
          await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve');
        }
      }
    }
  });
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: JID(n), subject: 'פוקר', members: people.map((u) => ({ phone: u.phone })),
    });
    assert.ok(reg.ok, 'the fixture group registered');
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
        WHERE id = $1 RETURNING *`, [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people };
}

const meetingsOf = async (userId) => (await db.pool.query(
  `SELECT m.id, m.group_id FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id
    WHERE p.user_id = $1 ORDER BY m.id`, [userId])).rows;
const invitesOf = async (userId) => (await db.pool.query(
  `SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'meeting_invite'`, [userId])).rows.length;

test('nearly the same people: everybody private is in the room, and the room is at most a quarter bigger', () => {
  const same = meetings.nearlySamePeople;
  assert.equal(same([1, 2, 3], [1, 2, 3]), true, 'exactly the same');
  assert.equal(same([1, 2, 3], [1, 2, 3, 4]), true, 'one newcomer is always slack');
  assert.equal(same([1, 2], [1, 2, 3]), true, 'a room of three, one short');
  assert.equal(same([1, 2], [1, 2, 3, 4]), false, 'half a room of four is not the room');
  assert.equal(same([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), true, 'a quarter of ten is two');
  assert.equal(same([1, 2], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), false, 'a private pair in a room of ten is a coffee');
  assert.equal(same([1, 2, 99], [1, 2, 3]), false, 'somebody from outside the room is a different gathering');
  assert.equal(same([1], [1]), false, 'one person is nobody to coordinate with');
});

test('the room does not open a second coordination for people already negotiating it privately', async () => {
  const { group, people } = await room(1, 5);
  const [opener, asker, ...rest] = people;

  // The founding case: somebody opens it privately with the whole room...
  const priv = await inChat(opener, { title: 'פוקר', phones: people.slice(1).map((u) => u.phone) });
  assert.equal(priv.ok, true, priv.ok ? '' : JSON.stringify(priv.error));
  const privateId = Number(priv.data.meeting.id);
  const invitesBefore = await invitesOf(rest[0].id);

  // ...and somebody else in it asks the room two minutes later.
  const res = await inRoom(group, asker, { what: 'פוקר לשבוע הקרוב' });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'already_open');
  assert.equal(res.error.open.length, 1);
  assert.equal(res.error.open[0].meetingId, privateId);
  assert.equal(res.error.open[0].openedBy, `@${opener.phone}`, 'the opener, by tag — this is the room');
  assert.equal(res.error.open[0].times, undefined, 'nothing about its table crosses into the room');
  assert.match(res.error.hint, /separate=true/);
  assert.equal((await meetingsOf(rest[0].id)).length, 1, 'no room coordination was opened');
  assert.equal(await invitesOf(rest[0].id), invitesBefore, 'and nobody was invited twice');

  // The person who opened it privately asking the room sees it as theirs.
  const own = await inRoom(group, opener, { what: 'פוקר' });
  assert.equal(own.error.open[0].openedBy, 'you');

  // A checked "this is another one" goes through.
  const other = await inRoom(group, asker, { what: 'פאדל', separate: true });
  assert.equal(other.ok, true, other.ok ? '' : JSON.stringify(other.error));
  assert.equal(other.data.created, true);
});

test('a newcomer to the room does not make the room a different set of people', async () => {
  const { group, people } = await room(2, 5);
  const [opener, ...others] = people;
  // Opened privately with everybody but the last, who joins the room later.
  const priv = await inChat(opener, { title: 'פוקר', phones: others.slice(0, 3).map((u) => u.phone) });
  assert.equal(priv.ok, true, priv.ok ? '' : JSON.stringify(priv.error));
  const res = await inRoom(group, others[0], { what: 'פוקר' });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'already_open');
});

test('the room still opens when the private one is a smaller thing, or one the asker is not in', async () => {
  const { group, people } = await room(3, 6);
  const [a, b] = people;
  // A private pair inside a room of six: their coffee, not the room's game —
  // even asked by one of the pair.
  const pair = await inChat(a, { title: 'קפה', phones: [b.phone] });
  assert.equal(pair.ok, true, pair.ok ? '' : JSON.stringify(pair.error));
  const res = await inRoom(group, b, { what: 'פוקר' });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.created, true);

  // Somebody not in a private one is never told about it in front of the room.
  const { group: g2, people: p2 } = await room(4, 4);
  const priv = await inChat(p2[0], { title: 'הפתעה', phones: [p2[1].phone, p2[2].phone] });
  assert.equal(priv.ok, true, priv.ok ? '' : JSON.stringify(priv.error));
  const outsider = await inRoom(g2, p2[3], { what: 'פוקר' });
  assert.equal(outsider.ok, true, outsider.ok ? '' : JSON.stringify(outsider.error));
});

test('the chat does not open a private coordination for people the room is already coordinating', async () => {
  const { group, people } = await room(5, 4);
  const [asker, member, ...rest] = people;
  const started = await inRoom(group, asker, { what: 'פוקר' });
  assert.equal(started.ok, true, started.ok ? '' : JSON.stringify(started.error));
  const roomId = started.data.meetingId;

  // A member opens "the same" privately with everybody in the room.
  const res = await inChat(member, { title: 'פוקר', phones: [asker, ...rest].map((u) => u.phone) });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'already_open');
  assert.equal(res.error.open[0].meetingId, roomId);
  assert.equal(res.error.open[0].room, 'פוקר', 'said to be the room\'s');
  assert.equal(res.error.open[0].openedBy, 'p5-0');
  assert.equal((await meetingsOf(rest[0].id)).length, 1, 'nothing private was opened');

  // A pair inside the room is a different thing.
  const pair = await inChat(member, { title: 'קפה', phones: [asker.phone] });
  assert.equal(pair.ok, true, pair.ok ? '' : JSON.stringify(pair.error));

  // And `separate` is how a checked "another one" gets through.
  const again = await inChat(member, { title: 'פוקר 2', phones: [asker, ...rest].map((u) => u.phone), separate: true });
  assert.equal(again.ok, true, again.ok ? '' : JSON.stringify(again.error));
});
