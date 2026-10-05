'use strict';
// A yes to a coordination that has already SETTLED (Padel Gang, 2026-10-04;
// `incidents.md`, "The room was told it was four"). Somebody let in after the
// room set Saturday was asked whether they could make it, and the only door a
// yes had was a reopen — which unsettled the game for everybody already
// coming. `meetings.joinSettled` counts them in and leaves it settled.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const tx = (fn) => withTx(db.pool, fn);
const userTool = (name) => require('../src/adapters/mcp/tools/meetings').find((t) => t.name === name);
const groupTool = (name) => require('../src/adapters/mcp/tools/group').find((t) => t.name === name);

async function connect(people) {
  for (let x = 0; x < people.length; x++) {
    for (let y = x + 1; y < people.length; y++) {
      const { rows } = await db.pool.query(
        `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
         VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [people[x].id, people[y].id, people[y].phone]);
      for (const g of [people[x], people[y]]) {
        await db.pool.query(
          `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature) VALUES ($1, $2, 'meetings')`,
          [rows[0].id, g.id]);
      }
    }
  }
}

let seq = 0;
async function trio() {
  seq += 1;
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+97253297${String(seq).padStart(2, '0')}0${i}`, { firstName: ['Ann', 'Ben', 'Cal'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  await connect(people);
  return people;
}

// Settled on Saturday by Ann and Ben; Cal is in it and never said yes.
async function settledWithout(people) {
  const [a, b] = people;
  const id = Number((await tx((c) => meetings.startMeeting(c, a.id, 'פאדל', [b.id, people[2].id]))).data.meeting.id);
  const sat = slotStart('שבת', { hours: 72 });
  await tx((c) => meetings.proposeSlot(c, a.id, id, 'שבת 17:00', sat));
  const opt = (await tx((c) => options.list(c, id)))[0];
  await tx((c) => options.answer(c, b.id, id, opt.id, 'y'));
  await tx((c) => options.confirmOn(c, id, { ...opt, slot_text: opt.slotText, starts_at: opt.startsAt }, a.id));
  return { id, opt };
}

const state = async (id, uid) => (await db.pool.query(
  'SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2', [id, uid])).rows[0].state;
const meetingRow = async (id) => (await db.pool.query('SELECT * FROM meetings WHERE id = $1', [id])).rows[0];

test('a yes on the settled time counts them in, and it stays settled', async () => {
  const people = await trio();
  const cal = people[2];
  const { id, opt } = await settledWithout(people);
  const { rows: [{ n: queuedBefore }] } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE (payload->>'meetingId')::bigint = $1`, [id]);

  const res = await tx((c) => userTool('respond_to_meeting_slot').handler(c, cal,
    { meeting_id: id, accept: true, accepted_starts_at: new Date(opt.startsAt).toISOString() }, {}));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.joinedSettled, true);
  assert.equal(res.data.meetingStatus, 'confirmed');
  assert.match(res.data.hint, /Nobody else is messaged/);
  assert.match(res.data.hint, /create_calendar_event/, 'no shared event: their own calendar is offered');

  const m = await meetingRow(id);
  assert.equal(m.status, 'confirmed');
  assert.equal(m.confirmed_slot, 'שבת 17:00');
  assert.equal(m.reopened_at, null, 'nothing was reopened');
  assert.equal(await state(id, cal.id), 'confirmed_current');
  const answers = (await tx((c) => options.list(c, id)))[0].answers;
  assert.equal(answers[String(cal.id)], 'y');
  const { rows: [{ n: queuedAfter }] } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE (payload->>'meetingId')::bigint = $1`, [id]);
  assert.equal(queuedAfter, queuedBefore, 'nobody is messaged about it');

  const again = await tx((c) => meetings.respondToSlot(c, cal.id, id, true, null, null, opt.startsAt));
  assert.equal(again.data.alreadyIn, true);
  const { rows: audits } = await db.pool.query(
    `SELECT 1 FROM audit_log WHERE event = 'meeting.joined_settled' AND actor_id = $1`, [cal.id]);
  assert.equal(audits.length, 1, 'a second yes is not a second join');
});

test('only the settled time, only a yes, and only before it starts', async () => {
  const people = await trio();
  const cal = people[2];
  const { id } = await settledWithout(people);

  const other = await tx((c) => meetings.respondToSlot(c, cal.id, id, true, null, null,
    slotStart('ראשון', { hours: 72 })));
  assert.equal(other.ok, false);
  assert.equal(other.error.reason, 'settled_elsewhere', 'a different time is a reopen, and that is a person\'s call');

  const no = await tx((c) => meetings.respondToSlot(c, cal.id, id, false, null, null, null));
  assert.equal(no.ok, false);
  assert.equal(no.error.reason, 'settled_use_opt_out');

  await db.pool.query(`UPDATE meetings SET confirmed_start_at = now() - interval '1 hour' WHERE id = $1`, [id]);
  const late = await tx((c) => meetings.respondToSlot(c, cal.id, id, true, null, null, null));
  assert.equal(late.ok, false);
  assert.equal(late.error.reason, 'started');
  assert.equal(await state(id, cal.id), 'awaiting');
});

test('somebody who left it comes back through rejoin, not through a yes', async () => {
  const people = await trio();
  const cal = people[2];
  const { id, opt } = await settledWithout(people);
  await db.pool.query(
    `UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`, [id, cal.id]);
  const res = await tx((c) => meetings.respondToSlot(c, cal.id, id, true, null, null, opt.startsAt));
  assert.equal(res.ok, false);
  assert.equal(await state(id, cal.id), 'opted_out');
});

test('from the room: a yes on the settled time counts them in without reopening', async () => {
  const people = await trio();
  const group = await tx(async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: '120363255555550001@g.us', subject: 'Padel Gang', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + '55'.repeat(16)]);
    return rows[0];
  });
  const { id, opt } = await settledWithout(people);
  await db.pool.query('UPDATE meetings SET group_id = $2 WHERE id = $1', [id, group.id]);

  const res = await tx((c) => groupTool('answer_group_coordination_option').handler(c,
    { group, actingUser: people[2] }, { option_id: opt.id, accept: true }, {}));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.meetingStatus, 'confirmed');
  assert.match(res.data.hints.room, /stays set/);
  assert.equal((await meetingRow(id)).status, 'confirmed');
  assert.equal(await state(id, people[2].id), 'confirmed_current');
});
