'use strict';
// The morning digest goes out as a drawn card once it is long enough to be a
// wall of text. Two things had to be true for that to ever happen and only one
// of them was: the threshold, and the agent actually HAVING the items —
// `summary` scope returns counts only, so an agent told to draw had nothing to
// draw. Both are pinned here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { sweepDigests } = require('../src/jobs/sweeps');
const { instructionFor } = require('../src/channels/openclaw');
const flags = require('../src/domain/flags');

let db, user;

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000901', { firstName: 'Sarah' });
  await db.pool.query(
    `UPDATE users SET digest_times = '09:00', digest_scope = 'summary',
       timezone = 'Asia/Jerusalem', onboarded_at = now() WHERE id = $1`,
    [user.id]
  );
});
after(async () => { await db.teardown(); });

// The moment sweepDigests fires for this user: 09:00 Israel time, expressed as
// the UTC instant the sweep is handed. Pinned rather than derived from "now"
// so the test does not depend on the hour the suite runs (the "green thirteen
// hours a day" failure).
function nineAmIsrael() {
  // 2026-09-15 is outside the DST switch weeks; Israel is UTC+3 in September.
  return new Date('2026-09-15T06:00:30Z');
}

async function sweepOnce() {
  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1`, [user.id]);
  const out = await sweepDigests(db.pool, nineAmIsrael());
  assert.equal(out.length, 1, 'digest should have fired');
  const { rows } = await db.pool.query(
    `SELECT kind, payload FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [user.id]
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

test('the sweep stamps the flag into the row, so the row decides its own morning', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  const row = await sweepOnce();
  assert.equal(row.payload.cardMinItems, 3);
});

test('an operator raising the flag reaches the very next digest', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 8);
  const row = await sweepOnce();
  assert.equal(row.payload.cardMinItems, 8);
  const text = instructionFor(row);
  assert.match(text, /8 or more open items/);
});

test('the card clause orders the ITEMS fetched, not just the card drawn', async () => {
  // The whole bug: scope=summary returns counts only. An instruction that says
  // "draw a card" without this is unfollowable, and the agent falls back to
  // text every time — which is exactly what production did.
  const row = { kind: 'digest', payload: { scope: 'summary', cardMinItems: 3 } };
  const text = instructionFor(row);
  assert.match(text, /list_my_tasks/);
  assert.match(text, /scope="full"/);
  assert.match(text, /render_schedule_card/);
  assert.match(text, /MEDIA: <path>/);
});

test('under the threshold the instruction still prefers a sentence', async () => {
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary', cardMinItems: 3 } });
  assert.match(text, /Under 3 items, a warm sentence/);
});

test('0 turns cards off completely — no card clause at all', async () => {
  const text = instructionFor({ kind: 'digest', payload: { scope: 'full', cardMinItems: 0 } });
  assert.doesNotMatch(text, /render_schedule_card/);
  assert.doesNotMatch(text, /MEDIA: <path>/);
  // and the digest itself still goes out
  assert.match(text, /get_my_digest/);
});

test('a row enqueued before the flag existed still gets a threshold', async () => {
  // In-flight rows carry no cardMinItems. They must not silently lose the
  // feature, and must not be re-interpreted as 0 (which would read as "off").
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary' } });
  assert.match(text, /3 or more open items/);
});

test('a corrupt flag value falls back rather than disabling the card', async () => {
  // Same rule as background_llm failing open: a typo in a dashboard box must
  // not quietly turn a daily feature off with nothing said.
  const text = instructionFor({ kind: 'digest', payload: { cardMinItems: 'שלוש' } });
  assert.match(text, /3 or more open items/);
});

test('the delivery preamble still rides along', async () => {
  const text = instructionFor({ kind: 'digest', payload: { cardMinItems: 3 } });
  assert.match(text, /render_schedule_card/);
  assert.ok(text.length > 200, 'preamble should still be attached');
});

test('#115\'s "someone owes you an answer" line survives this branch', async () => {
  // Merge guard, not a feature test. #115 added that sentence to the SAME
  // template literal this branch rewrites, and it ships with no test of its
  // own — so a future conflict resolution could drop it and every suite would
  // stay green. It is pinned here because this branch is what put it at risk.
  //
  // Kept for the same reason it was written: being owed an answer is news, and
  // it is independent of whether the digest goes out as text or as a card.
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary', cardMinItems: 3 } });
  assert.match(text, /crossUser\.awaitingOthers/);
  // ...and it must come BEFORE the card clause: the card is about how the
  // digest is rendered, this is about what the digest has to say.
  assert.ok(
    text.indexOf('crossUser.awaitingOthers') < text.indexOf('render_schedule_card'),
    'the awaiting-others line belongs with the content, not after the rendering instruction'
  );
});
