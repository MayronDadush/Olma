'use strict';
// The one turn in a person's life where there is no conversation to continue
// (2026-09-04). Walking the onboarding on a real account showed a cold start
// answering "היי" with "היי 😊 מה קורה?" and never onboarding anybody:
// `turn_start` returned a bare `proceed`, identical to a message from someone
// it had known for a month, and the doctrine told the agent there is no
// welcome moment. The signal was missing, not the instruction — so what is
// under test here is that the signal exists, is true exactly once, and cannot
// be re-derived after the evidence is consumed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const turnDomain = require('../src/domain/turn');
const flagsDomain = require('../src/domain/flags');
const onboarding = require('../src/domain/onboarding');

let db, broker;
before(async () => { db = await freshDb(); broker = createBrokerServer({ pool: db.pool }); });
after(async () => { await db.teardown(); });

// dispatch answers the way the MCP shim speaks: `{ ok, text }` where text is
// "OK <json>". Parsing it here means these tests assert on what the agent
// actually receives, not on an internal envelope it never sees.
async function turnStart(user, turn) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    turn);
  assert.equal(res.ok, true, res.text);
  return { res, data: JSON.parse(res.text.replace(/^OK /, '')) };
}

test('the first ever message carries firstTurn, and the second does not', async () => {
  const u = await makeUser(db.pool, '+972611003001', { firstName: null });
  const before = await db.pool.query('SELECT last_inbound_at FROM users WHERE id=$1', [u.id]);
  assert.equal(before.rows[0].last_inbound_at, null, 'a fresh user has never written');

  const first = await turnStart(u, { opened: false, counted: false });
  assert.equal(first.data.directive, 'proceed');
  assert.equal(first.data.firstTurn, true, 'their first ever message says so');

  const second = await turnStart(u, { opened: false, counted: false });
  assert.equal(second.data.directive, 'proceed');
  assert.equal(second.data.firstTurn, undefined,
    'omitted, not false — an every-turn field nobody reads is cost with no signal');
});

test('a returning user never gets it, however long they have been away', async () => {
  const u = await makeUser(db.pool, '+972611003002', { firstName: 'Vatik' });
  await db.pool.query(
    `UPDATE users SET last_inbound_at = now() - interval '200 days' WHERE id = $1`, [u.id]);
  const res = await turnStart(u, { opened: false, counted: false });
  assert.equal(res.data.firstTurn, undefined,
    'silence is not newness — a dormant user has already been introduced');
});

test('when another tool opens the turn first, the verdict survives into turn_start', async () => {
  const u = await makeUser(db.pool, '+972611003003', { firstName: null });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, 'all'));

  // The model skipped turn_start and reached for a tool. brokerd's recovery
  // opens the turn — and in doing so overwrites the very NULL that proves this
  // is their first message. If the verdict did not travel in ctx, a turn_start
  // arriving later in the same turn would read the row it just moved and
  // report a returning user on somebody's opening message.
  const turn = { opened: false, counted: false };
  const viaOtherTool = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'list_my_tasks', args: { olma_identity: u.identity_token } } },
    turn);
  assert.equal(viaOtherTool.ok, true);
  assert.equal(turn.counted, true, 'the recovery ran');
  assert.equal(turn.firstTurn, true, 'and it captured the first-turn verdict');

  const after = await db.pool.query('SELECT last_inbound_at FROM users WHERE id=$1', [u.id]);
  assert.notEqual(after.rows[0].last_inbound_at, null, 'the evidence is now consumed');

  const late = await turnStart(u, turn);
  assert.equal(late.data.firstTurn, true,
    'read from the turn, not re-derived from a row that has already moved');
});

test('the recovery path still reports a returning user correctly', async () => {
  const u = await makeUser(db.pool, '+972611003004', { firstName: 'Chozeret' });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, 'all'));
  await db.pool.query(`UPDATE users SET last_inbound_at = now() - interval '2 days' WHERE id=$1`, [u.id]);

  const turn = { opened: false, counted: false };
  await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'list_my_tasks', args: { olma_identity: u.identity_token } } },
    turn);
  assert.equal(turn.firstTurn, false);
  const late = await turnStart(u, turn);
  assert.equal(late.data.firstTurn, undefined);
});

test('the first-turn read does not disturb what the same statement already did', async () => {
  // The UPDATE grew a self-join to see the pre-update row. It still has to do
  // its original two jobs, or a cheap signal costs a check-in ladder.
  const u = await makeUser(db.pool, '+972611003005', { firstName: 'Dorit' });
  await db.pool.query(`UPDATE users SET checkin_misses = 3 WHERE id = $1`, [u.id]);
  await turnStart(u, { opened: false, counted: false });
  const { rows } = await db.pool.query(
    `SELECT checkin_misses, last_inbound_at IS NOT NULL AS awake FROM users WHERE id = $1`, [u.id]);
  assert.equal(rows[0].checkin_misses, 0, 'writing resets the check-in backoff');
  assert.equal(rows[0].awake, true, 'and marks them awake');
});

test('a connection that outlives its turn does not hand the next message a stale flag', async () => {
  // brokerd clears the recovery's verdict after turn_start for the same reason
  // it clears the quota count: one MCP connection can serve more than one turn,
  // and "this person is brand new" leaking into their second message is this
  // fix causing the bug it exists to prevent.
  const u = await makeUser(db.pool, '+972611003006', { firstName: null });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, 'all'));

  const turn = { opened: false, counted: false };
  await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name: 'list_my_tasks', args: { olma_identity: u.identity_token } } },
    turn);
  assert.equal(turn.firstTurn, true);

  const first = await turnStart(u, turn);
  assert.equal(first.data.firstTurn, true, 'their opening message still reports it');
  assert.equal(turn.firstTurn, false, 'and the turn object is spent');

  const next = await turnStart(u, turn);
  assert.equal(next.data.firstTurn, undefined, 'the reused connection does not repeat it');
});

test('the flag arrives with the exact opening copy, in their language', async () => {
  // A signal nothing tells the model what to do with is a field nobody reads.
  // It rides in the result rather than in AGENTS.md because the doctrine is at
  // 39249 of its 39250-char budget — see the comment at the return site.
  const u = await makeUser(db.pool, '+972611003007', { firstName: null, locale: 'he' });
  const { data } = await turnStart(u, { opened: false, counted: false });
  assert.equal(data.firstTurn, true);
  assert.equal(data.onboarding.sendVerbatim, onboarding.OPENING.he,
    'the owner\'s words, not a paraphrase of them');
  assert.match(data.onboarding.instruction, /character for character/i,
    'and an instruction that leaves no room to reword brand copy');

  const { data: next } = await turnStart(u, { opened: false, counted: false });
  assert.equal(next.onboarding, undefined, 'and never again');
});

test('an English speaker gets the English opening', async () => {
  const u = await makeUser(db.pool, '+15551230007', { firstName: null, locale: 'en' });
  const { data } = await turnStart(u, { opened: false, counted: false });
  assert.equal(data.onboarding.sendVerbatim, onboarding.OPENING.en);
  assert.match(data.onboarding.sendVerbatim, /Allma/, 'the English name is Allma, not Olma');
});

test('an unknown locale still gets a real message, never an empty one', () => {
  assert.equal(onboarding.openingMessage('fr'), onboarding.OPENING.en);
  assert.equal(onboarding.openingMessage(undefined), onboarding.OPENING.en);
  assert.equal(onboarding.openingMessage(null), onboarding.OPENING.en);
});

test('the opening copy is exactly what the owner wrote', () => {
  // Brand copy nobody can silently edit. If this fails, someone changed the
  // first thing every new person will ever read — which is a decision, not a
  // refactor, so it should cost a deliberate update to this test.
  assert.equal(onboarding.OPENING.he.split('\n').length, 4, 'four lines');
  assert.equal(onboarding.OPENING.he.split('\n')[1], '',
    'the greeting stands on its own line — revision 2, read on a real phone');
  assert.equal(onboarding.OPENING.en.split('\n')[1], '');
  assert.ok(onboarding.OPENING.he.startsWith('היי, אני עולמה \u{1F44B}'));
  for (const copy of [onboarding.OPENING.he, onboarding.OPENING.en]) {
    assert.doesNotMatch(copy, /ברוכים הבאים|Welcome to your world/,
      'the welcome-to-your-world line was cut in revision 2');
  }
  assert.ok(onboarding.OPENING.he.endsWith('אני אעשה לכם סדר ☺️'));
  assert.ok(onboarding.OPENING.en.startsWith("Hey! I'm Allma \u{1F44B}"));
  assert.ok(onboarding.OPENING.en.endsWith('keep you organized ☺️'));
  // It must not ask anything: the curiosity doctrine owns the name question,
  // and one reply carries one question at most.
  assert.doesNotMatch(onboarding.OPENING.he, /\?/, 'the opening asks nothing');
  assert.doesNotMatch(onboarding.OPENING.en, /\?/, 'the opening asks nothing');
});

test('the doctrine no longer over-generalises "no welcome moment"', () => {
  // The line that caused this: scoped to the pending-intake case it is right,
  // unscoped it told the agent never to introduce itself to anyone, ever.
  const fs = require('node:fs');
  const path = require('node:path');
  const doctrine = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'intake', 'agents-template.md'), 'utf8');
  assert.doesNotMatch(doctrine, /There is no separate "welcome" moment/,
    'the unscoped version is what produced "היי" answered with "היי"');
  assert.match(doctrine, /With a section above there is no separate "welcome"/,
    'scoped to the case it was actually written for');
  assert.match(doctrine, /With none, `turn_start` says how to open/,
    'and points at where the other branch is answered');
});

test('the doctrine still fits the gateway budget after this change', () => {
  // tests/intake.test.js owns this guard; asserted here too because THIS change
  // is the one that nearly broke it, and a regression should name its cause.
  const fs = require('node:fs');
  const tpl = fs.readFileSync(require('../src/intake/provision').TEMPLATE_PATH, 'utf8');
  const rendered = tpl.replaceAll('{{IDENTITY_TOKEN}}', 'olma_tok_' + 'a'.repeat(32));
  assert.ok(rendered.length <= 39250,
    `doctrine is ${rendered.length} chars; the onboarding instruction belongs in the `
    + 'turn_start result precisely so it does not land here');
});

// The beat after the opening (2026-09-04). The cold start read well right up
// to "מירון, נעים להכיר ☺️ אני פה לכל מה שתצטרך" and then stopped dead: the
// person has introduced themselves and has no idea what to do next. The
// opening copy deliberately asks nothing, so this is the only moment left to
// invite them in — and the tool that knows the moment has arrived is the one
// that just took their name.
async function call(user, name, args) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name, args: { olma_identity: user.identity_token, ...args } } },
    { opened: true, counted: true });
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

test('confirming a name on an empty list invites them to dump everything', async () => {
  const u = await makeUser(db.pool, '+972611003008', { firstName: null });
  const out = await call(u, 'set_my_name', { first_name: 'מירון', confirmed: true });
  assert.equal(out.user.first_name, 'מירון');
  assert.match(out.nextStep, /invite them/i);
  assert.match(out.nextStep, /tasks|plate/i);
  assert.match(out.nextStep, /voice note/i, 'the opening promised voice — this repeats the offer');
  assert.match(out.nextStep, /no categories|messy|unsorted/i,
    'dumping, not filling in a form');
});

test('a name merely observed does not trigger the invitation', async () => {
  // The WhatsApp display name arrives on every turn as an unconfirmed guess.
  // Inviting someone to pour their life out because we read their profile is
  // not the same moment at all.
  const u = await makeUser(db.pool, '+972611003009', { firstName: null });
  const out = await call(u, 'set_my_name', { first_name: 'M&M', confirmed: false });
  assert.equal(out.nextStep, undefined);
});

test('someone who already has a list is not invited to start one', async () => {
  const u = await makeUser(db.pool, '+972611003010', { firstName: null });
  await call(u, 'add_task', { title: 'לשלם שכר דירה' });
  const out = await call(u, 'set_my_name', { first_name: 'ותיקה', confirmed: true });
  assert.equal(out.nextStep, undefined,
    'a month-old user who only now confirms their name is not a new user');
});
