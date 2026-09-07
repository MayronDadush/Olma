'use strict';
// The room asks for something, and the asking moves into everybody's private
// chat. What is being tested here is mostly what does NOT travel: no pairwise
// grant is needed inside a room, and no reason anybody gave in private is
// readable from it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const { instructionFor } = require('../src/channels/openclaw');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036311111111${n}@g.us`;
const TOKEN = (suffix) => 'olma_grp_' + String(suffix).repeat(32).slice(0, 32);

async function openGroup(client, { jid, members, token, subject }) {
  const reg = await groups.registerGroup(client, { externalId: jid, members, subject });
  assert.ok(reg.ok, 'the fixture group registered');
  const { rows } = await client.query(
    `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
      WHERE id = $1 RETURNING *`,
    [reg.data.group.id, `g-${reg.data.group.id}`, token]);
  return rows[0];
}

// Three people who have all written to her privately — an open room — and who
// are NOT connected to each other in any way.
async function room(n, { subject = 'פאדל חמישי' } = {}) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726055${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(n), subject, token: TOKEN(String(n)),
    members: people.map((u) => ({ phone: u.phone })),
  }));
  return { group, people };
}

test('a room coordinates without anybody being connected to anybody', async () => {
  const { group, people } = await room(1);
  const [asked] = people;

  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, asked, 'פאדל השבוע'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.created, true);
  assert.equal(res.data.participants, 3);

  const { rows } = await db.pool.query(
    `SELECT group_id, initiator_id, title FROM meetings WHERE id = $1`, [res.data.meeting.id]);
  assert.equal(Number(rows[0].group_id), Number(group.id), 'the coordination belongs to the room');
  assert.equal(Number(rows[0].initiator_id), Number(asked.id), 'and the person who asked holds it');
  assert.equal(rows[0].title, 'פאדל השבוע');

  // The same call between two of these people, in private, is still refused:
  // the room is the consent, and it did not become a connection.
  const direct = await withTx(db.pool, (c) => meetings.startMeeting(c, people[0].id, 'קפה', [people[1].id]));
  assert.equal(direct.ok, false);
  assert.equal(direct.error.reason, 'not_connected');
});

test('the private question names the room, and never asks anybody to answer in it', async () => {
  const { group, people } = await room(2, { subject: 'פוקר של רביעי' });
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'משחק השבוע'));
  assert.equal(res.ok, true);

  const { rows } = await db.pool.query(
    `SELECT user_id, payload FROM outbox
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1
      ORDER BY user_id`, [res.data.meeting.id]);
  assert.equal(rows.length, 2, 'everybody but the person who asked');
  assert.deepEqual(rows.map((r) => Number(r.user_id)).sort(),
    [people[1].id, people[2].id].map(Number).sort());

  const p = rows[0].payload;
  assert.equal(p.groupSubject, 'פוקר של רביעי');
  const body = instructionFor({ kind: 'meeting_invite', payload: p });
  assert.match(body, /פוקר של רביעי/, 'the room is the subject of the sentence');
  assert.match(body, /never in the group/, 'and the answer comes back here, not there');
});

test('a second ask while one is running gets the same coordination back', async () => {
  const { group, people } = await room(3);
  const first = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'ארוחה'));
  const second = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[1], 'משהו אחר'));
  assert.equal(second.ok, true);
  assert.equal(second.data.created, false);
  assert.equal(Number(second.data.meeting.id), Number(first.data.meeting.id));

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM meetings WHERE group_id = $1`, [group.id]);
  assert.equal(rows[0].n, 1, 'one table of times, not two');
});

test('a turn with nobody behind it starts nothing', async () => {
  const { group } = await room(4);
  // groups.actingMember returns null when the gateway filed no sender, or the
  // sender is not a user. Picking a member would put one person's name on a
  // decision they never made.
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, null, 'משחק'));
  assert.equal(res.ok, false);
  assert.match(res.error.message, /who asked/);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meetings WHERE group_id = $1`, [group.id]);
  assert.equal(rows[0].n, 0);
});

test('the room sees the answers and never the reasons', async () => {
  const { group, people } = await room(5);
  const [danny, dana] = people; // and יובל, who never answers
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, danny, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  const when = slotStart('שלישי', { hours: 72 });
  await withTx(db.pool, async (c) => {
    const added = await options.add(c, danny.id, meetingId, 'שלישי 20:00', when);
    assert.equal(added.ok, true, added.ok ? '' : JSON.stringify(added.error));
    const optionId = added.data.option.id;
    // Dana cannot, and says why. Her reason is prose she wrote in her own
    // private chat.
    const r = await meetings.recordConstraint(c, dana.id, meetingId, 'בצילומים ומסיימת מאוחר');
    assert.equal(r.ok, true);
    await options.answer(c, dana.id, meetingId, optionId, 'n');
  });

  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  const co = status.coordination;
  assert.equal(co.meetingId, meetingId);
  assert.equal(co.options.length, 1);
  assert.deepEqual(co.options[0].yes.map((x) => x.name), ['דני']);
  assert.deepEqual(co.options[0].no.map((x) => x.name), ['דנה']);
  assert.deepEqual(co.options[0].missing.map((x) => x.name), ['יובל']);
  assert.deepEqual(co.silent.map((x) => x.name), ['יובל'], 'and the room can chase exactly him');

  assert.equal(JSON.stringify(status).includes('בצילומים'), false,
    'the reason she gave in private is not in what the room can read');
});

test('a room with nothing running says so, rather than inventing a coordination', async () => {
  const { group } = await room(6);
  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  assert.equal(status.coordination, null);
});
