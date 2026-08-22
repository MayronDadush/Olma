'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const repair = require('../src/domain/repair');
const sessions = require('../src/channels/sessions');
const facts = require('../src/domain/facts');
const { decide } = require('../src/outbox/gate');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

test('a number is matched however the operator happens to have it written', async () => {
  const u = await makeUser(db.pool, '+972505404255', { firstName: 'חיים' });
  await withTx(db.pool, async (c) => {
    for (const form of ['0505404255', '050-540-4255', '+972505404255', '972505404255']) {
      const found = await repair.findUserByPhoneFragment(c, form);
      assert.equal(found.ok, true, form);
      assert.equal(Number(found.data.user.id), Number(u.id), form);
    }
    assert.equal((await repair.findUserByPhoneFragment(c, '0509999999')).error.code, 'not_found');
    assert.equal((await repair.findUserByPhoneFragment(c, '4255')).error.code, 'invalid',
      'too short to aim at one person');
  });
});

test('an ambiguous fragment refuses rather than picking someone', async () => {
  await makeUser(db.pool, '+972521114455', { firstName: 'A' });
  await makeUser(db.pool, '+441114455', { firstName: 'B' });
  await withTx(db.pool, async (c) => {
    const res = await repair.findUserByPhoneFragment(c, '1114455');
    assert.equal(res.ok, false);
    assert.equal(res.error.candidates.length, 2, 'the operator is shown both, not guessed at');
  });
});

test('the repair re-opens the read-back and queues exactly one message', async () => {
  const u = await makeUser(db.pool, '+972505404277', { firstName: 'חיים' });
  await db.pool.query(
    `UPDATE users SET last_fact_extraction_at = now(), checkin_misses = 4,
            last_inbound_at = now() - interval '2 days' WHERE id = $1`, [u.id]);

  const res = await withTx(db.pool, (c) =>
    repair.repairMissedGoal(c, u.id, { note: 'למכור 3 מהרכבים שלו' }));
  assert.equal(res.ok, true);
  assert.equal(res.data.enqueued, true);

  const { rows: after } = await db.pool.query(
    `SELECT last_fact_extraction_at, checkin_misses, last_checkin_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(after[0].last_fact_extraction_at, null,
    'the next read-back tick re-reads their conversation, so the goal is saved in THEIR words');
  assert.equal(after[0].checkin_misses, 0,
    'a ladder that had given up would have swallowed this message');
  assert.ok(after[0].last_checkin_at, 'today\'s ladder must not fire a second message on top');

  const { rows: out } = await db.pool.query(
    `SELECT kind, payload, release_after, urgency FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'checkin');
  assert.match(out[0].payload.checkinInstruction, /<<<למכור 3 מהרכבים שלו>>>/,
    'the operator\'s text goes in as quoted data, like any text this system did not write');
  assert.match(out[0].payload.checkinInstruction, /save it THIS TURN/);
  assert.match(out[0].payload.checkinInstruction, /ONE question/);
  assert.ok(new Date(out[0].release_after).getTime() > Date.now(),
    'held back briefly so the read-back can land the goal on their list first');

  // running it again the same day changes nothing
  const again = await withTx(db.pool, (c) =>
    repair.repairMissedGoal(c, u.id, { note: 'למכור 3 מהרכבים שלו' }));
  assert.equal(again.data.enqueued, false);
  const { rows: still } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id]);
  assert.equal(still[0].n, 1);

  const { rows: log } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 AND event = 'admin.goal_repair'`, [u.id]);
  assert.equal(log.length, 2, 'both runs are on the record, including the one that did nothing');
});

// The whole point of queueing rather than sending: an operator running this at
// midnight must not wake anyone. The gate holds it and names the moment their
// own window opens.
test('a repair run inside their quiet hours lands when they come back, not at midnight', () => {
  const row = { kind: 'checkin', urgency: 'normal' };
  const window = { start: '08:00', end: '21:00' };
  const facts = (at) => ({
    row, plan: 'free', blocked: false, window, tz: 'Asia/Jerusalem',
    sentToday: 0, budget: 4, now: new Date(at), lastInboundAt: null,
  });

  const night = decide(facts('2026-08-22T00:30:00+03:00'));
  assert.equal(night.action, 'hold');
  assert.equal(night.holdReason, 'night');
  assert.equal(new Date(night.releaseAfter).toISOString(), new Date('2026-08-22T08:00:00+03:00').toISOString(),
    'released exactly when their window opens');

  assert.equal(decide(facts('2026-08-22T09:00:00+03:00')).action, 'deliver');
});

test('the repair refuses what it cannot do honestly', async () => {
  const u = await makeUser(db.pool, '+972505404288', { firstName: 'חיים' });
  await withTx(db.pool, async (c) => {
    const noNote = await repair.repairMissedGoal(c, u.id, { note: '  ' });
    assert.equal(noNote.error.code, 'invalid', 'the message opens with the goal — there has to be one');

    assert.equal((await repair.repairMissedGoal(c, 999999, { note: 'x' })).error.code, 'not_found');

    await c.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [u.id]);
    assert.equal((await repair.repairMissedGoal(c, u.id, { note: 'x' })).error.code, 'invalid');
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM outbox WHERE user_id = $1`, [u.id]);
    assert.equal(rows[0].n, 0, 'nothing queued for anyone the repair refused');
  });
});

// ---- the name we already had ------------------------------------------------

test('the display name is read out of the gateway\'s own conversation info', () => {
  const info = (sender, senderId) =>
    'Conversation info (untrusted metadata):\n```json\n'
    + JSON.stringify({ chat_id: senderId, sender_id: senderId, sender }, null, 2)
    + '\n```\n\nwhat they actually wrote';

  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972505404255')), 'חיים דדוש');
  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972505404255'), '+972505404255'),
    'חיים דדוש');
  assert.equal(sessions.displayNameFromPrompt(info('חיים דדוש', '+972500000000'), '+972505404255'),
    null, 'the intake agent holds every stranger — a name must match whose turn it was');
  assert.equal(sessions.displayNameFromPrompt(info('+972505404255', '+972505404255')), null,
    'with no display name set the gateway echoes the number — that is not a name');
  assert.equal(sessions.displayNameFromPrompt(info('', '+972505404255')), null);
  assert.equal(sessions.displayNameFromPrompt('a turn with no conversation info at all'), null);
});

test('the repair writes the known name as a guess and clears the fact it hid in', async () => {
  const u = await makeUser(db.pool, '+972505404299', { firstName: null });
  await withTx(db.pool, (c) => facts.rememberFact(c, u.id, {
    category: 'context', fact: 'שמו חיים.', importance: 2,
  }));
  await withTx(db.pool, (c) => facts.rememberFact(c, u.id, {
    category: 'habits', fact: 'מעוניין בפוליטיקה ישראלית והיסטוריה.', importance: 1,
  }));

  const preview = await withTx(db.pool, (c) => repair.nameFactCandidates(c, u.id, 'חיים'));
  assert.equal(preview.length, 1, 'only the fact that is nothing but the name');
  assert.equal(preview[0].fact, 'שמו חיים.');

  const res = await withTx(db.pool, (c) =>
    repair.repairMissingName(c, u.id, { name: 'חיים דדוש' }));
  assert.equal(res.ok, true);
  assert.equal(res.data.user.first_name, 'חיים');
  assert.equal(res.data.user.last_name, 'דדוש');
  assert.equal(res.data.user.name_confirmed, false, 'the agent still has to check');
  assert.equal(res.data.forgotten.length, 1);

  const left = await withTx(db.pool, (c) => facts.listFacts(c, u.id, {}));
  assert.equal(left.data.facts.length, 1, 'everything else they told us survives');
  assert.match(left.data.facts[0].fact, /פוליטיקה/);
});

test('the repair refuses a phone number and leaves the rest alone', async () => {
  const u = await makeUser(db.pool, '+972505404211', { firstName: null });
  await withTx(db.pool, async (c) => {
    assert.equal((await repair.repairMissingName(c, u.id, { name: '+972505404211' })).ok, false);
    assert.equal((await repair.repairMissingName(c, u.id, { name: '   ' })).ok, false);
  });
  const { rows } = await db.pool.query('SELECT first_name FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].first_name, null);
});

test('--keep-facts leaves the name fact in place', async () => {
  const u = await makeUser(db.pool, '+972505404222', { firstName: null });
  await withTx(db.pool, (c) => facts.rememberFact(c, u.id, {
    category: 'context', fact: 'שמו יובל.', importance: 2,
  }));
  const res = await withTx(db.pool, (c) =>
    repair.repairMissingName(c, u.id, { name: 'יובל', dropFacts: false }));
  assert.equal(res.ok, true);
  assert.equal(res.data.forgotten.length, 0);
  const left = await withTx(db.pool, (c) => facts.listFacts(c, u.id, {}));
  assert.equal(left.data.facts.length, 1);
});

test('only active, provisioned, nameless users are in scope', async () => {
  const fresh = await freshDb();
  try {
    const nameless = await makeUser(fresh.pool, '+972501110001', { firstName: null });
    await fresh.pool.query(`UPDATE users SET agent_id = 'u-x' WHERE id = $1`, [nameless.id]);
    await makeUser(fresh.pool, '+972501110002', { firstName: 'כבר יש' });
    const pending = await makeUser(fresh.pool, '+972501110003', { firstName: null, status: 'pending' });
    assert.ok(pending.id);

    const rows = await withTx(fresh.pool, (c) => repair.usersMissingName(c));
    assert.deepEqual(rows.map((r) => String(r.id)), [String(nameless.id)]);
  } finally {
    await fresh.teardown();
  }
});
