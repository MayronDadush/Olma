'use strict';
// The structural fix for a model that skips `turn_start` (2026-08-30).
//
// What is under test is an INVARIANT, not a tool: after the first tool call of
// a turn, that turn is opened — the message counted, the person marked awake —
// no matter which tool the model reached for. Two DeepSeek models and two
// rounds of rewording failed to make the model open the turn itself, so the
// server does it (domain/turn.js, wired in brokerd/server.js).
//
// A turn is one brokerd connection, because the gateway spawns one MCP shim
// per turn and the shim holds one socket. `dispatch(msg, turn)` takes that
// object explicitly, so these tests drive the real dispatch path with a shared
// `turn` exactly as a real connection would.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const turnDomain = require('../src/domain/turn');
const flagsDomain = require('../src/domain/flags');

let db, broker;
before(async () => { db = await freshDb(); broker = createBrokerServer({ pool: db.pool }); });
after(async () => { await db.teardown(); });

const newTurn = () => ({ opened: false, counted: false });

// One tool call on a given turn, through the real dispatch path.
function call(user, name, args = {}, turn) {
  return broker.dispatch(
    { id: 1, method: 'tool_call', params: { name, args: { identity_token: user.identity_token, ...args } } },
    turn
  );
}

const setFlag = (v) => withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, v));

async function counts(userId) {
  const { rows } = await db.pool.query(
    `SELECT
       (SELECT coalesce(sum(count), 0)::int FROM quota_counters WHERE user_id = $1) AS quota,
       (SELECT count(*)::int FROM audit_log WHERE actor_id = $1 AND event = 'message.received') AS received,
       (SELECT count(*)::int FROM audit_log WHERE actor_id = $1 AND event = 'turn.opened_implicitly') AS recovered,
       (SELECT last_inbound_at IS NOT NULL FROM users WHERE id = $1) AS awake`,
    [userId]);
  return rows[0];
}

test('coveredBy: off by default, "all", and an explicit list', () => {
  assert.equal(turnDomain.coveredBy(null, '+972500000001'), false, 'absent flag is OFF');
  assert.equal(turnDomain.coveredBy('', '+972500000001'), false);
  assert.equal(turnDomain.coveredBy('   ', '+972500000001'), false, 'whitespace is not a rollout');
  assert.equal(turnDomain.coveredBy('all', '+972500000001'), true);
  assert.equal(turnDomain.coveredBy('+972500000001', '+972500000001'), true);
  assert.equal(turnDomain.coveredBy(' +972500000001 , +972500000002 ', '+972500000002'), true, 'spaces tolerated');
  assert.equal(turnDomain.coveredBy('+972500000009', '+972500000001'), false, 'someone else’s rollout is not yours');
});

// The rollout gate is the whole reason this can ship before it is trusted:
// with the flag unset, a turn that skips turn_start behaves exactly as it did
// yesterday — wrongly, but unchanged.
test('flag off: skipping turn_start is left exactly as broken as before', async () => {
  const u = await makeUser(db.pool, '+972573000001', { firstName: 'לפני' });
  await setFlag('');
  await call(u, 'list_my_tasks', {}, newTurn());
  const c = await counts(u.id);
  assert.equal(c.quota, 0, 'nothing counted');
  assert.equal(c.recovered, 0, 'no recovery ran');
  assert.equal(c.awake, false);
});

test('flag on for this phone: a turn opening with another tool is repaired', async () => {
  const u = await makeUser(db.pool, '+972573000002', { firstName: 'מירון' });
  await setFlag(u.phone);
  const res = await call(u, 'list_my_tasks', {}, newTurn());
  assert.equal(res.ok, true, 'the tool the model actually wanted still runs');

  const c = await counts(u.id);
  assert.equal(c.quota, 1, 'the message is counted exactly once');
  assert.equal(c.received, 1, 'the north-star numerator gets its one row');
  assert.equal(c.awake, true, 'the delivery gate can see they are awake');
  assert.equal(c.recovered, 1, 'the skip is recorded, not silently compensated for');

  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'turn.opened_implicitly'`, [u.id]);
  assert.equal(rows[0].detail.firstTool, 'list_my_tasks',
    'which tool the model reached for instead is the diagnostic');
});

test('a rollout list covers only the phones on it', async () => {
  const mine = await makeUser(db.pool, '+972573000003', { firstName: 'ברשימה' });
  const theirs = await makeUser(db.pool, '+972573000004', { firstName: 'לא ברשימה' });
  await setFlag(mine.phone);
  await call(mine, 'list_my_tasks', {}, newTurn());
  await call(theirs, 'list_my_tasks', {}, newTurn());
  assert.equal((await counts(mine.id)).recovered, 1);
  assert.equal((await counts(theirs.id)).recovered, 0, 'phase 1 must not reach everyone');

  await setFlag('all');
  await call(theirs, 'list_my_tasks', {}, newTurn());
  assert.equal((await counts(theirs.id)).recovered, 1, 'phase 2 does');
});

// The healthy path must stay untouched: turn_start opens the turn itself, so
// no recovery, no extra audit row, and above all no second count.
test('turn_start first: no recovery, and the message is still counted once', async () => {
  const u = await makeUser(db.pool, '+972573000005', { firstName: 'תקין' });
  await setFlag('all');
  const turn = newTurn();
  await call(u, 'turn_start', {}, turn);
  await call(u, 'list_my_tasks', {}, turn);
  const c = await counts(u.id);
  assert.equal(c.quota, 1);
  assert.equal(c.received, 1);
  assert.equal(c.recovered, 0, 'nothing was skipped, so nothing is reported as skipped');
});

// The trap this design has to survive: the model opens with another tool
// (recovery counts the message) and THEN calls turn_start in the same turn.
// Counting there too would charge one message twice and double the
// response-rate denominator.
test('recovery then turn_start in one turn counts the message exactly once', async () => {
  const u = await makeUser(db.pool, '+972573000006', { firstName: 'כפול' });
  await setFlag('all');
  const turn = newTurn();
  await call(u, 'list_my_tasks', {}, turn);
  const after1 = await counts(u.id);
  assert.equal(after1.quota, 1);

  const res = await call(u, 'turn_start', {}, turn);
  assert.equal(res.ok, true);
  assert.match(res.text, /proceed/, 'turn_start still answers with a directive');

  const after2 = await counts(u.id);
  assert.equal(after2.quota, 1, 'one message, one count');
  assert.equal(after2.received, 1, 'one message, one message.received row');
});

// A separate connection is a separate turn, and each one is counted. This is
// what keeps the quota honest for a person sending several messages.
test('each turn is counted, because each connection is its own turn', async () => {
  const u = await makeUser(db.pool, '+972573000007', { firstName: 'שלוש' });
  await setFlag('all');
  for (let i = 0; i < 3; i++) await call(u, 'list_my_tasks', {}, newTurn());
  assert.equal((await counts(u.id)).quota, 3);
});

// Both of these guard an assumption rather than a behaviour: "one connection
// is one turn" is true of the gateway today, and bin/olma-mcp.js already
// refuses to bet on it staying true. If it ever stops being true, these are
// what keep the failure at "no recovery" instead of "someone's message went
// uncounted".
test('a connection that serves a second user starts a fresh turn', async () => {
  const a = await makeUser(db.pool, '+972573000020', { firstName: 'א' });
  const b = await makeUser(db.pool, '+972573000021', { firstName: 'ב' });
  await setFlag('all');
  const shared = newTurn();
  await call(a, 'list_my_tasks', {}, shared);
  await call(b, 'list_my_tasks', {}, shared);
  assert.equal((await counts(a.id)).recovered, 1);
  assert.equal((await counts(b.id)).recovered, 1, 'B’s turn is not swallowed by A’s');
  assert.equal((await counts(b.id)).quota, 1, 'and B’s message is still counted');
});

test('a connection outliving its turn cannot suppress the next turn_start', async () => {
  const u = await makeUser(db.pool, '+972573000022', { firstName: 'שורד' });
  await setFlag('all');
  const shared = newTurn();
  await call(u, 'list_my_tasks', {}, shared);   // turn 1: recovered + counted
  await call(u, 'turn_start', {}, shared);      // ...consumes that count
  await call(u, 'turn_start', {}, shared);      // turn 2 on the same object
  const c = await counts(u.id);
  assert.equal(c.quota, 2, 'the second turn_start counts its own message');
  assert.equal(c.received, 2);
});

// The sharpest line in domain/turn.js: recovery repairs STATE and never
// consumes ADVICE. offerResume fires once per pause; stamping it from the
// recovery path would burn it on a turn where the model never saw it, leaving
// the person waiting for an offer the database believes was delivered.
test('recovery never burns the once-per-pause resume offer', async () => {
  const u = await makeUser(db.pool, '+972573000008', { firstName: 'מושהה' });
  await setFlag('all');
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [u.id]);

  // A turn that skips turn_start entirely: repaired, but the offer is intact.
  await call(u, 'list_my_tasks', {}, newTurn());
  const { rows: after } = await db.pool.query(
    `SELECT resume_offer_sent_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(after[0].resume_offer_sent_at, null,
    'an offer the model never saw must not be marked as made');

  // ...so the next turn that DOES call turn_start still gets to make it.
  const res = await call(u, 'turn_start', {}, newTurn());
  assert.match(res.text, /offerResume/, 'the offer survived to be delivered');
});
