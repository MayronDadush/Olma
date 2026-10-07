'use strict';
// A paused person standing in a room where a coordination starts (owner,
// 2026-09-13). Before this, the room counted them in, the gate dropped their
// invite, and everybody's digest said the coordination was waiting on
// somebody who had never heard of it. Now: one message per pause; an answer
// within a day ends the pause; silence takes them out of this coordination
// and every later one.
//
// Since 2026-09-27 that one message is for a pause the LADDER took — somebody
// less active. Somebody who paused her THEMSELVES hears nothing at all (owner:
// "השהייה אומר שהם לא מקבלים הודעות בכלל ממנה"), which is the second half of
// this file.
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
    const u = await makeUser(db.pool, `+9726077${String(n).padStart(2, '0')}00${i}`, { firstName: ['דני', 'דנה', 'קפיש'][i] });
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

// ── The same allowance, for a silence that is not a pause (owner, 2026-09-22)
// Guy had written to Olma on 2026-09-08, was never paused, and stood at two
// check-in misses when Padel Gang started its first coordination. The pause
// branch has had the allowance since 2026-09-13; the quiet branch had none, so
// his invite was dropped twice in three minutes while the room was told
// nothing about him at all.
test('gate: one room invite passes the quiet drop too, and only the allowance spends it', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-16T12:00:00Z'), checkinMisses: 2,
  };
  const invite = { kind: 'meeting_invite', urgency: 'urgent', expires_at: null };
  assert.equal(decide({ ...base, row: invite }).holdReason, 'quiet', 'two misses and no allowance');
  const past = decide({ ...base, quietRoomInvite: true, row: invite });
  assert.equal(past.action, 'deliver');
  assert.equal(past.spendsQuietRoomInvite, true, 'the gate says the allowance is what carried it');

  // A row the room window or their own page carried needs no allowance, so it
  // must not burn one.
  for (const carried of [{ groupWroteAt: base.now }, { dashboardWroteAt: base.now }]) {
    const v = decide({ ...base, ...carried, quietRoomInvite: true, row: invite });
    assert.equal(v.action, 'deliver');
    assert.equal(v.spendsQuietRoomInvite, undefined, `${Object.keys(carried)[0]} is not an allowance`);
  }
  // The night still applies to it, like anything else Olma decided to say. What
  // keeps it to an INVITE is the worker, which is the only thing that sets the
  // fact — asserted against a real queue in the test below.
  assert.equal(decide({ ...base, quietRoomInvite: true, now: new Date('2026-08-16T00:00:00Z'), row: invite }).action,
    'hold');
});

test('pause.quietRoomInviteSpent: one per run of silence, anchored on their last word', () => {
  const t = (ms) => new Date(Date.now() + ms);
  assert.equal(pause.quietRoomInviteSpent({ last_inbound_at: t(0) }), false, 'nothing spent yet');
  assert.equal(pause.quietRoomInviteSpent({ room_invite_sent_at: t(0), last_inbound_at: t(-1000) }), true);
  assert.equal(pause.quietRoomInviteSpent({ room_invite_sent_at: t(-1000), last_inbound_at: t(0) }), false,
    'they wrote after it, so this silence is a new one');
  assert.equal(pause.quietRoomInviteSpent({ room_invite_sent_at: t(-1000), last_dashboard_at: t(0) }), false,
    'the page is the DM\'s equal here, as it is in the gate');
  assert.equal(pause.quietRoomInviteSpent({ room_invite_sent_at: t(0) }), true,
    'never spoken at all, and it has been spent');
});

test('a silent member who was never paused hears about the coordination once', async () => {
  const { group, people } = await room(5);
  const [asker, other, silent] = people;
  // Two misses: the ladder asked and got nothing back, which is where the
  // allowance used to run out. Their last word is pushed back so the stamp the
  // drain writes lands after it.
  await db.pool.query(
    `UPDATE users SET checkin_misses = 2, last_inbound_at = now() - interval '14 days' WHERE id = $1`, [silent.id]);

  const first = await start(group, asker, 'פאדל');
  assert.equal(first.participants, 3, 'a silence is not a pause and nothing drops them from the room');
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);

  const toSilent = rec.sent.filter((r) => Number(r.user_id) === Number(silent.id));
  assert.equal(toSilent.length, 1, 'the invite reached them');
  assert.equal(toSilent[0].payload.pausedNotice, undefined, 'they are not paused and are not told they are');
  assert.doesNotMatch(instructionFor(toSilent[0]), /PAUSED/);
  const { rows: [u] } = await db.pool.query(`SELECT room_invite_sent_at FROM users WHERE id = $1`, [silent.id]);
  assert.ok(u.room_invite_sent_at, 'the allowance is spent once the send confirmed');
  assert.equal(pause.quietRoomInviteSpent({ ...u, last_inbound_at: null, last_dashboard_at: null }), true);
  const { rows: trail } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event LIKE '%room_invite_sent'`, [silent.id]);
  assert.deepEqual(trail.map((r) => r.event), ['quiet.room_invite_sent'],
    'the trail says which of the two rules paid');
  assert.ok(rec.sent.some((r) => Number(r.user_id) === Number(other.id)), 'everybody else is unaffected');

  // Nothing else of theirs moves: the allowance is an invite's, and the rest of
  // this person's queue is as silent as it was before.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency) VALUES ($1, 'reminder', $2::jsonb, 'normal')`,
    [silent.id, JSON.stringify({ title: 'לשתות מים', auto: true, rung: 2 })]);
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  const { rows: rem } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'reminder'`, [silent.id]);
  assert.deepEqual(rem.map((r) => r.hold_reason), ['quiet']);

  // A second coordination inside the same silence gets nothing — one, not one
  // per coordination.
  await close(first.meeting.id);
  const second = await start(group, asker, 'פאדל שוב');
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  const rows = (await inviteRows(second.meeting.id)).filter((r) => Number(r.user_id) === Number(silent.id));
  assert.equal(rows.length, 1, 'the row is still created — the room counts them in');
  assert.equal(rows[0].hold_reason, 'quiet', 'and the allowance is spent, so it drops as it always did');
});

test('a quietly paused member hears about EACH coordination once (owner, 2026-10-07)', async () => {
  const { group, people } = await room(1);
  const [asker, other, paused] = people;
  await withTx(db.pool, (c) => pause.quietPause(c, paused.id));

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

  // A changed table writes the invite again ("tableChanged"). That is the
  // same coordination, and its one message is spent.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key)
     VALUES ($1, 'meeting_invite', $2, 'urgent', $3)`,
    [paused.id, JSON.stringify({ meetingId: first.meeting.id, title: 'פאדל', tableChanged: true }),
      `reinvite:${first.meeting.id}:${paused.id}`]);
  const again = recorder();
  await drainOnce(db.pool, again.deliver, GATE_NOW, live);
  assert.equal(again.sent.filter((r) => Number(r.user_id) === Number(paused.id)).length, 0,
    'a second invite about the same coordination does not reach them');

  // The NEXT coordination is a new one: one message about it too. Until
  // 2026-10-07 one invite per pause left them out of every later one.
  await close(first.meeting.id);
  const second = await start(group, asker, 'פאדל שוב');
  assert.equal(second.participants, 3, 'a quiet pause is swept into the next coordination');
  const next = recorder();
  await drainOnce(db.pool, next.deliver, GATE_NOW, live);
  const toPausedNext = next.sent.filter((r) => Number(r.user_id) === Number(paused.id));
  assert.equal(toPausedNext.length, 1, 'and hears about it once');
  assert.equal(toPausedNext[0].payload.pausedNotice, true);
});

test('a failed send spends nothing', async () => {
  const { group, people } = await room(2);
  const [asker, , paused] = people;
  await withTx(db.pool, (c) => pause.quietPause(c, paused.id));
  await start(group, asker, 'קפה');
  await drainOnce(db.pool, async (r) => (Number(r.user_id) === Number(paused.id)
    ? { ok: false, error: 'boom' } : { ok: true }), GATE_NOW, live);
  const { rows: [u] } = await db.pool.query(`SELECT room_invite_sent_at FROM users WHERE id = $1`, [paused.id]);
  assert.equal(u.room_invite_sent_at, null);
});

test('answering inside a day ends the pause; "stay paused" keeps the allowance spent', async () => {
  const { group, people } = await room(3);
  const [asker, , paused] = people;
  await withTx(db.pool, (c) => pause.quietPause(c, paused.id));
  await start(group, asker, 'ארוחה');
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);

  await withTx(db.pool, (c) => turn.openRecord(c, paused, { wake: false }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, paused.id)), true,
    'a turn that is not them writing ends nothing');
  await withTx(db.pool, (c) => turn.openRecord(c, paused, { wake: true }));
  assert.equal(await withTx(db.pool, (c) => pause.isPaused(c, paused.id)), false, 'writing back ends the pause');

  // "Leave me paused" — pause_olma. That answer is already their yes, so it
  // lasts without the question, and the new pause must not be a new allowance.
  const kept = await withTx(db.pool, (c) => pause.requestPause(c, paused, { note: 'stay paused', confirmed: true }));
  assert.equal(kept.data.confirmed, true, 'their answer to the invite is the yes');
  assert.equal(kept.data.askThem, undefined);
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
  await withTx(db.pool, (c) => pause.quietPause(c, paused.id));
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

// Until 2026-09-23 the opener was sent "nobody matched" on its own. Nobody
// manages a coordination now: whoever is left reads it in their next digest.
test('a silent exit that leaves one person closes it, and whoever is left reads that in the digest', async () => {
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
  await withTx(db.pool, (c) => pause.quietPause(c, b.id));
  const started = await start(group, a, 'קפה');
  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now() + DAY_MS + 3600_000));
  const { rows: m } = await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [started.meeting.id]);
  assert.equal(m[0].status, 'no_match');
  const { rows: told } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_no_match' AND (payload->>'meetingId')::bigint = $1`,
    [started.meeting.id]);
  assert.deepEqual(told, [], 'not a message of its own');
  const d = await withTx(db.pool, (c) => require('../src/domain/digest').assemble(c, a.id, 'summary'));
  assert.deepEqual(d.data.crossUser.closedMeetings.map((x) => Number(x.id)), [Number(started.meeting.id)]);
});

// ── A pause they ASKED for (owner, 2026-09-27) ───────────────────────────────
// Gal (u-37) wrote "dont send me messages" because of Padel Gang's
// coordination, was paused under `said_stop`, and four days later the room's
// next coordination reached him privately: the allowance above made no
// difference between somebody less active and somebody who asked her to stop.
const meetingOptions = require('../src/domain/meeting-options');
const meetings = require('../src/domain/meetings');
const calendar = require('../src/domain/calendar');

const ASKED = [
  ['a confirmed stop', (c, id) => pause.pauseUser(c, id)],
  ['a stop said a moment ago', (c, id) => pause.pauseUser(c, id, { confirmed: false })],
];

for (const [label, stop] of ASKED) {
  test(`${label}: a new room coordination neither counts them nor writes to them`, async () => {
    const { group, people } = await room(label === ASKED[0][0] ? 11 : 12);
    const [asker, other, stopped] = people;
    await withTx(db.pool, (c) => stop(c, stopped.id));

    const first = await start(group, asker, 'פאדל');
    assert.equal(first.participants, 2, 'not swept in');
    assert.equal(await stateOf(first.meeting.id, stopped.id), null);
    const rec = recorder();
    await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
    assert.equal(rec.sent.filter((r) => Number(r.user_id) === Number(stopped.id)).length, 0, 'nothing reached them');
    assert.ok(rec.sent.some((r) => Number(r.user_id) === Number(other.id)));
    const { rows: [u] } = await db.pool.query(`SELECT room_invite_sent_at FROM users WHERE id = $1`, [stopped.id]);
    assert.equal(u.room_invite_sent_at, null, 'no allowance spent, because there is none');

    // The room's NUMBER still counts them (owner, 2026-09-28: the room sees how
    // many people are in it) — but as a number, never a tag.
    const co = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, first.meeting))).coordination;
    assert.equal(co.roomTotal, 3, 'three people are in the room, and the room can count');
    assert.ok(!co.notInIt.some((p) => p.phone === stopped.phone), 'never tagged as not having answered');
    assert.equal(co.notInIt.filter((p) => p.paused).length, 1, 'counted among those who have not said yes');
  });
}

test('an invite that reaches the queue anyway is still dropped for somebody who asked to stop', async () => {
  // A dropped invite comes back as a fresh one when the table next moves
  // (meeting-fanout.unheardInvite), so the worker is where this has to hold.
  const { group, people } = await room(13);
  const [asker, , stopped] = people;
  const started = await start(group, asker, 'ערב');
  await withTx(db.pool, (c) => pause.pauseUser(c, stopped.id, { confirmed: false }));
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key)
     VALUES ($1, 'meeting_invite', $2::jsonb, 'urgent', 'test-reinvite')`,
    [stopped.id, JSON.stringify({ meetingId: Number(started.meeting.id), title: 'ערב', groupSubject: 'חדר בדיקה' })]);
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  assert.equal(rec.sent.filter((r) => Number(r.user_id) === Number(stopped.id)).length, 0);
  const { rows } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE idempotency_key = 'test-reinvite'`);
  assert.equal(rows[0].hold_reason, 'paused');
});

test('somebody already in it who asks to stop is taken out at once and still COUNTED, so the room closes it by "סגור"', async () => {
  const { group, people } = await room(14);
  const [asker, other, stopped] = people;
  const started = await start(group, asker, 'שבת');
  const meetingId = Number(started.meeting.id);
  const { rows: [opt] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at) VALUES ($1, 'שבת 17:00', now() + interval '3 days')
     RETURNING id`, [meetingId]);
  for (const u of [asker, other]) {
    await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`,
      [opt.id, u.id]);
  }
  assert.equal(await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId)), null,
    'while they are in it, the room waits on them');

  await withTx(db.pool, (c) => pause.pauseUser(c, stopped.id, { confirmed: false }));
  // Before the sweep runs: the room already does not tag them or wait on them.
  const co = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, started.meeting))).coordination;
  assert.equal(co.participants, 2);
  assert.ok(!co.silent.some((p) => p.phone === stopped.phone));
  assert.ok(!co.options[0].missing.some((p) => p.phone === stopped.phone));
  assert.ok(!co.optedOut.some((p) => p.phone === stopped.phone), 'and not said to have left');
  assert.equal(co.roomTotal, 3, 'but the room still counts them (owner, 2026-09-28)');
  // Two of three said yes: "everybody" is not true, so nothing closes on its own.
  assert.equal(await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId)), null);

  // No waiting a day: the pause is theirs.
  const res = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.deepEqual(res.filter((r) => r.meetingId === meetingId).map((r) => r.userId), [Number(stopped.id)]);
  assert.equal(await stateOf(meetingId, stopped.id), 'opted_out');
  const { rows: trail } = await db.pool.query(
    `SELECT detail->>'cause' AS cause FROM audit_log WHERE actor_id = $1 AND event = 'meeting.opted_out'`,
    [stopped.id]);
  assert.deepEqual(trail.map((r) => r.cause), ['paused_by_request']);

  // Out of the coordination by a PAUSE is not out of the room's count.
  const after = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, started.meeting))).coordination;
  assert.equal(after.roomTotal, 3);
  assert.equal(after.notInIt.filter((p) => p.paused).length, 1);
  assert.equal(await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId)), null);

  // Their next message ends the stop, and with it the exit (Eden, 2026-10-05):
  // back in the coordination, and no longer counted a second time as a paused
  // member who has not answered — the latest exit on record is still the pause.
  const back = await withTx(db.pool, (c) => pause.stopResume(c, stopped.id));
  assert.deepEqual(back.data.meetingsRestored.map((x) => x.meetingId), [meetingId]);
  assert.notEqual(await stateOf(meetingId, stopped.id), 'opted_out');
  const returned = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, started.meeting))).coordination;
  assert.equal(returned.participants, 3);
  assert.equal(returned.roomTotal, 3);
  assert.equal(returned.notInIt.filter((p) => p.paused).length, 0, 'in it, so not "paused and not in it"');
  await withTx(db.pool, (c) => pause.pauseUser(c, stopped.id, { confirmed: false }));
  await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));

  // …whereas somebody who CHOSE to leave it is out of the count, and the rest can be unanimous.
  await db.pool.query(`UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, stopped.id]);
  await db.pool.query(
    `INSERT INTO audit_log (actor_id, event, detail) VALUES ($1, 'meeting.opted_out', $2::jsonb)`,
    [stopped.id, JSON.stringify({ meetingId, cause: 'user_choice' })]);
  const chose = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, started.meeting))).coordination;
  assert.equal(chose.roomTotal, 2);
  const win = await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId));
  assert.equal(win && Number(win.id), Number(opt.id));
});

test('somebody who asks to stop AFTER answering stays in with that answer, and is never tagged (Eden, 2026-10-05)', async () => {
  const { group, people } = await room(30);
  const [asker, other, stopped] = people;
  const started = await start(group, asker, 'פוקר');
  const meetingId = Number(started.meeting.id);
  const { rows: [fri] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at) VALUES ($1, 'שישי 11:00', now() + interval '4 days')
     RETURNING id`, [meetingId]);
  const { rows: [gone] } = await db.pool.query(
    `INSERT INTO meeting_options (meeting_id, slot_text, starts_at, status) VALUES ($1, 'חמישי 20:00', now() + interval '3 days', 'deleted')
     RETURNING id`, [meetingId]);
  await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`,
    [fri.id, stopped.id]);
  await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`,
    [gone.id, other.id]);

  await withTx(db.pool, (c) => pause.pauseUser(c, stopped.id, { confirmed: true }));
  const res = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.ok(!res.some((r) => r.meetingId === meetingId && r.userId === Number(stopped.id)),
    'an answer on the table keeps them in');
  assert.notEqual(await stateOf(meetingId, stopped.id), 'opted_out');

  const co = (await withTx(db.pool, (c) => groupMeetings.statusOf(c, group, started.meeting))).coordination;
  assert.equal(co.participants, 3, 'counted');
  assert.equal(co.options[0].yes.length, 1, 'their yes counts');
  assert.ok(co.options[0].yes.every((p) => p.phone === null && p.tag === null && p.paused), 'and never tags them');
  assert.equal(co.notInIt.filter((p) => p.paused).length, 0, 'in it, so not "paused and not in it"');

  // The room waits on them like anybody in it, and their yes is part of "everybody".
  assert.equal(await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId)), null);
  for (const u of [asker, other]) {
    await db.pool.query(`INSERT INTO meeting_option_answers (option_id, user_id, answer) VALUES ($1, $2, 'y')`,
      [fri.id, u.id]);
  }
  const win = await withTx(db.pool, (c) => meetingOptions.unanimousOption(c, meetingId));
  assert.equal(win && Number(win.id), Number(fri.id));

  // An answer only on a time that has LEFT the table answers nothing: the pause takes them out.
  await db.pool.query(`DELETE FROM meeting_option_answers WHERE option_id = $1 AND user_id = $2`, [fri.id, other.id]);
  await withTx(db.pool, (c) => pause.pauseUser(c, other.id, { confirmed: true }));
  const res2 = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.deepEqual(res2.filter((r) => r.meetingId === meetingId).map((r) => r.userId), [Number(other.id)]);
});

test('a Google invitation is a message too: somebody who asked to stop is not on the event', async () => {
  const { group, people } = await room(15);
  const [asker, , stopped] = people;
  const started = await start(group, asker, 'ארוחה');
  for (const u of people) {
    await db.pool.query(
      `INSERT INTO integrations (user_id, provider, status, access_level) VALUES ($1, 'google_calendar', 'connected', 'read_write')`,
      [u.id]);
  }
  const before = await withTx(db.pool, (c) => calendar.meetingCalendarRoles(c, started.meeting.id));
  assert.ok(before.connectedIds.includes(Number(stopped.id)));
  await withTx(db.pool, (c) => pause.pauseUser(c, stopped.id));
  const after = await withTx(db.pool, (c) => calendar.meetingCalendarRoles(c, started.meeting.id));
  assert.ok(!after.connectedIds.includes(Number(stopped.id)));
  assert.ok(!after.participantIds.includes(Number(stopped.id)));
});

test('leaving a coordination withdraws what was still queued for them about it', async () => {
  const { group, people } = await room(16);
  const [asker, , leaver] = people;
  const started = await start(group, asker, 'קולנוע');
  const meetingId = Number(started.meeting.id);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, release_after, idempotency_key)
     VALUES ($1, 'meeting_slot_proposed', $2::jsonb, 'normal', now() + interval '10 minutes', 'test-paced')`,
    [leaver.id, JSON.stringify({ meetingId, slot: 'שני 20:00', title: 'קולנוע' })]);
  const res = await withTx(db.pool, (c) => meetings.applyExit(c, leaver.id, meetingId, 'user_choice'));
  assert.equal(res.ok, true);
  const { rows } = await db.pool.query(
    `SELECT kind, sent_at, hold_reason FROM outbox
      WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2`, [leaver.id, meetingId]);
  assert.ok(rows.length >= 2, 'the invite and the paced proposal');
  assert.ok(rows.every((r) => r.sent_at && r.hold_reason === 'superseded'), JSON.stringify(rows));
});

test('somebody who left the WhatsApp group is taken out of its coordination; a re-spelled roster row is not a leaver', async () => {
  const { group, people } = await room(17);
  const [asker, stays, leaver] = people;
  const started = await start(group, asker, 'ים');
  const meetingId = Number(started.meeting.id);
  const mine = (res) => res.filter((r) => r.meetingId === meetingId);

  // The roster re-spelled `stays`: one row left, another current — same person.
  await db.pool.query(
    `UPDATE chat_group_members SET left_at = now() WHERE group_id = $1 AND user_id = $2`, [group.id, stays.id]);
  await db.pool.query(
    `INSERT INTO chat_group_members (group_id, phone, user_id) VALUES ($1, '123456789012345', $2)`,
    [group.id, stays.id]);
  assert.equal(mine(await withTx(db.pool, (c) => groupMeetings.sweepRoomLeavers(c))).length, 0);

  await db.pool.query(
    `UPDATE chat_group_members SET left_at = now() WHERE group_id = $1 AND user_id = $2`, [group.id, leaver.id]);
  const out = mine(await withTx(db.pool, (c) => groupMeetings.sweepRoomLeavers(c)));
  assert.deepEqual(out.map((r) => r.userId), [Number(leaver.id)]);
  assert.equal(await stateOf(meetingId, leaver.id), 'opted_out');
  assert.equal(await stateOf(meetingId, stays.id), 'awaiting');
});
