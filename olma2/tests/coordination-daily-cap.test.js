'use strict';
// The poker coordination, 2026-10-05: three people read the invite, a time
// added, and another time added inside 35 minutes. The owner's rule: each
// person hears about one coordination at most twice in their local day, the
// invite is the first, and the second waits three hours so it carries as much
// as it can. Everything counts; a result skips the wait, and past the cap it
// still goes out if the meeting is before the morning it would be held for.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const meetingFanout = require('../src/domain/meeting-fanout');
const { enqueue } = require('../src/outbox/enqueue');
const { decide, COORDINATION_GAP_MS } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');

// A Monday, 12:00 in Jerusalem (UTC+3 in August): inside the window, no quiet
// day, nothing depending on when the suite runs.
const NOW = new Date('2026-08-17T09:00:00Z');
const HOUR = 3600_000;
// 09:00 Jerusalem the next morning.
const NEXT_MORNING = new Date('2026-08-18T06:00:00Z');

const base = {
  plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: NOW,
};
const row = (kind) => ({ kind, urgency: 'urgent', expires_at: null, payload: { meetingId: 1 } });
const day = (heardToday, lastAgoMs, startsAt = null) => ({
  heardToday, lastHeardAt: lastAgoMs === null ? null : new Date(NOW.getTime() - lastAgoMs), startsAt,
});

test('gate: the first message of the day about a coordination goes out', () => {
  assert.equal(decide({ ...base, coordinationDay: day(0, null), row: row('meeting_invite') }).action, 'deliver');
});

test('gate: the second waits three hours behind the first, and then goes', () => {
  const held = decide({ ...base, coordinationDay: day(1, HOUR), row: row('meeting_slot_proposed') });
  assert.equal(held.action, 'hold');
  assert.equal(held.holdReason, 'coordination_gap');
  assert.equal(held.releaseAfter.getTime(), NOW.getTime() - HOUR + COORDINATION_GAP_MS);
  assert.equal(decide({ ...base, coordinationDay: day(1, 3 * HOUR), row: row('meeting_slot_proposed') }).action,
    'deliver');
});

test('gate: a result never waits out the gap', () => {
  for (const kind of ['meeting_confirmed', 'meeting_cancelled', 'meeting_time_set', 'meeting_exact_time_ask']) {
    assert.equal(decide({ ...base, coordinationDay: day(1, 10 * 60_000), row: row(kind) }).action, 'deliver', kind);
  }
});

test('gate: past two, everything waits for the next morning — results included', () => {
  for (const kind of ['meeting_slot_proposed', 'meeting_reopened', 'meeting_confirmed']) {
    const held = decide({ ...base, coordinationDay: day(2, 4 * HOUR), row: row(kind) });
    assert.equal(held.action, 'hold', kind);
    assert.equal(held.holdReason, 'coordination_daily', kind);
    assert.equal(held.releaseAfter.getTime(), NEXT_MORNING.getTime(), kind);
  }
});

test('gate: past two, a result about a meeting before that morning still goes out', () => {
  const tonight = new Date(NOW.getTime() + 9 * HOUR);
  assert.equal(decide({ ...base, coordinationDay: day(2, HOUR, tonight), row: row('meeting_confirmed') }).action,
    'deliver');
  // …but not a negotiation row about it, and not a result about next week.
  assert.equal(decide({ ...base, coordinationDay: day(2, HOUR, tonight), row: row('meeting_slot_proposed') }).action,
    'hold');
  const nextWeek = new Date(NOW.getTime() + 7 * 24 * HOUR);
  assert.equal(decide({ ...base, coordinationDay: day(2, HOUR, nextWeek), row: row('meeting_confirmed') }).action,
    'hold');
});

test('gate: nothing acts without the fact, and nothing but a meeting row is counted', () => {
  assert.equal(decide({ ...base, row: row('meeting_slot_proposed') }).action, 'deliver');
  assert.equal(decide({
    ...base, coordinationDay: day(5, 0), row: { kind: 'digest', urgency: 'normal', expires_at: null },
  }).action, 'deliver');
});

// ── The real drain ───────────────────────────────────────────────────────────

let db, ann, dana;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972509410001', { firstName: 'Ann' });
  dana = await makeUser(db.pool, '+972509410002', { firstName: 'Dana' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = ANY($1)`, [[ann.id, dana.id]]);
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, dana.phone, {});
    await connections.respondToConnection(c, dana.id, req.data.connection.id, 'approve');
  });
});
after(async () => { if (db) await db.teardown(); });

const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };

async function newMeeting(title) {
  return (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, title, [dana.id]))).data.meeting;
}

// A message that reached Dana at a moment of the test's choosing — the
// worker stamps with Postgres's clock, which is not NOW.
async function heard(m, kind, at) {
  await withTx(db.pool, (c) => enqueue(c, {
    userId: dana.id, kind, urgency: 'urgent', payload: { meetingId: Number(m.id) },
    idempotencyKey: `heard:${m.id}:${kind}:${at.getTime()}`,
  }));
  await db.pool.query(
    `UPDATE outbox SET sent_at = $3, hold_reason = NULL
      WHERE user_id = $1 AND sent_at IS NULL AND (payload->>'meetingId')::bigint = $2`,
    [dana.id, m.id, at]);
}

async function pendingRows(m) {
  const { rows } = await db.pool.query(
    `SELECT id, kind, hold_reason, release_after, payload FROM outbox
      WHERE user_id = $1 AND sent_at IS NULL AND (payload->>'meetingId')::bigint = $2 ORDER BY id`,
    [dana.id, m.id]);
  return rows;
}

test('drain: the second message is held behind the invite, and a later time folds into it', async () => {
  const m = await newMeeting('פוקר');
  await db.pool.query(`DELETE FROM outbox WHERE (payload->>'meetingId')::bigint = $1`, [m.id]);
  await heard(m, 'meeting_invite', new Date(NOW.getTime() - 20 * 60_000));

  await withTx(db.pool, (c) => meetingFanout.fanout(c, [dana.id], 'meeting_slot_proposed',
    { meetingId: Number(m.id), slot: 'שני 20:00' }, { key: `t1:${m.id}` }));
  const sent = [];
  await drainOnce(db.pool, async (r) => { sent.push(r.kind); return { ok: true }; }, NOW, live);
  assert.deepEqual(sent, [], 'nothing went out 20 minutes after the invite');
  let rows = await pendingRows(m);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hold_reason, 'coordination_gap');
  assert.equal(new Date(rows[0].release_after).getTime(), NOW.getTime() - 20 * 60_000 + COORDINATION_GAP_MS);

  // Another time added meanwhile rides the same held row.
  await withTx(db.pool, (c) => meetingFanout.fanout(c, [dana.id], 'meeting_slot_proposed',
    { meetingId: Number(m.id), slot: 'שלישי 20:00' }, { key: `t2:${m.id}` }));
  rows = await pendingRows(m);
  assert.equal(rows.length, 1, 'folded, not queued beside it');
  assert.equal(rows[0].payload.tableChanged, true);
});

test('drain: two already today holds a third until the next morning', async () => {
  const m = await newMeeting('פוקר שני');
  await db.pool.query(`DELETE FROM outbox WHERE (payload->>'meetingId')::bigint = $1`, [m.id]);
  await heard(m, 'meeting_invite', new Date(NOW.getTime() - 5 * HOUR));
  await heard(m, 'meeting_slot_proposed', new Date(NOW.getTime() - HOUR));
  await withTx(db.pool, (c) => meetingFanout.fanout(c, [dana.id], 'meeting_slot_proposed',
    { meetingId: Number(m.id), slot: 'רביעי 20:00' }, { key: `t3:${m.id}` }));
  await drainOnce(db.pool, async () => ({ ok: true }), NOW, live);
  const rows = await pendingRows(m);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hold_reason, 'coordination_daily');
  assert.equal(new Date(rows[0].release_after).getTime(), NEXT_MORNING.getTime());
});

test('drain: messages from yesterday leave today untouched', async () => {
  const m = await newMeeting('פוקר שלישי');
  await db.pool.query(`DELETE FROM outbox WHERE (payload->>'meetingId')::bigint = $1`, [m.id]);
  // 23:00 and 23:30 Jerusalem the night before.
  await heard(m, 'meeting_invite', new Date('2026-08-16T20:00:00Z'));
  await heard(m, 'meeting_slot_proposed', new Date('2026-08-16T20:30:00Z'));
  await withTx(db.pool, (c) => meetingFanout.fanout(c, [dana.id], 'meeting_slot_proposed',
    { meetingId: Number(m.id), slot: 'חמישי 20:00' }, { key: `t4:${m.id}` }));
  const sent = [];
  await drainOnce(db.pool, async (r) => { sent.push(Number(r.payload.meetingId)); return { ok: true }; }, NOW, live);
  assert.ok(sent.includes(Number(m.id)), 'a new day starts the count again');
});
