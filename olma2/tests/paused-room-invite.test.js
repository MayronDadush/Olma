'use strict';
// A paused person standing in a room where a coordination starts (owner,
// 2026-09-13). Before this, the room counted them in, the gate dropped their
// invite, and everybody's digest said the coordination was waiting on
// somebody who had never heard of it. Now: one message per pause; an answer
// within a day ends the pause; silence takes them out of this coordination
// and every later one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const pause = require('../src/domain/pause');
const turn = require('../src/domain/turn');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');
const { instructionFor } = require('../src/channels/openclaw');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A fixed moment the gate judges at, in every person's daytime and on no
// quiet day, so nothing here depends on when the suite runs.
const GATE_NOW = new Date('2026-08-16T09:00:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };
const DAY_MS = 24 * 3600_000;

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r); return { ok: true }; } };
}

async function room(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726077${n}000${i}`, { firstName: ['דני', 'דנה', 'קפיש'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036322222222${n}@g.us`, subject: 'חדר בדיקה',
      members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  return { group, people };
}

async function inviteRows(meetingId) {
  const { rows } = await db.pool.query(
    `SELECT user_id, sent_at, hold_reason FROM outbox
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1 ORDER BY user_id`, [meetingId]);
  return rows;
}

async function stateOf(meetingId, userId) {
  const { rows } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, userId]);
  return rows[0] ? rows[0].state : null;
}

async function start(group, by, title) {
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, by, title));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  // Close whatever a previous coordination left, so the room can start another.
  return res.data;
}

async function close(meetingId) {
  await db.pool.query(`UPDATE meetings SET status = 'no_match', closed_at = now() WHERE id = $1`, [meetingId]);
}

test('gate: the one room invite passes a pause and a ladder silence, and nothing else does', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-16T12:00:00Z'),
  };
  const invite = { kind: 'meeting_invite', urgency: 'urgent', expires_at: null };
  assert.equal(decide({ ...base, paused: true, row: invite }).holdReason, 'paused');
  assert.equal(decide({ ...base, paused: true, pausedRoomInvite: true, row: invite }).action, 'deliver');
  assert.equal(decide({ ...base, paused: true, checkinMisses: 3, pausedRoomInvite: true, row: invite }).action,
    'deliver', 'a ladder pause is three misses, and the quiet drop must not eat the one invite');
  // Still the night, like anything else Olma decided to say.
  assert.equal(decide({ ...base, paused: true, pausedRoomInvite: true, now: new Date('2026-08-16T00:00:00Z'),
    row: invite }).action, 'hold');
});

test('a paused member hears about the coordination once, and the second one leaves them out', async () => {
  const { group, people } = await room(1);
  const [asker, other, paused] = people;
  await withTx(db.pool, (c) => pause.pauseUser(c, paused.id, { note: 'test' }));

  const first = await start(group, asker, 'פאדל');
  assert.equal(first.participants, 3, 'an unspent pause is still counted in');
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);

  const toPaused = rec.sent.filter((r) => Number(r.user_id) === Number(paused.id));
  assert.equal(toPaused.length, 1, 'exactly one message reached the paused member');
  assert.equal(toPaused[0].payload.pausedNotice, true);
  assert.match(instructionFor(toPaused[0]), /PAUSED/);
  assert.doesNotMatch(instructionFor(rec.sent.find((r) => Number(r.user_id) === Number(other.id))), /PAUSED/,
    'nobody else is told they are paused');
  const { rows: [u] } = await db.pool.query(`SELECT room_invite_sent_at FROM users WHERE id = $1`, [paused.id]);
  assert.ok(u.room_invite_sent_at, 'the allowance is spent once the send confirmed');

  await close(first.meeting.id);
  const second = await start(group, asker, 'פאדל שוב');
  assert.equal(second.participants, 2, 'a spent pause is not swept into the next one');
  assert.equal(await stateOf(second.meeting.id, paused.id), null);
  const rows = await inviteRows(second.meeting.id);
  assert.ok(rows.every((r) => Number(r.user_id) !== Number(paused.id)));
});

test('a failed send spends nothing', async () => {
  const { group, people } = await room(2);
  const [asker, , paused] = people;
  await withTx(db.pool, (c) => pause.pauseUser(c, paused.id));
  await start(group, asker, 'קפה');
  await drainOnce(db.pool, async (r) => (Number(r.user_id) === Number(paused.id)
    ? { ok: false, error: 'boom' } : { ok: true }), GATE_NOW, live);
  const { rows: [u] } = await db.pool.query(`SELECT room_invite_sent_at FROM users WHERE id = $1`, [paused.id]);
  assert.equal(u.room_invite_sent_at, null);
});

test('answering inside a day ends the pause, even one they asked for; "stay paused" keeps the allowance spent', async () => {
  const { group, people } = await room(3);
  const [asker, , paused] = people;
  await withTx(db.pool, (c) => pause.pauseUser(c, paused.id));
  await start(group, asker, 'ארוחה');
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);

  await withTx(db.pool, (c) => turn.openRecord(c, paused, { wake: false }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, paused.id)), true,
    'a turn that is not them writing ends nothing');
  await withTx(db.pool, (c) => turn.openRecord(c, paused, { wake: true }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, paused.id)), false, 'writing back ends the pause');

  // "Leave me paused" — pause_olma. The new pause must not be a new allowance.
  await withTx(db.pool, (c) => pause.pauseUser(c, paused.id, { note: 'stay paused' }));
  const { rows: [u] } = await db.pool.query(
    `SELECT paused_at, room_invite_sent_at FROM users WHERE id = $1`, [paused.id]);
  assert.equal(pause.roomInviteSpent(u), true);
});

test('writing back days later still ends the pause, and "stay paused" survives their next message', async () => {
  const u = await makeUser(db.pool, '+972607799001');
  await withTx(db.pool, (c) => pause.pauseUser(c, u.id));
  await db.pool.query(
    `UPDATE users SET paused_at = now() - interval '5 days', room_invite_sent_at = now() - interval '4 days'
      WHERE id = $1`, [u.id]);
  await withTx(db.pool, (c) => turn.openRecord(c, u, { wake: true }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, u.id)), false, 'until he writes again');

  await withTx(db.pool, (c) => pause.pauseUser(c, u.id, { note: 'stay paused' }));
  await withTx(db.pool, (c) => turn.openRecord(c, u, { wake: true }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, u.id)), true,
    'the message after "leave me paused" does not undo it');
  const { rows: [r] } = await db.pool.query(`SELECT paused_at, room_invite_sent_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(pause.roomInviteSpent(r), true, 'and no second invite');
});

test('a new pause is a new allowance', async () => {
  const u = await makeUser(db.pool, '+972607799002');
  await db.pool.query(
    `UPDATE users SET paused_at = now(), room_invite_sent_at = now() - interval '10 days' WHERE id = $1`, [u.id]);
  const { rows: [r] } = await db.pool.query(`SELECT paused_at, room_invite_sent_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(pause.roomInviteSpent(r), false);
});

test('a day of silence takes them out of the coordination, and nobody is told they left', async () => {
  const { group, people } = await room(4);
  const [asker, , paused] = people;
  await withTx(db.pool, (c) => pause.pauseUser(c, paused.id));
  const started = await start(group, asker, 'טיול');
  const meetingId = Number(started.meeting.id);

  // Still held for them (nothing drained yet): the exit never overtakes it.
  // (The sweep is global, and earlier tests' rooms are still in the database,
  // so every assertion here is about THIS meeting only.)
  const mine = (res) => res.filter((r) => r.meetingId === meetingId);
  const early = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now() + 2 * DAY_MS));
  assert.equal(mine(early).length, 0, 'an invite still on its way holds the exit back');

  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  const soon = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now() + 3600_000));
  assert.equal(mine(soon).length, 0, 'inside the day they are still in it');

  const later = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now() + DAY_MS + 3600_000));
  assert.deepEqual(mine(later).map((r) => r.userId), [Number(paused.id)]);
  assert.equal(await stateOf(meetingId, paused.id), 'opted_out');
  const { rows: m } = await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(m[0].status, 'negotiating', 'two people are still coordinating');
  const { rows: told } = await db.pool.query(
    `SELECT kind FROM outbox WHERE (payload->>'meetingId')::bigint = $1
        AND kind IN ('meeting_opt_out', 'meeting_no_match')`, [meetingId]);
  assert.equal(told.length, 0, 'no "X left the meeting" for somebody who said nothing');
});

test('a silent exit that leaves one person closes it, and the initiator hears that', async () => {
  const a = await makeUser(db.pool, '+972607799101');
  const b = await makeUser(db.pool, '+972607799102');
  for (const u of [a, b]) await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: '120363333333339@g.us', subject: 'שניים', members: [{ phone: a.phone }, { phone: b.phone }],
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = 'g-x', identity_token = $2 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, 'olma_grp_' + '99'.repeat(16)]);
    return rows[0];
  });
  await withTx(db.pool, (c) => pause.pauseUser(c, b.id));
  const started = await start(group, a, 'קפה');
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now() + DAY_MS + 3600_000));
  const { rows: m } = await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [started.meeting.id]);
  assert.equal(m[0].status, 'no_match');
  const { rows: told } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_no_match' AND (payload->>'meetingId')::bigint = $1`,
    [started.meeting.id]);
  assert.deepEqual(told.map((r) => Number(r.user_id)), [Number(a.id)]);
});
