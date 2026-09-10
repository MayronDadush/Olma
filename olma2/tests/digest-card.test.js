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

// ── One reader per threshold ────────────────────────────────────────────────
// Until 2026-09-10 the flag had two readers: the sweep stamped it onto the row
// and the delivery instruction quoted the number, while get_my_digest handed
// back a block with an unconditional "put this in your reply" attached. On the
// card path — the one the instruction itself orders, scope="full" — a turn
// therefore held BOTH a block to send and an order to draw, and Miron read his
// evening at 18:01 and again at 18:02. The instruction now names no number and
// only relays what the tool handed over; the tool decides.

test('the sweep no longer stamps a threshold onto the row', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  const row = await sweepOnce();
  assert.equal(row.payload.cardMinItems, undefined,
    'a stamped threshold is a second reader of one number, which is the bug');
});

test('the instruction names no threshold of its own, whatever the flag says', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 8);
  const row = await sweepOnce();
  const text = instructionFor(row);
  assert.doesNotMatch(text, /\d+ or more open items/);
  assert.doesNotMatch(text, /Under \d+ items/);
});

test('the instruction orders the ITEMS fetched and relays whichever half came back', async () => {
  // scope=summary returns counts only, so an agent told to draw off it has
  // nothing to put on the card — the tool is still named by scope.
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary' } });
  assert.match(text, /scope="full"/);
  assert.match(text, /get_my_digest/);
  assert.match(text, /render_schedule_card/);
  assert.match(text, /MEDIA: <path>/);
  // The two are alternatives handed over by the tool, never a judgement the
  // instruction asks the model to make against a number it also quotes.
  assert.match(text, /decided by get_my_digest itself, never by you/);
  assert.match(text, /Exactly one of the two comes back/);
  assert.match(text, /the same morning twice/);
});

test('the delivery instruction speaks of the block conditionally, never as a given', async () => {
  // The same rule as `markPlaced`: nothing that arrives beside a conditional
  // instruction may itself be an unconditional order to write. "The result
  // carries `block`" was exactly that, and on the card path it was false.
  const text = instructionFor({ kind: 'digest', payload: { scope: 'full' } });
  assert.match(text, /When the result carries `block`/);
  assert.doesNotMatch(text, /The result carries `block`:/);
});

// ── What the tool hands over: one of the two, never both ────────────────────

async function digestFor(scope) {
  const { BY_NAME } = require('../src/adapters/mcp/registry');
  const def = BY_NAME.get('get_my_digest');
  const client = await db.pool.connect();
  try {
    const fresh = (await client.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];
    const res = await def.handler(client, fresh, { scope });
    assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
    return res.data;
  } finally { client.release(); }
}

async function giveTasks(n) {
  const tasksDomain = require('../src/domain/tasks');
  const client = await db.pool.connect();
  try {
    await client.query(`DELETE FROM tasks WHERE owner_id = $1`, [user.id]);
    for (let i = 0; i < n; i++) {
      const res = await tasksDomain.addTask(client, user.id, { title: `משימה ${i + 1}` });
      assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
    }
  } finally { client.release(); }
}

test('a long list comes back as an order to DRAW, with no block beside it', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  await giveTasks(4);
  const data = await digestFor('full');
  assert.equal(data.block, undefined, 'a card turn must not also be handed a block to send');
  assert.match(data.hints.card, /render_schedule_card/);
  assert.match(data.hints.card, /MEDIA: <path>/);
  assert.equal(data.hints.block, undefined);
});

test('a short list comes back as a block, and says not to draw one', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  await giveTasks(2);
  const data = await digestFor('full');
  assert.ok(data.block, 'a short morning is the block');
  assert.match(data.hints.block, /EXACTLY as it is/);
  assert.match(data.hints.card, /do NOT draw a card/);
});

test('0 turns cards off: every list comes back as a block', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 0);
  await giveTasks(9);
  const data = await digestFor('full');
  assert.ok(data.block);
  assert.doesNotMatch(data.hints.card || '', /render_schedule_card/);
});

test('a corrupt flag value falls back rather than disabling the card', async () => {
  // Same rule as background_llm failing open: a typo in a dashboard box must
  // not quietly turn a daily feature off with nothing said. Three is the
  // fallback, so four items still draw.
  await flags.setFlag(db.pool, 'digest_card_min_items', 'שלוש');
  await giveTasks(4);
  const data = await digestFor('full');
  assert.equal(data.block, undefined);
  assert.match(data.hints.card, /render_schedule_card/);
});

test('summary scope has neither: counts are what that person asked for', async () => {
  await flags.setFlag(db.pool, 'digest_card_min_items', 3);
  await giveTasks(9);
  const data = await digestFor('summary');
  assert.equal(data.block, undefined);
  assert.equal(data.hints && data.hints.card, undefined);
  assert.ok(data.counts.openTasks >= 9);
});

test('the delivery preamble still rides along', async () => {
  const text = instructionFor({ kind: 'digest', payload: { scope: 'full' } });
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
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary' } });
  assert.match(text, /crossUser\.awaitingOthers/);
  // ...and it must come BEFORE the card clause: the card is about how the
  // digest is rendered, this is about what the digest has to say.
  assert.ok(
    text.indexOf('crossUser.awaitingOthers') < text.indexOf('render_schedule_card'),
    'the awaiting-others line belongs with the content, not after the rendering instruction'
  );
});

// 2026-09-03: user 8's digest listed her day correctly and then closed with
// "(זו שתי השורות האחרונות ברשימה שלך, ותו לא — יום פנוי עד הערב)". A morning
// message that ends in a line saying nothing is a morning message she learns
// to skip. Pinned in the same literal as the awaiting-others line above, and
// for the same reason: it ships with no behaviour of its own to go red.
test('the digest is told how to END, and the fallback is to stop rather than pad', async () => {
  const text = instructionFor({ kind: 'digest', payload: { scope: 'summary' } });
  assert.match(text, /End on ONE thing that moves the day/);
  assert.match(text, /never both, never a list/);
  // The fallback is deliberately silence, not a question. A question every
  // single morning is the drum the doctrine forbids everywhere else — it
  // would be worse than the filler it replaced.
  assert.match(text, /end on the list itself and stop/);
  // Content before rendering, same ordering rule as the line above it.
  assert.ok(text.indexOf('End on ONE thing') < text.indexOf('render_schedule_card'),
    'how to end the digest is about what it says, not about how it is drawn');
});
