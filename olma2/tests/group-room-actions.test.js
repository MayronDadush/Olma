'use strict';
// Every action on a coordination, from the room as well as the chat (owner,
// 2026-09-25). He asked the room to cancel and was told it could only be done
// privately (`incidents.md`, "The room could not cancel its own
// coordination"). Each room tool is a second door into the domain call and
// fan-out its private twin uses, so what is tested here is that the SAME rows
// come out, that only somebody still IN the coordination can do it, and that
// nothing about anybody else's answer comes back to the room.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036322222222${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);

async function room(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726066${n}000${i}`, { firstName: ['עמית', 'מירון', 'בר'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: JID(n), subject: 'פחם הסעות', members: people.map((u) => ({ phone: u.phone })),
    });
    assert.ok(reg.ok, 'the fixture group registered');
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
        WHERE id = $1 RETURNING *`, [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people };
}

const groupTool = (name) => require('../src/adapters/mcp/tools/group').find((t) => t.name === name);
const userTool = (name) => require('../src/adapters/mcp/tools/meetings').find((t) => t.name === name);
const inRoom = (name, group, actingUser, args = {}) =>
  withTx(db.pool, (c) => groupTool(name).handler(c, { group, actingUser }, args, {}));

async function started(n) {
  const r = await room(n);
  const res = await inRoom('start_group_coordination', r.group, r.people[0], { what: 'פוקר בזום' });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  return { ...r, meetingId: res.data.meetingId };
}

async function addTime(group, who, hours) {
  const res = await inRoom('add_group_coordination_option', group, who,
    { slot_description: `בעוד ${hours} שעות`, starts_at: slotStart('', { hours }) });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  return res.data.optionId;
}

const status = async (id) => (await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [id])).rows[0].status;

test('the room cancels its coordination for everybody, through the same door as the chat', async () => {
  const { group, people, meetingId } = await started(1);
  const [amit, miron, bar] = people;

  const res = await inRoom('cancel_group_coordination', group, miron);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.cancelled, true);
  assert.equal(await status(meetingId), 'cancelled');

  // Everybody else is told privately, the one who said it in the room is not.
  for (const u of [amit, bar]) {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'meeting_cancelled'
         AND (payload->>'meetingId')::bigint = $2`, [u.id, meetingId]);
    assert.equal(rows.length, 1, 'told privately that it is off');
  }
  const { rows: own } = await db.pool.query(
    `SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'meeting_cancelled'`, [miron.id]);
  assert.equal(own.length, 0, 'the room heard it from him');
  // No invite about a coordination that no longer exists is still on its way.
  const { rows: live } = await db.pool.query(
    `SELECT 1 FROM outbox WHERE kind = 'meeting_invite' AND sent_at IS NULL
       AND (payload->>'meetingId')::bigint = $1`, [meetingId]);
  assert.equal(live.length, 0);
  // The private result's hint is about a person's own calendar; none of it here.
  assert.equal(res.data.hint, undefined);
  assert.match(res.data.hints.room, /ONE short line/);
});

test('a confirmed coordination is cancelled from the room until it starts, and not after', async () => {
  const { group, people, meetingId } = await started(2);
  const optionId = await addTime(group, people[0], 50);
  const settled = await inRoom('settle_group_coordination', group, people[0], { option_id: optionId });
  assert.equal(settled.ok, true, settled.ok ? '' : JSON.stringify(settled.error));
  assert.equal(await status(meetingId), 'confirmed');

  await db.pool.query(`UPDATE meetings SET confirmed_start_at = now() - interval '1 hour' WHERE id = $1`, [meetingId]);
  const late = await inRoom('cancel_group_coordination', group, people[1]);
  assert.equal(late.ok, false, 'a thing that has started has nothing left to cancel');

  await db.pool.query(`UPDATE meetings SET confirmed_start_at = now() + interval '50 hours' WHERE id = $1`, [meetingId]);
  const res = await inRoom('cancel_group_coordination', group, people[1]);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.wasConfirmed, true);
  assert.equal(await status(meetingId), 'cancelled');
});

test('only somebody still IN the coordination acts on it from the room', async () => {
  const { group, people, meetingId } = await started(3);
  const [amit, miron] = people;
  const optionId = await addTime(group, amit, 50);

  const nobody = await inRoom('cancel_group_coordination', group, null);
  assert.equal(nobody.ok, false, 'a turn with nobody behind it cancels nothing');

  const other = await room(4);
  const stranger = await inRoom('cancel_group_coordination', group, other.people[0]);
  assert.equal(stranger.ok, false, 'a member of another room cannot touch this one');

  const left = await inRoom('leave_group_coordination', group, miron);
  assert.equal(left.ok, true, left.ok ? '' : JSON.stringify(left.error));
  for (const [name, args] of [['cancel_group_coordination', {}], ['rename_group_coordination', { title: 'x' }],
    ['remove_group_coordination_option', { option_id: optionId }],
    ['answer_group_coordination_option', { option_id: optionId, accept: true }]]) {
    const res = await inRoom(name, group, miron, args);
    assert.equal(res.ok, false, `${name}: somebody who left cannot act on it`);
    assert.equal(res.error.reason, 'not_in_it');
  }
  assert.equal(await status(meetingId), 'negotiating', 'nothing they tried went through');
});

test('leaving from the room is one person out, and it carries on for the others', async () => {
  const { group, people, meetingId } = await started(5);
  const res = await inRoom('leave_group_coordination', group, people[2]);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.cancelledForEveryone, false);
  assert.equal(await status(meetingId), 'negotiating');
  const { rows } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, people[2].id]);
  assert.equal(rows[0].state, 'opted_out');
});

test('an answer said in the room lands on THAT time, and the room hears nobody else\'s', async () => {
  const { group, people, meetingId } = await started(6);
  const [amit, miron, bar] = people;
  const first = await addTime(group, amit, 50);
  const second = await addTime(group, amit, 60);

  const yes = await inRoom('answer_group_coordination_option', group, miron, { option_id: first, accept: true });
  assert.equal(yes.ok, true, yes.ok ? '' : JSON.stringify(yes.error));
  assert.equal(yes.data.answer, 'yes');
  const no = await inRoom('answer_group_coordination_option', group, bar, { option_id: second, accept: false });
  assert.equal(no.ok, true, no.ok ? '' : JSON.stringify(no.error));

  const { rows } = await db.pool.query(
    `SELECT option_id, user_id, answer FROM meeting_option_answers WHERE user_id = ANY($1::bigint[])`,
    [[miron.id, bar.id]]);
  const got = rows.map((r) => [Number(r.option_id), Number(r.user_id), r.answer]).sort();
  assert.deepEqual(got, [[first, Number(miron.id), 'y'], [second, Number(bar.id), 'n']].sort(),
    'the yes on the older time, not on whatever is newest');
  for (const res of [yes, no]) {
    assert.equal(JSON.stringify(res).includes('answers'), false, 'nobody else\'s answer comes back');
  }

  const gone = await inRoom('answer_group_coordination_option', group, bar, { option_id: 999999, accept: true });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.reason, 'option_not_active');
  assert.equal(await status(meetingId), 'negotiating');
});

test('a time taken off in the room is off, in the name of whoever took it', async () => {
  const { group, people, meetingId } = await started(7);
  const optionId = await addTime(group, people[0], 50);
  await addTime(group, people[0], 60);
  const res = await inRoom('remove_group_coordination_option', group, people[1], { option_id: optionId });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const { rows } = await db.pool.query(
    `SELECT status, removed_by FROM meeting_options WHERE id = $1`, [optionId]);
  assert.equal(rows[0].status, 'deleted');
  assert.equal(Number(rows[0].removed_by), Number(people[1].id));
  assert.equal(await status(meetingId), 'negotiating', 'taking a time off does not end it');
});

test('a rename in the room is the coordination\'s new name', async () => {
  const { group, people, meetingId } = await started(8);
  const res = await inRoom('rename_group_coordination', group, people[2], { title: 'פוקר שישי' });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.calendarUpdated, false, 'no event yet, so nothing to follow');
  const { rows } = await db.pool.query(`SELECT title FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(rows[0].title, 'פוקר שישי');
});

test('the place and the minimum can be set from the private chat too', async () => {
  const { people, meetingId } = await started(9);
  const [amit] = people;
  const outsider = (await room(10)).people[0];
  const call = (name, user, args) => withTx(db.pool, (c) => userTool(name).handler(c, user, args, {}));

  const place = await call('set_meeting_place', amit, { meeting_id: meetingId, where: '  אצל  יוסי ' });
  assert.equal(place.ok, true, place.ok ? '' : JSON.stringify(place.error));
  assert.equal(place.data.location, 'אצל יוסי');
  const min = await call('set_meeting_minimum', amit, { meeting_id: meetingId, minimum: 3 });
  assert.equal(min.ok, true, min.ok ? '' : JSON.stringify(min.error));
  const { rows } = await db.pool.query(`SELECT location, quorum_min FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(rows[0].location, 'אצל יוסי');
  assert.equal(Number(rows[0].quorum_min), 3);

  for (const [name, args] of [['set_meeting_place', { where: 'אצלי' }], ['set_meeting_minimum', { minimum: 2 }]]) {
    const res = await call(name, outsider, { meeting_id: meetingId, ...args });
    assert.equal(res.ok, false, `${name}: somebody not in it cannot set it`);
  }
  const cleared = await call('set_meeting_minimum', amit, { meeting_id: meetingId, minimum: null });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.data.quorumMin, null);
});
