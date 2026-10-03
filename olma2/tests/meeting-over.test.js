'use strict';
// Padel Gang moved its Saturday game from 18:00 to 17:00 at 10:40 that
// morning. Sharon keeps Shabbat quiet, so the reopening and the new
// confirmation were both held for her until havdalah — about 18:35, an hour
// and a half after the game had started. The owner: nothing about a meeting
// is sent once it has happened (2026-10-03). The gate drops it as
// `meeting_over`; the worker says which rows that is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const { enqueue } = require('../src/outbox/enqueue');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');

let db, ann, sharon;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972509400001', { firstName: 'Ann' });
  sharon = await makeUser(db.pool, '+972509400002', { firstName: 'Sharon' });
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, sharon.phone, {});
    await connections.respondToConnection(c, sharon.id, req.data.connection.id, 'approve');
  });
});
after(async () => { if (db) await db.teardown(); });

// A weekday morning inside everybody's window, so nothing depends on the hour
// or the day the suite runs.
const GATE_NOW = new Date('2026-08-17T09:00:00Z');
const HOUR = 3600_000;
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };

test('gate: a meeting row is dropped once its meeting is over, and nothing else is', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-17T09:00:00Z'),
  };
  const confirmed = { kind: 'meeting_confirmed', urgency: 'urgent', expires_at: null };
  assert.equal(decide({ ...base, row: confirmed }).action, 'deliver');
  assert.deepEqual(decide({ ...base, meetingOver: true, row: confirmed }),
    { action: 'drop', holdReason: 'meeting_over' });
  // Only an explicit true, and only a meeting kind.
  assert.equal(decide({ ...base, meetingOver: 'yes', row: confirmed }).action, 'deliver');
  assert.equal(decide({ ...base, meetingOver: true, row: { kind: 'digest', urgency: 'normal', expires_at: null } }).action,
    'deliver');
});

async function confirmedMeeting(title, startAt, { allDay = false } = {}) {
  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, title, [sharon.id]))).data.meeting;
  await db.pool.query(
    `UPDATE meetings SET status = 'confirmed', confirmed_slot = $2, confirmed_start_at = $3,
            confirmed_all_day = $4 WHERE id = $1`,
    [m.id, title, startAt, allDay]);
  return m;
}

test('the real drain drops what is about a meeting already started, and delivers the rest', async () => {
  const past = await confirmedMeeting('פאדל', new Date(GATE_NOW.getTime() - HOUR));
  const ahead = await confirmedMeeting('קפה', new Date(GATE_NOW.getTime() + 2 * HOUR));
  // An all-day meeting stores the day's start; three hours into its day it is
  // still today's, and still news.
  const allDay = await confirmedMeeting('טיול', new Date(GATE_NOW.getTime() - 3 * HOUR), { allDay: true });

  const rows = [
    [past, 'meeting_reopened'], [past, 'meeting_confirmed'],
    [ahead, 'meeting_confirmed'], [allDay, 'meeting_confirmed'],
  ];
  for (const [m, kind] of rows) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: sharon.id, kind, urgency: 'urgent',
      payload: { meetingId: Number(m.id), slot: m.title },
      idempotencyKey: `over:${m.id}:${kind}`,
    }));
  }
  // Delivered rows of one person count against the repeat guard, so drain
  // until nothing is left due.
  const sent = [];
  const deliver = async (r) => { sent.push({ meetingId: Number(r.payload.meetingId), kind: r.kind }); return { ok: true }; };
  for (let i = 0; i < 6; i++) await drainOnce(db.pool, deliver, GATE_NOW, live);

  const { rows: out } = await db.pool.query(
    `SELECT (payload->>'meetingId')::int AS mid, kind, hold_reason, sent_at IS NOT NULL AS stamped
       FROM outbox WHERE user_id = $1 AND kind LIKE 'meeting_%' ORDER BY id`, [sharon.id]);
  const of = (m, kind) => out.find((r) => r.mid === Number(m.id) && r.kind === kind);

  for (const kind of ['meeting_reopened', 'meeting_confirmed']) {
    assert.equal(of(past, kind).hold_reason, 'meeting_over', `${kind} about a game already started`);
    assert.equal(of(past, kind).stamped, true, 'terminal, so nothing re-creates it');
  }
  assert.ok(!sent.some((s) => s.meetingId === Number(past.id)), 'nothing about it reached her');
  assert.ok(sent.some((s) => s.meetingId === Number(ahead.id)), 'a meeting still ahead is delivered');
  assert.ok(sent.some((s) => s.meetingId === Number(allDay.id)), 'an all-day meeting is news all its day');
});
