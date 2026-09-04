'use strict';
// A turn Olma started is not a message from the person (2026-09-04).
//
// Found by walking a cold start on a real account: the welcome arrived
// unprompted, fifteen minutes after joining and before the person had written
// a word — and their actual first message got an ordinary greeting. The
// day-one check-in ran as a `--deliver` agent turn, that turn called
// `turn_start` like any other, and `turn_start` had no way to tell it from
// somebody typing. So it wrote the whole inbound record for a message nobody
// sent, and the once-in-a-lifetime first-turn signal was spent on it.
//
// The visible symptom was the onboarding. The quiet ones were worse: see
// domain/self-initiated.js for the check-in backoff that could never back off
// and the response-rate metric that counted our own messages as replies.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const turnDomain = require('../src/domain/turn');
const flagsDomain = require('../src/domain/flags');
const selfInitiated = require('../src/domain/self-initiated');

let db, broker;
before(async () => { db = await freshDb(); broker = createBrokerServer({ pool: db.pool }); });
after(async () => { await db.teardown(); });
beforeEach(() => selfInitiated._reset());

async function turnStart(user, turn = { opened: false, counted: false }) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    turn);
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

const stateOf = async (id) => (await db.pool.query(
  `SELECT last_inbound_at, checkin_misses FROM users WHERE id = $1`, [id])).rows[0];

const receivedCount = async (id) => (await db.pool.query(
  `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'message.received'`,
  [id])).rows[0].n;

test('a delivery turn writes no inbound record at all', async () => {
  const u = await makeUser(db.pool, '+972611004001', { firstName: 'Dalia' });
  await db.pool.query(
    `UPDATE users SET checkin_misses = 3, last_inbound_at = now() - interval '2 days' WHERE id = $1`,
    [u.id]);
  const before = await stateOf(u.id);

  await selfInitiated.around(u.id, () => turnStart(u));

  const after = await stateOf(u.id);
  assert.deepEqual(after.last_inbound_at, before.last_inbound_at,
    'our own check-in is not evidence that they wrote back');
  assert.equal(after.checkin_misses, 3,
    'and it must not reset the backoff it is itself the third attempt of');
  assert.equal(await receivedCount(u.id), 0,
    'message.received is the response-rate numerator — our own send is not a reply');
});

test('the day-one check-in no longer spends somebody\'s welcome', async () => {
  // The exact live sequence: joined, said nothing, the 15m onboarding rung
  // delivered, and only afterwards did they write for the first time.
  const u = await makeUser(db.pool, '+972611004002', { firstName: null, locale: 'he' });

  const checkin = await selfInitiated.around(u.id, () => turnStart(u));
  assert.equal(checkin.firstTurn, undefined, 'nobody wrote — there is no first turn here');
  assert.equal(checkin.onboarding, undefined, 'so the opening copy is not handed out');
  assert.equal((await stateOf(u.id)).last_inbound_at, null, 'and the evidence is untouched');

  const theirs = await turnStart(u);
  assert.equal(theirs.firstTurn, true, 'their real first message still gets it');
  assert.ok(theirs.onboarding.sendVerbatim.startsWith('היי, אני עולמה'),
    'with the opening copy, in the right order, for once');
});

test('a delivery turn cannot be blocked by the person\'s own quota', async () => {
  // The gate already decided this message goes out. Re-asking the user's daily
  // allowance here would let someone at their cap silence the check-in we
  // chose to send them.
  const u = await makeUser(db.pool, '+972611004003', { firstName: 'Gvul' });
  await db.pool.query(`UPDATE users SET quota_override_daily = 1 WHERE id = $1`, [u.id]);

  await turnStart(u);                                  // 1 of 1
  const overCap = await turnStart(u);                  // 2 of 1 — really blocked
  assert.notEqual(overCap.directive, 'proceed',
    'guard: without this the test below would pass for the wrong reason');

  const ours = await selfInitiated.around(u.id, () => turnStart(u));
  assert.equal(ours.directive, 'proceed', 'our own turn proceeds regardless');
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'quota.blocked'`, [u.id]);
  assert.equal(rows[0].n, 1, 'and it did not spend another of their messages to find out');
});

test('the recovery path is guarded through the other door too', async () => {
  // brokerd opens the turn when the model reaches for a tool before
  // turn_start. On a delivery turn that path would write the same inbound
  // record turn_start no longer writes.
  const u = await makeUser(db.pool, '+972611004004', { firstName: null });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, 'all'));

  const turn = { opened: false, counted: false };
  await selfInitiated.around(u.id, () => broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'list_my_tasks', args: { olma_identity: u.identity_token } } },
    turn));

  assert.equal(turn.counted, false, 'nothing was counted');
  assert.equal(turn.firstTurn, false, 'and no first-turn verdict was captured');
  assert.equal((await stateOf(u.id)).last_inbound_at, null, 'the row never moved');
  assert.equal(await receivedCount(u.id), 0);

  const theirs = await turnStart(u);
  assert.equal(theirs.firstTurn, true, 'so their own first message still finds it waiting');
});

test('the mark is released even when the turn throws', async () => {
  // A leaked mark makes every later message from that person invisible to the
  // record — a worse bug than the one this fixes, and the reason callers go
  // through around() instead of begin/end.
  const u = await makeUser(db.pool, '+972611004005', { firstName: 'Nefel' });
  await assert.rejects(selfInitiated.around(u.id, async () => { throw new Error('boom'); }));
  assert.equal(selfInitiated.isActive(u.id), false);

  await turnStart(u);
  assert.notEqual((await stateOf(u.id)).last_inbound_at, null,
    'and the next real message is recorded normally');
});

test('overlapping deliveries do not clear each other\'s mark', async () => {
  const u = await makeUser(db.pool, '+972611004006', { firstName: 'Kaful' });
  let inner = null;
  await selfInitiated.around(u.id, async () => {
    await selfInitiated.around(u.id, async () => {});
    inner = selfInitiated.isActive(u.id);   // the outer one is still running
  });
  assert.equal(inner, true, 'the first to finish must not unmark the second');
  assert.equal(selfInitiated.isActive(u.id), false, 'and the last one does');
});

test('an ordinary message is untouched by any of this', async () => {
  const u = await makeUser(db.pool, '+972611004007', { firstName: 'Ragil' });
  await db.pool.query(`UPDATE users SET checkin_misses = 2 WHERE id = $1`, [u.id]);
  await turnStart(u);
  const s = await stateOf(u.id);
  assert.notEqual(s.last_inbound_at, null);
  assert.equal(s.checkin_misses, 0, 'real activity still resets the backoff');
  assert.equal(await receivedCount(u.id), 1);
});
