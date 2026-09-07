'use strict';
// Miron's own ask, walking his onboarding (2026-09-04): if he goes quiet right
// after the opening message, don't make him wait for the day-one ladder's
// first rung — 15 minutes, an eternity next to how fast the silence itself
// was noticed. Ask about his name within a minute instead.
//
// Anchored on `first_turn_at` (set once, only where turn_start actually hands
// the model the opening copy — see registry.js) rather than `onboarded_at`
// (set at provisioning, which can be well before anyone has written a word).
// The silence test is `last_inbound_at = first_turn_at`: both are stamped by
// the SAME transaction in turn_start, so they can only still be equal if no
// later message has moved `last_inbound_at` on its own.
//
// **What that sentence leaves out, and what this file did not test until
// 2026-09-07: the opening is a REPLY.** `first_turn_at` is stamped during the
// turn their own first message opened, so the state above is reached BY their
// writing, not by their silence — the rung fires at someone who wrote once and
// stopped, and can never fire at someone who never wrote at all. Measured on
// production: 4 of 4 people who ever reached a first turn got this rung, each
// of them having written first.
//
// That is the right moment for a nudge and the wrong thing to say at it. The
// old wording asserted "They have not replied since your opening message" and
// sourced the guess to "their WhatsApp profile"; עידן's name came from Miron's
// Google contacts, and his single message was "קוראים לי עידן" — so Olma asked
// him to confirm the name he had just typed, ninety seconds after he typed it.
// The instruction tests below are about that: a sweep may say what is in its
// columns, and must send the model to the transcript for the rest.
//
// `openedAgo` writes the state by hand, and that is exactly how the flaw
// survived: a fixture that encodes "they never replied" cannot notice that
// production only ever reaches this row the other way. The founding case is
// therefore tested upstream too, in tests/first-turn.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const sweeps = require('../src/jobs/sweeps');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Leaves the row exactly the shape turn_start leaves behind `seconds` after
// the opening: first_turn_at and last_inbound_at equal (nobody has replied
// since), the name column set to whatever guess (or none) the test wants.
async function openedAgo(pool, userId, seconds, { name = null, confirmed = false } = {}) {
  await pool.query(
    `UPDATE users SET
        first_turn_at = now() - ($2 || ' seconds')::interval,
        last_inbound_at = now() - ($2 || ' seconds')::interval,
        first_name = $3, name_confirmed = $4
      WHERE id = $1`,
    [userId, String(seconds), name, confirmed]);
}

const outboxFor = (pool, userId) => pool.query(
  `SELECT payload, hold_reason, expires_at FROM outbox
    WHERE user_id = $1 AND kind = 'checkin' AND payload->>'rung' = 'name_confirm_1m'`,
  [userId]);

test('fires past 60s, carrying the unconfirmed name and no story about it', async () => {
  const u = await makeUser(db.pool, '+972611005001', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'M&M' });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, [u.id]);
  const { rows } = await outboxFor(db.pool, u.id);
  assert.equal(rows.length, 1);
  const said = rows[0].payload.checkinInstruction;
  assert.match(said, /"M&M"/);
  assert.match(said, /is right/i, 'it still has to ask whether the name is right');
});

test('it does not tell the model where the name came from', async () => {
  // The sweep reads `users.first_name` and has no idea whether that is a
  // WhatsApp profile name, a name seen in passing, or — as it was for עידן —
  // a row prefilled from somebody else's Google contacts
  // (`user.name_prefilled_from_contacts`). Asserting one of the three to a
  // model that will happily repeat it out loud is how Olma tells a person
  // something untrue about their own data.
  const u = await makeUser(db.pool, '+972611005009', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'עידן' });
  await sweeps.sweepNameConfirm(db.pool);
  const said = (await outboxFor(db.pool, u.id)).rows[0].payload.checkinInstruction;
  assert.doesNotMatch(said, /most likely from their WhatsApp profile/i,
    'the sweep cannot know this and must not say it');
  assert.match(said, /does not know which/i,
    'saying the provenance is unknown is the honest version, and short');
});

test('it sends the model to their message before it asks anything', async () => {
  // The founding case, from the rung's side. עידן's one message was
  // "קוראים לי עידן"; the rung fired 79 seconds later and the old wording
  // gave the model no reason to look at it, so he was asked to confirm a
  // name he had just typed. Nothing here can read his words — the fix is to
  // say so and hand the job over.
  const u = await makeUser(db.pool, '+972611005010', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'עידן' });
  await sweeps.sweepNameConfirm(db.pool);
  const said = (await outboxFor(db.pool, u.id)).rows[0].payload.checkinInstruction;
  assert.match(said, /read what they actually wrote/i);
  assert.match(said, /set_my_name/,
    'and name the tool, so "already said it" has somewhere to go');
  assert.match(said, /never ask them to confirm a name they just gave/i);
});

test('the no-name branch says the same thing, without a name to check', async () => {
  const u = await makeUser(db.pool, '+972611005011', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: null });
  await sweeps.sweepNameConfirm(db.pool);
  const said = (await outboxFor(db.pool, u.id)).rows[0].payload.checkinInstruction;
  assert.match(said, /set_my_name instead of asking/i);
  assert.doesNotMatch(said, /is right/i, 'there is no name on file to check');
});

test('fires with a plain ask when there is no name guess at all', async () => {
  const u = await makeUser(db.pool, '+972611005002', { firstName: null });
  // makeUser sets firstName 'Test' unless told otherwise; clear it here to
  // model someone whose WhatsApp profile gave us nothing.
  await openedAgo(db.pool, u.id, 75, { name: null });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, [u.id]);
  const { rows } = await outboxFor(db.pool, u.id);
  assert.match(rows[0].payload.checkinInstruction, /what you should call them/i);
  assert.doesNotMatch(rows[0].payload.checkinInstruction, /is that their name/i);
});

test('does not fire before 60 seconds', async () => {
  const u = await makeUser(db.pool, '+972611005003', { firstName: null });
  await openedAgo(db.pool, u.id, 30, { name: 'Guest' });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('expires past 10 minutes — a sweep that was down does not surface a late nudge', async () => {
  const u = await makeUser(db.pool, '+972611005004', { firstName: null });
  await openedAgo(db.pool, u.id, 700, { name: 'Guest' }); // 11m40s
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a reply since the opening cancels the nudge, whatever it said', async () => {
  const u = await makeUser(db.pool, '+972611005005', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  // They wrote back — last_inbound_at moves forward, first_turn_at does not.
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a name already confirmed does not get re-asked', async () => {
  const u = await makeUser(db.pool, '+972611005006', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'מירון', confirmed: true });
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('a paused user is not nudged', async () => {
  const u = await makeUser(db.pool, '+972611005007', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);
  const fired = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(fired, []);
});

test('idempotent — a second tick within the window does not double-enqueue', async () => {
  const u = await makeUser(db.pool, '+972611005008', { firstName: null });
  await openedAgo(db.pool, u.id, 90, { name: 'Guest' });
  await sweeps.sweepNameConfirm(db.pool);
  const second = await sweeps.sweepNameConfirm(db.pool);
  assert.deepEqual(second, [], 'the idempotency key already claimed this rung');
  const { rows } = await outboxFor(db.pool, u.id);
  assert.equal(rows.length, 1);
});
