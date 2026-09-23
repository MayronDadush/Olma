'use strict';
// Sharon took שבת 16:00 off the table at 16:24, asked the room for 17:00, and
// answered yes to 17:00. Overnight the coordination closed on 17:00 — and of
// the five people in it he was the only one never told, because two check-ins
// he had ignored the evening before put `checkin_misses` at 2 and the gate's
// "somebody who has stopped answering" branch DROPPED his confirmation. The
// room's closing line tagged him as one of the four who were in
// (`incidents.md`, "The room named him and nobody told him", 2026-09-23).
//
// `jobs/checkin.pickRung` had drawn the right line two weeks earlier, one
// layer up: at `misses >= 1` the discovery pitch and Olma's opinions stop, and
// `stuck_meeting` and `deadline_risk` still go, "because a meeting waiting on
// them or a deadline tomorrow is theirs, not ours." The gate could not tell
// the two apart, so the ladder's own check-in passed and the news did not.
//
// The owner chose the NARROW line: an ANSWER on record is what earns the
// exemption, never membership. An invite to somebody who has engaged with
// nothing is still Olma's initiative and still drops — Vered's rule stands.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const connections = require('../src/domain/connections');
const { enqueue } = require('../src/outbox/enqueue');
const { decide } = require('../src/outbox/gate');
const { drainOnce } = require('../src/outbox/worker');

let db, ann, answered, silent;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972509300001', { firstName: 'Ann' });
  answered = await makeUser(db.pool, '+972509300002', { firstName: 'Sharon' });
  silent = await makeUser(db.pool, '+972509300003', { firstName: 'Dana' });
  for (const u of [answered, silent]) {
    await withTx(db.pool, async (c) => {
      const req = await connections.requestConnection(c, ann.id, u.phone, {});
      await connections.respondToConnection(c, u.id, req.data.connection.id, 'approve');
    });
  }
});
after(async () => { if (db) await db.teardown(); });

// A fixed moment inside everybody's daytime and on no quiet day, so nothing
// here depends on when the suite runs.
const GATE_NOW = new Date('2026-08-16T09:00:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push({ userId: Number(r.user_id), kind: r.kind }); return { ok: true }; } };
}

test('gate: an answer on record is what carries a coordination past a silence, and nothing else changes', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date('2026-08-16T12:00:00Z'), checkinMisses: 2,
  };
  const confirmed = { kind: 'meeting_confirmed', urgency: 'urgent', expires_at: null };
  const invite = { kind: 'meeting_invite', urgency: 'urgent', expires_at: null };

  assert.equal(decide({ ...base, row: confirmed }).holdReason, 'quiet',
    'this is the bug: the answer to their own question, dropped');
  assert.equal(decide({ ...base, answeredCoordination: true, row: confirmed }).action, 'deliver');

  // The narrow line. An invite reaches somebody who has answered nothing —
  // by construction, since the invite is what asks — so it still drops, and
  // `pausedRoomInvite` stays the only way a first one gets through.
  assert.equal(decide({ ...base, row: invite }).holdReason, 'quiet');
  assert.equal(decide({ ...base, pausedRoomInvite: true, row: invite }).action, 'deliver');

  // Vered's rule, untouched: what Olma DECIDED to say still goes nowhere, and
  // the worker leaves this fact false for every row with no meeting behind it.
  for (const kind of ['digest', 'tasks_auto_archived', 'travel']) {
    assert.equal(decide({ ...base, row: { kind, urgency: 'normal', expires_at: null } }).holdReason, 'quiet',
      `${kind} is still Olma's idea`);
  }
  // An automatic reminder is the model's inference; one they asked for in
  // words is a moment they chose. Neither answer moves.
  assert.equal(decide({ ...base, row: { kind: 'reminder', urgency: 'urgent', expires_at: null, payload: { rung: 1, auto: true } } }).holdReason, 'quiet');
  assert.equal(decide({ ...base, row: { kind: 'reminder', urgency: 'urgent', expires_at: null, payload: { rung: 1, auto: false } } }).action, 'deliver');

  // The night is still the night. The exemption says this row is theirs, not
  // that the hour stopped mattering.
  assert.equal(decide({ ...base, answeredCoordination: true, now: new Date('2026-08-16T00:00:00Z'), row: confirmed }).action,
    'hold', 'held for the morning, exactly like anything else');
});

test('the worker reads the answer for THIS row\'s coordination, and the real drain proves it', async () => {
  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'פאדל השבוע', [answered.id, silent.id]))).data.meeting;
  // The weekday goes to `slotStart` too, not just into the description: it
  // snaps the moment forward to that day, and `options.add` refuses a
  // description and a time that name different ones. Without it this file is
  // green on the days when now+72h happens to land on a Saturday.
  const when = slotStart('שבת 17:00', { hours: 72, hourUtc: 14 });
  const optionId = (await withTx(db.pool, (c) => options.add(c, ann.id, m.id, 'שבת 17:00', when))).data.option.id;
  // One of them answers. The other is in the coordination and has said nothing
  // about it — the only difference between the two rows below.
  await withTx(db.pool, (c) => options.answer(c, answered.id, m.id, optionId, 'y'));

  // Both ignored two check-ins last night, which is all it takes.
  await db.pool.query(`UPDATE users SET checkin_misses = 2 WHERE id = ANY($1)`, [[answered.id, silent.id]]);

  for (const u of [answered, silent]) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: u.id, kind: 'meeting_confirmed', urgency: 'urgent',
      payload: { meetingId: Number(m.id), slot: 'שבת 17:00' },
      idempotencyKey: `conf:${m.id}:${u.id}`,
    }));
  }

  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, GATE_NOW, live);

  const { rows } = await db.pool.query(
    `SELECT user_id, sent_at IS NOT NULL AS stamped, hold_reason FROM outbox
      WHERE kind = 'meeting_confirmed' ORDER BY user_id`);
  const byUser = new Map(rows.map((r) => [Number(r.user_id), r]));
  assert.equal(byUser.get(Number(answered.id)).hold_reason, null,
    'he answered yes to this time; being told it closed is not Olma changing the subject');
  assert.equal(byUser.get(Number(silent.id)).hold_reason, 'quiet',
    'she is in the coordination and has answered nothing in it — the narrow line holds');
  assert.deepEqual(rec.sent, [{ userId: Number(answered.id), kind: 'meeting_confirmed' }]);
});

test('an answer to a DELETED option still counts, and an answer in another coordination does not', async () => {
  // The option somebody answered about is the first thing a negotiation throws
  // away — Sharon's own `n` was on the 16:00 he took off the table. If the
  // fact were read off live options only, the person who shaped the table most
  // would be the likeliest to lose it.
  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'בריכה', [silent.id]))).data.meeting;
  const addRes = await withTx(db.pool, (c) => options.add(c, ann.id, m.id, 'שבת 16:00', slotStart('שבת 16:00', { hours: 96, hourUtc: 13 })));
  assert.equal(addRes.ok, true, JSON.stringify(addRes.error));
  const gone = addRes.data.option.id;
  await withTx(db.pool, (c) => options.answer(c, silent.id, m.id, gone, 'n'));
  await withTx(db.pool, (c) => options.remove(c, ann.id, m.id, gone));

  // And a row about a DIFFERENT coordination must not borrow it.
  const other = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'טניס', [silent.id]))).data.meeting;

  for (const [mid, tag] of [[m.id, 'answered-then-deleted'], [other.id, 'never-answered']]) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: silent.id, kind: 'meeting_slot_proposed', urgency: 'urgent',
      payload: { meetingId: Number(mid), slot: 'x' }, idempotencyKey: `prop:${tag}`,
    }));
  }
  await db.pool.query(`UPDATE users SET checkin_misses = 2 WHERE id = $1`, [silent.id]);

  await drainOnce(db.pool, recorder().deliver, GATE_NOW, live);

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, hold_reason FROM outbox
      WHERE idempotency_key IN ('prop:answered-then-deleted', 'prop:never-answered')
      ORDER BY idempotency_key`);
  assert.deepEqual(rows.map((r) => [r.idempotency_key, r.hold_reason]), [
    ['prop:answered-then-deleted', null],
    ['prop:never-answered', 'quiet'],
  ], 'the fact is per coordination, and a deleted option is still an answer');
});
