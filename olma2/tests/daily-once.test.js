'use strict';
// Once a day (owner, 2026-10-03, for Saar first): somebody on
// `daily_once_phones` hears ONE message a day that Olma started, at 20:00
// their time, carrying everything still open — and nothing at all when nothing
// is. On 2026-10-03 Saar read a coordination invite, a time set, a cold room
// invite, a proposed slot, a confirmation, two withdrawals and four check-ins
// across the week, while his preference said "once a day". Replies to his own
// messages are not this gate's business and are untouched.
//
// Every moment is pinned (rules, "Never let a test depend on the hour it
// runs"): Monday 2026-10-05, Asia/Jerusalem is UTC+3.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { drainOnce } = require('../src/outbox/worker');
const { enqueue } = require('../src/outbox/enqueue');
const { sweepDigests, DAILY_ONCE_AT } = require('../src/jobs/sweeps');
const flags = require('../src/domain/flags');

const TZ = 'Asia/Jerusalem';
const MORNING = new Date('2026-10-05T07:00:00Z');   // 10:00 local
const NOON = new Date('2026-10-05T09:00:00Z');      // 12:00 local
const EVENING = new Date('2026-10-05T17:00:00Z');   // 20:00 local
const AFTER = new Date('2026-10-05T17:01:00Z');
const SAAR = '+972500000955';
const OTHER = '+972500000956';

let db, saar, other;

before(async () => {
  db = await freshDb();
  saar = await makeUser(db.pool, SAAR, { firstName: 'Saar' });
  other = await makeUser(db.pool, OTHER, { firstName: 'Hod' });
  await db.pool.query(
    `UPDATE users SET timezone = $2, onboarded_at = now(), digest_times = NULL WHERE id = ANY($1)`,
    [[saar.id, other.id], TZ]
  );
  await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', SAAR));
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.pool.query('DELETE FROM outbox');
  await db.pool.query('DELETE FROM tasks');
});

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(`${r.user_id}:${r.kind}`); return { ok: true }; } };
}

const put = (userId, kind, extra = {}) => withTx(db.pool, (c) => enqueue(c, {
  userId, kind, payload: extra.payload || {}, urgency: extra.urgency,
  idempotencyKey: `${kind}:${userId}:${Math.random()}`,
}));

test('his day: nothing she decided to say goes out before 20:00, and then exactly one message carries it', async () => {
  assert.equal(DAILY_ONCE_AT, '20:00');
  // The shape of his week, one morning's worth: coordination news (urgent, as
  // every negotiation row is), another person's request, a check-in.
  await put(saar.id, 'meeting_invite', { urgency: 'urgent', payload: { title: 'פאדל' } });
  await put(saar.id, 'meeting_slot_proposed', { urgency: 'urgent', payload: { slot: 'שלישי 19:00' } });
  await put(saar.id, 'connection_request', { payload: { from: 'Dana' } });
  await put(saar.id, 'checkin', { payload: { topic: 'how_is_it_going' } });
  // The same invite to somebody NOT on the list goes out as it always did.
  await put(other.id, 'meeting_invite', { urgency: 'urgent', payload: { title: 'פאדל' } });

  const morning = recorder();
  await drainOnce(db.pool, morning.deliver, MORNING);
  assert.deepEqual(morning.sent, [`${other.id}:meeting_invite`]);

  const { rows: held } = await db.pool.query(
    `SELECT kind, hold_reason, release_after, sent_at FROM outbox WHERE user_id = $1 ORDER BY id`, [saar.id]);
  assert.deepEqual(held.map((r) => [r.kind, r.hold_reason]), [
    ['meeting_invite', 'daily_once'], ['meeting_slot_proposed', 'daily_once'],
    ['connection_request', 'daily_once'], ['checkin', 'daily_once'],
  ]);
  // Held with no clock: only the evening message picks them up. The check-in
  // is dropped outright — the evening message is that question answered.
  assert.ok(held.slice(0, 3).every((r) => r.release_after === null && r.sent_at === null));
  assert.ok(held[3].sent_at !== null, 'the check-in is terminal, not waiting');

  const noon = recorder();
  await drainOnce(db.pool, noon.deliver, NOON);
  assert.deepEqual(noon.sent, [], 'a held row is never retried on a clock');

  await withTx(db.pool, (c) => sweepDigests(c, EVENING));
  const { rows: digests } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.equal(digests.length, 1);
  assert.deepEqual(digests[0].payload.folded.map((f) => f.kind).sort(),
    ['connection_request', 'meeting_invite', 'meeting_slot_proposed']);

  const evening = recorder();
  await drainOnce(db.pool, evening.deliver, AFTER);
  assert.deepEqual(evening.sent, [`${saar.id}:digest`]);

  // The ±2 minute tolerance visits the slot again; that is not a second message.
  await withTx(db.pool, (c) => sweepDigests(c, AFTER));
  const { rows: [n] } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.equal(n.n, 1);
});

test('nothing open: no evening message at all', async () => {
  await withTx(db.pool, (c) => sweepDigests(c, EVENING));
  const { rows } = await db.pool.query(
    `SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.equal(rows.length, 0);
});

test('something open with nothing held still gets the evening message', async () => {
  await db.pool.query(`INSERT INTO tasks (owner_id, title, status) VALUES ($1, 'לחדש דרכון', 'open')`, [saar.id]);
  await withTx(db.pool, (c) => sweepDigests(c, EVENING));
  const { rows } = await db.pool.query(
    `SELECT 1 FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.equal(rows.length, 1);
});

test('a digest that reached him inside 20 hours is the day\'s message (Shabbat releases one at havdalah)', async () => {
  await db.pool.query(`INSERT INTO tasks (owner_id, title, status) VALUES ($1, 'לחדש דרכון', 'open')`, [saar.id]);
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, sent_at, created_at)
     VALUES ($1, 'digest', '{}', $2::timestamptz - interval '1 hour', $2::timestamptz - interval '25 hours')`,
    [saar.id, EVENING]);
  await withTx(db.pool, (c) => sweepDigests(c, EVENING));
  const { rows: [n] } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.equal(n.n, 1);
});

test('a reminder he asked for at an hour goes out at that hour; Olma\'s follow-up rung waits', async () => {
  await put(saar.id, 'reminder', { urgency: 'urgent', payload: { title: 'לקחת כדור', rung: 1, auto: false } });
  await put(saar.id, 'reminder', { urgency: 'urgent', payload: { title: 'לשלם חשבון', rung: 2, auto: false } });
  await put(saar.id, 'reminder', { urgency: 'urgent', payload: { title: 'פגישה', rung: 1, auto: true } });
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, MORNING);
  assert.deepEqual(rec.sent, [`${saar.id}:reminder`]);
  const { rows } = await db.pool.query(
    `SELECT payload->>'title' AS title, hold_reason FROM outbox
      WHERE user_id = $1 AND kind = 'reminder' AND hold_reason IS NOT NULL ORDER BY id`, [saar.id]);
  assert.deepEqual(rows.map((r) => [r.title, r.hold_reason]),
    [['לשלם חשבון', 'daily_once'], ['פגישה', 'daily_once']]);
});

test('a held row about a coordination that has already happened is not carried into the evening', async () => {
  await db.pool.query('DELETE FROM meetings');
  const { rows: [m] } = await db.pool.query(
    `INSERT INTO meetings (initiator_id, title, status, confirmed_start_at)
     VALUES ($1, 'פאדל', 'confirmed', $2::timestamptz - interval '2 hours') RETURNING id`,
    [other.id, EVENING]);
  await put(saar.id, 'meeting_confirmed', { urgency: 'urgent', payload: { meetingId: Number(m.id) } });
  await put(saar.id, 'connection_request', { payload: { from: 'Dana' } });
  await drainOnce(db.pool, recorder().deliver, MORNING);
  await withTx(db.pool, (c) => sweepDigests(c, EVENING));
  const { rows: [d] } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [saar.id]);
  assert.deepEqual(d.payload.folded.map((f) => f.kind), ['connection_request']);
  const { rows: [c] } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'meeting_confirmed'`, [saar.id]);
  assert.equal(c.hold_reason, 'meeting_over');
});
