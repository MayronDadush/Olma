'use strict';
// "Nobody is asked a question they have already not answered once" was enforced
// in the check-in ladder and nowhere else, so the morning digest kept asking.
//
// The founding case is Sarah (u-17), replayed here in shape: she was asked
// "did the brunch and the moving happen?" on the mornings of 2 September,
// 4 September, 5 September and 6 September, and answered none of them. Nothing
// was malfunctioning — each morning the model was told to end on "one question
// that fills a real gap", found the same real gap, and asked again. Silence to
// yesterday's digest is the answer to today's question.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { sweepDigests } = require('../src/jobs/sweeps');
const { instructionFor } = require('../src/channels/openclaw');

let db, user;

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000913', { firstName: 'Sarah' });
  await db.pool.query(
    `UPDATE users SET digest_times = '09:00', digest_scope = 'summary',
       timezone = 'Asia/Jerusalem', onboarded_at = now() WHERE id = $1`,
    [user.id]
  );
});
after(async () => { await db.teardown(); });

// Pinned instants, never "now": Israel is UTC+3 through September, and a test
// that reads the clock is green for thirteen hours a day.
const MORNING = (day) => new Date(`2026-09-${day}T06:00:30Z`);

// Days accumulate rather than being cleared between them — the whole question
// is what the sweep makes of the mornings BEFORE this one, so deleting them
// would delete the test.
async function digestOn(day) {
  const out = await sweepDigests(db.pool, MORNING(day));
  assert.equal(out.length, 1, `digest should have fired on the ${day}th`);
  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE idempotency_key = $1`,
    [`digest:${user.id}:2026-09-${day}:09:00`]);
  assert.equal(rows.length, 1);
  return rows[0].payload;
}

// A digest that was really delivered. Written straight rather than through the
// worker: what this file is about is the sweep's reading of history, and the
// worker has its own tests.
async function markDelivered(day) {
  await db.pool.query(
    `UPDATE outbox SET sent_at = $2, hold_reason = NULL WHERE idempotency_key = $1`,
    [`digest:${user.id}:2026-09-${day}:09:00`, `2026-09-${day}T06:00:31Z`]);
}

async function wrote(day, hour) {
  await db.pool.query(`UPDATE users SET last_inbound_at = $2 WHERE id = $1`,
    [user.id, `2026-09-${day}T${hour}:00:00Z`]);
}

test('the first digest may ask — there is no silence to read yet', async () => {
  const p = await digestOn('15');
  assert.equal(p.mayAsk, true);
  assert.match(instructionFor({ kind: 'digest', payload: p }), /one question that fills a real gap/);
});

test('a morning after a digest they did not answer carries no question at all', async () => {
  await markDelivered('15');
  const p = await digestOn('16');
  assert.equal(p.mayAsk, false, 'they did not write between the two digests');
  const text = instructionFor({ kind: 'digest', payload: p });
  assert.match(text, /Do NOT ask them anything at all/);
  assert.doesNotMatch(text, /one question that fills a real gap/);
});

test('writing back re-opens the question — this is a backoff, not a mute', async () => {
  await markDelivered('16');
  await wrote('16', '11');
  const p = await digestOn('17');
  assert.equal(p.mayAsk, true);
  assert.match(instructionFor({ kind: 'digest', payload: p }), /one question that fills a real gap/);
});

// A cancelled or expired row carries sent_at too — that is how cancelling stops
// its producer re-creating it — and counting one as a digest the person ignored
// would silence the next morning over a message they never saw.
test('a digest that was cancelled rather than delivered is not silence', async () => {
  await markDelivered('17');
  await wrote('17', '11');
  await digestOn('18');
  await db.pool.query(
    `UPDATE outbox SET sent_at = '2026-09-18T06:00:31Z', hold_reason = 'cancelled_by_admin'
      WHERE idempotency_key = $1`, [`digest:${user.id}:2026-09-18:09:00`]);
  const p = await digestOn('19');
  assert.equal(p.mayAsk, true, 'nothing reached her on the 18th, so nothing was ignored');
});

// The ending is chosen by the ROW, so a digest already queued when this shipped
// keeps the wording it was enqueued with — same rule as cardMinItems.
test('a row enqueued before this existed keeps its old ending', () => {
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary' } });
  assert.match(text, /one question that fills a real gap/);
});
