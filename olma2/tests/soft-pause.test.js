'use strict';
// The soft pause, השהייה רכה (owner, 2026-10-09; domain/pause.js,
// STOP_UNANSWERED). Somebody said stop, was asked "בטוח?", and said nothing
// for a day. Silence is not a yes: Olma stays quiet, each coordination opened
// with them is heard ONCE (as in the quiet pause, and never a nudge), the
// people errands reach them, and one fixed line a day says how to stop her
// completely. Stops said before the rule existed stay full.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const pause = require('../src/domain/pause');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');
const { instructionFor } = require('../src/channels/openclaw');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Fixed moments, in everybody's daytime and on no quiet day.
const GATE_NOW = new Date('2026-08-16T09:00:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };
const HOUR = 3600_000;

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r); return { ok: true }; } };
}

async function room(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726088${String(n).padStart(2, '0')}00${i}`, { firstName: ['רון', 'רונה', 'שקט'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036333333333${n}@g.us`, subject: 'חדר רך',
      members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3 WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n + 40).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  return { group, people };
}

// A stop said after the rule existed, and a day of silence after it.
async function softPause(userId) {
  await withTx(db.pool, (c) => pause.pauseUser(c, userId, { confirmed: false }));
  await db.pool.query(`UPDATE users SET paused_at = '2026-10-19T10:00:00Z' WHERE id = $1`, [userId]);
  const softened = await withTx(db.pool, (c) => pause.softenUnansweredStops(c, new Date('2026-10-20T12:00:00Z')));
  assert.ok(softened.includes(Number(userId)), 'softened');
}

test('a said_stop softens after a day of silence, and only one taken after the rule existed', async () => {
  const fresh = await makeUser(db.pool, '+972608899001');
  const young = await makeUser(db.pool, '+972608899002');
  const old = await makeUser(db.pool, '+972608899003');
  const confirmed = await makeUser(db.pool, '+972608899004');
  for (const u of [fresh, young, old]) await withTx(db.pool, (c) => pause.pauseUser(c, u.id, { confirmed: false }));
  await withTx(db.pool, (c) => pause.pauseUser(c, confirmed.id));
  const set = (u, at) => db.pool.query(`UPDATE users SET paused_at = $2 WHERE id = $1`, [u.id, at]);
  await set(fresh, '2026-10-19T10:00:00Z');
  await set(young, '2026-10-20T01:00:00Z');
  await set(old, '2026-09-23T04:32:00Z'); // Gal's shape: said before the rule
  await set(confirmed, '2026-10-19T10:00:00Z');

  const now = new Date('2026-10-20T12:00:00Z');
  const softened = await withTx(db.pool, (c) => pause.softenUnansweredStops(c, now));
  assert.deepEqual(softened, [Number(fresh.id)]);
  const { rows } = await db.pool.query(
    `SELECT id, paused_reason FROM users WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [[fresh.id, young.id, old.id, confirmed.id]]);
  assert.deepEqual(rows.map((r) => r.paused_reason), ['stop_unanswered', 'said_stop', 'said_stop', null]);
  const { rows: trail } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event = 'user.pause_softened'`, [fresh.id]);
  assert.equal(trail.length, 1);
  assert.deepEqual(await withTx(db.pool, (c) => pause.softenUnansweredStops(c, now)), [], 'a no-op the second time');
});

test('the predicates: not a pause they asked for, and their next word ends it', () => {
  const row = { paused_at: new Date(), paused_reason: pause.STOP_UNANSWERED };
  assert.equal(pause.softPaused(row), true);
  assert.equal(pause.pausedByRequest(row), false, 'a room counts them');
  assert.equal(pause.keptOutOfRooms(row), false);
  assert.equal(pause.endsOnWrite(row), true, 'a tag in a room is them coming back');
  assert.equal(pause.softPaused({ paused_at: new Date(), paused_reason: pause.SAID_STOP }), false);
  assert.equal(pause.softPaused({ paused_at: null, paused_reason: pause.STOP_UNANSWERED }), false);
});

test('gate: other people\'s errands pass a soft pause; a coordination needs its one message', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-16T12:00:00Z'), paused: true, softPaused: true,
  };
  const v = (row, extra = {}) => decide({ ...base, ...extra, row });
  assert.equal(v({ kind: 'connection_request', urgency: 'normal', payload: {} }).action, 'deliver');
  assert.equal(v({ kind: 'relayed_message', urgency: 'normal', payload: {} }).action, 'deliver');
  assert.equal(v({ kind: 'connection_request', urgency: 'normal', payload: {} }, { checkinMisses: 3 }).action, 'deliver',
    'silence does not eat it');
  assert.equal(v({ kind: 'meeting_invite', urgency: 'urgent', payload: { meetingId: 7 } }).holdReason, 'paused',
    'a coordination passes only on its one-message allowance');
  assert.equal(v({ kind: 'meeting_invite', urgency: 'urgent', payload: { meetingId: 7 } },
    { pausedRoomInvite: true }).action, 'deliver');
  for (const kind of ['reminder', 'checkin', 'digest', 'meeting_nudge', 'meeting_slot_proposed']) {
    assert.equal(v({ kind, urgency: 'normal', payload: { meetingId: 7 } }).holdReason, 'paused', kind);
  }
  assert.equal(v({ kind: 'relayed_message', urgency: 'normal', payload: {} },
    { now: new Date('2026-08-16T00:00:00Z') }).action, 'hold', 'the night still holds it');
  // A plain said_stop, a quiet pause, or no fact at all: errands stay out.
  for (const softPaused of [false, undefined]) {
    assert.equal(v({ kind: 'connection_request', urgency: 'normal', payload: {} }, { softPaused }).holdReason, 'paused');
  }
});

test('a room coordination: one message, the line on the first of the day, and nothing more', async () => {
  const { group, people } = await room(1);
  const [asker, , quiet] = people;
  await softPause(quiet.id);

  const started = (await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, asker, 'פוקר'))).data;
  assert.equal(started.participants, 3, 'swept in, as a quiet pause is');

  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);
  const toQuiet = rec.sent.filter((r) => Number(r.user_id) === Number(quiet.id));
  assert.equal(toQuiet.length, 1, 'the invite reached them');
  assert.equal(toQuiet[0].payload.pausedNotice, true, 'told it is the only message about it');
  assert.equal(toQuiet[0].payload.softPauseFooter, true);
  const text = instructionFor({ ...toQuiet[0], locale: 'he' });
  assert.ok(text.includes(pause.SOFT_PAUSE_FOOTER.he), 'the line is handed over word for word');
  assert.doesNotMatch(instructionFor({ ...toQuiet[0], locale: 'he', payload: { ...toQuiet[0].payload, softPauseFooter: false } }),
    /never answered whether/);
  const { rows: [stamped] } = await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND payload->>'softPauseFooter' = 'true'`, [quiet.id]);
  assert.ok(stamped, 'the stored row says the line went out');
  // Pin it to the gate's day, so "today" is measured against a known clock.
  await db.pool.query(`UPDATE outbox SET sent_at = $2 WHERE id = $1`, [stamped.id, GATE_NOW]);

  // The same coordination again: dropped, the allowance is spent.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key)
     VALUES ($1, 'meeting_slot_proposed', $2::jsonb, 'normal', 'soft-second')`,
    [quiet.id, JSON.stringify({ meetingId: Number(started.meeting.id), title: 'פוקר' })]);
  // Later the same day: another person's errand passes, and no second line.
  const errand = (key) => db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key)
     VALUES ($1, 'relayed_message', '{"text":"היי"}'::jsonb, 'normal', $2)`, [quiet.id, key]);
  await errand('soft-errand-1');
  const later = recorder();
  await drainOnce(db.pool, later.deliver, new Date(GATE_NOW.getTime() + 2 * HOUR), live);
  const again = later.sent.filter((r) => Number(r.user_id) === Number(quiet.id));
  assert.deepEqual(again.map((r) => r.kind), ['relayed_message']);
  assert.equal(again[0].payload.softPauseFooter, undefined, 'once a day');
  const { rows: second } = await db.pool.query(`SELECT hold_reason FROM outbox WHERE idempotency_key = 'soft-second'`);
  assert.equal(second[0].hold_reason, 'paused');

  // The next day, the first thing that reaches them carries it again.
  await errand('soft-errand-2');
  const tomorrow = recorder();
  await drainOnce(db.pool, tomorrow.deliver, new Date(GATE_NOW.getTime() + 24 * HOUR), live);
  const next = tomorrow.sent.filter((r) => Number(r.user_id) === Number(quiet.id));
  assert.equal(next.length, 1);
  assert.equal(next[0].payload.softPauseFooter, true);

  // Not at once: a stop nobody confirmed waits out its message, as the
  // ladder's does, rather than leaving like a pause they asked for.
  const early = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.ok(!early.some((o) => Number(o.userId) === Number(quiet.id)), 'still in on the day of its invite');

  // A day of silence after their one message takes them out, as a quiet
  // pause's does, and the exit is one their resume undoes.
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() - interval '2 days' WHERE id = $1`, [stamped.id]);
  await db.pool.query(
    `UPDATE meetings SET created_at = now() - interval '2 days' WHERE id = $1`, [started.meeting.id]);
  const out = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.ok(out.some((o) => Number(o.userId) === Number(quiet.id)), 'taken out after a day');
  const { rows: why } = await db.pool.query(
    `SELECT detail->>'cause' AS cause FROM audit_log WHERE actor_id = $1 AND event = 'meeting.opted_out'`, [quiet.id]);
  assert.deepEqual(why.map((r) => r.cause), ['paused_no_answer']);
});

test('a private coordination from a connection gets its one message; their next word ends the pause', async () => {
  const friend = await makeUser(db.pool, '+972608899010');
  const quiet = await makeUser(db.pool, '+972608899011');
  const { rows: [m] } = await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status) VALUES ($1, 'קפה', 'negotiating') RETURNING id`, [friend.id]);
  await softPause(quiet.id);
  for (const key of ['soft-friend-1', 'soft-friend-2']) {
    await db.pool.query(
      `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key)
       VALUES ($1, 'meeting_invite', $2::jsonb, 'urgent', $3)`,
      [quiet.id, JSON.stringify({ meetingId: Number(m.id), title: 'קפה', byName: 'חבר' }), key]);
    await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);
  }
  const { rows } = await db.pool.query(
    `SELECT idempotency_key, hold_reason FROM outbox WHERE idempotency_key LIKE 'soft-friend-%' ORDER BY idempotency_key`);
  assert.deepEqual(rows.map((r) => [r.idempotency_key, r.hold_reason]),
    [['soft-friend-1', null], ['soft-friend-2', 'paused']], 'one message per coordination');

  // Private, too: a day of silence after it and the friend is not left waiting.
  await db.pool.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, state) VALUES ($1, $2, 'awaiting'), ($1, $3, 'awaiting')`,
    [m.id, quiet.id, friend.id]);
  await db.pool.query(
    `UPDATE outbox SET sent_at = now() - interval '2 days' WHERE user_id = $1 AND sent_at IS NOT NULL`, [quiet.id]);
  await db.pool.query(`UPDATE meetings SET created_at = now() - interval '2 days' WHERE id = $1`, [m.id]);
  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1 AND sent_at IS NULL`, [quiet.id]);
  const out = await withTx(db.pool, (c) => groupMeetings.sweepSilentPausedMembers(c, Date.now()));
  assert.deepEqual(out.filter((o) => Number(o.meetingId) === Number(m.id)).map((o) => o.userId), [Number(quiet.id)]);

  await withTx(db.pool, (c) => pause.resumeOnWrite(c, quiet.id));
  const { rows: [u] } = await db.pool.query(`SELECT paused_at, paused_reason FROM users WHERE id = $1`, [quiet.id]);
  assert.equal(u.paused_at, null, 'their next message ends it, as it ends a said_stop');
  assert.equal(u.paused_reason, null);
});

test('the question says what a yes now costs', () => {
  assert.match(pause.CONFIRM_QUESTION.he, /תיאומי פגישות מאף אחד/);
  assert.match(pause.CONFIRM_QUESTION.en, /no more meeting coordinations from anyone/);
});
