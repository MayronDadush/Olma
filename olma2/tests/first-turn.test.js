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

test('a name given in the first message is saved, not asked for again', async () => {
  // עידן, 2026-09-07, his first message and his first minute:
  //
  //   08:40  he:   קוראים לי עידן
  //   08:41  Olma: [the opening copy, verbatim]
  //   08:42  Olma: עידן, נכון? 😊
  //
  // The instruction said "if they actually asked for something, answer it
  // below those lines; otherwise stop there" — and telling us your name is
  // not asking for something, so it was dropped. `name_confirmed` stayed
  // false, and the 60-second rung (jobs/sweeps.sweepNameConfirm) did exactly
  // what it is built to do: asked him to confirm the name he had just typed.
  //
  // The repair is upstream of the rung, and it is a TOOL CALL rather than a
  // sentence — the brand copy still goes out alone, with no thanks, no
  // acknowledgement and no extra question. That is the part worth holding
  // open: a future edit that turns this into "greet them by their new name"
  // breaks the opening copy the owner fixed by hand.
  const u = await makeUser(db.pool, '+972611003013', { firstName: null, locale: 'he' });
  const { data } = await turnStart(u, { opened: false, counted: false });
  const said = data.onboarding.instruction;
  assert.match(said, /set_my_name/, 'nothing tells the model what to do with a name it was just given');
  // The half that was missing on the day: the model DID call set_my_name for
  // עידן at 05:41:04 — with confirmed omitted, so it landed as an
  // observation, name_confirmed stayed false, and the rung fired anyway.
  // Naming the tool is not enough; the flag is what the rung reads.
  assert.match(said, /confirmed: true/,
    'an unconfirmed save leaves the 60-second rung armed — that is the whole bug');
  assert.match(said, /קוראים לי/, 'and it names the shape, in the language people write it in');
  assert.match(said, /do not ask them to confirm it/i,
    'the whole point: he had already said it');
  assert.match(said, /Do not mention it|silently/i,
    'saving it must not add a sentence to brand copy that is sent verbatim');
  // The rules that were already there have to survive the addition.
  assert.match(said, /character for character/i);
  assert.match(said, /no follow-up question this turn/i);
});

test('somebody the greeter already welcomed is not welcomed again', async () => {
  // The duplicate introduction, from the receiving end. An organic joiner
  // reaches the intake greeter first; since 2026-09-07 the greeter sends the
  // owner's copy itself and provisioning stamps opening_sent_at, so the one
  // thing this turn must NOT do is say hello a second time. עידן read two
  // introductions ninety seconds apart, in two different voices.
  const u = await makeUser(db.pool, '+972611003016', { firstName: null, locale: 'he' });
  await db.pool.query(`UPDATE users SET opening_sent_at = now() WHERE id = $1`, [u.id]);

  const { data } = await turnStart(u, { opened: false, counted: false });
  assert.equal(data.firstTurn, true, 'it is still the first turn on their own agent');
  assert.equal(data.onboarding.sendVerbatim, undefined,
    'and the copy they have already read is not handed out again');
  assert.equal(data.onboarding.alreadyOpened, true);
  const said = data.onboarding.instruction;
  assert.match(said, /already been greeted/i);
  assert.match(said, /Answer what they actually wrote/i);
  assert.doesNotMatch(said, /character for character/i, 'there is no copy to send');
  // The 2026-08-17 rule this restores, in the words of the greeter's own file:
  // the conversation simply continues, silently more capable.
  assert.match(said, /do not say anything about being set up, ready/i);
  // The name half is not part of the opening and survives either way.
  assert.match(said, /set_my_name with confirmed: true/);
});

// The owner rewords the opening from the admin page like every other fixed
// sentence (2026-09-08); the words turn_start hands over are the reworded ones.
test('a reworded opening is what turn_start hands over, character for character', async () => {
  const templates = require('../src/domain/message-templates');
  const reworded = 'היי, אני עולמה 👋\n\nכאן בשביל הסדר שלך.';
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, templates.FLAG, { opening_he: reworded }));
  try {
    const u = await makeUser(db.pool, '+972611003099', { firstName: null, locale: 'he' });
    const { data } = await turnStart(u, { opened: false, counted: false });
    assert.equal(data.onboarding.sendVerbatim, reworded);
  } finally {
    await withTx(db.pool, (c) => flagsDomain.setFlag(c, templates.FLAG, {}));
  }
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
  // Rendered, not raw: since Phase B the template holds two turn doctrines
  // and a person's file carries exactly one (provision.renderAgentsMd).
  const { renderAgentsMd } = require('../src/intake/provision');
  const tok = 'olma_tok_' + 'a'.repeat(32);
  const doctrine = renderAgentsMd(tok);
  assert.doesNotMatch(doctrine, /There is no separate "welcome" moment/,
    'the unscoped version is what produced "היי" answered with "היי"');
  assert.match(doctrine, /With a section above there is no separate "welcome"/,
    'scoped to the case it was actually written for');
  assert.match(doctrine, /With none, `turn_start` says how to open/,
    'and points at where the other branch is answered');
  assert.match(renderAgentsMd(tok, { turnContext: true }), /With none, the Turn context says how to open/,
    'the context-opened variant points at its own opener');
});

test('the doctrine still fits the gateway budget after this change', () => {
  // tests/intake.test.js owns this guard; asserted here too because THIS change
  // is the one that nearly broke it, and a regression should name its cause.
  const { renderAgentsMd } = require('../src/intake/provision');
  const tok = 'olma_tok_' + 'a'.repeat(32);
  for (const turnContext of [false, true]) {
    const rendered = renderAgentsMd(tok, { turnContext });
    assert.ok(rendered.length <= 39250,
      `doctrine (turnContext=${turnContext}) is ${rendered.length} chars; the onboarding instruction belongs in the `
      + 'turn_start result precisely so it does not land here');
  }
});

// The beat after the opening (2026-09-04). The cold start read well right up
// to "מירון, נעים להכיר ☺️ אני פה לכל מה שתצטרך" and then stopped dead: the
// person has introduced themselves and has no idea what to do next. The
// opening copy deliberately asks nothing, so this is the only moment left to
// invite them in — and the tool that knows the moment has arrived is the one
// that just took their name.
async function call(user, name, args, turn = { opened: true, counted: true }) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call',
      params: { name, args: { olma_identity: user.identity_token, ...args } } },
    turn);
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

test('confirming a name on an empty list invites them to dump everything', async () => {
  const u = await makeUser(db.pool, '+972611003008', { firstName: null });
  // They were greeted a few minutes ago and have written since — the invitation
  // belongs to a LATER turn, and the guard below owns the opening one. Left as
  // a never-written user this fixture is the opening turn, which is how it
  // caught the guard the day it was added.
  await db.pool.query(
    `UPDATE users SET first_turn_at = now() - interval '10 minutes',
                      last_inbound_at = now() - interval '5 minutes' WHERE id = $1`, [u.id]);
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
  await db.pool.query(
    `UPDATE users SET first_turn_at = now() - interval '30 days',
                      last_inbound_at = now() - interval '1 hour' WHERE id = $1`, [u.id]);
  await call(u, 'add_task', { title: 'לשלם שכר דירה' });
  const out = await call(u, 'set_my_name', { first_name: 'ותיקה', confirmed: true });
  assert.equal(out.nextStep, undefined,
    'a month-old user who only now confirms their name is not a new user');
});

test('the opening turn keeps its own instruction — the invitation does not gatecrash it', async () => {
  // Reachable only since the first-turn instruction started asking for
  // set_my_name (2026-09-07). turn_start has just told the model to send the
  // owner's copy verbatim and stop; nextStep would tell it, in the same turn,
  // to greet them by name and invite them to pour everything out. Two
  // unconditional instructions about one reply is the "outvoted hint" shape,
  // and the brand copy is the one that must win.
  const u = await makeUser(db.pool, '+972611003014', { firstName: null, locale: 'he' });
  // ONE turn object across both calls, because that is what production is: the
  // MCP shim caches a single socket, so turn_start and every tool after it in
  // the same turn share it. A fresh object per call — which is what the `call`
  // helper above builds — reads as a new user to brokerd (server.js, the
  // `turn.userId !== actorId` reset), re-opens the turn and moves
  // last_inbound_at, which is the very equality this guard reads.
  const turn = { opened: false, counted: false };
  const { data } = await turnStart(u, turn);
  assert.equal(data.firstTurn, true, 'the state has to come from a real opening turn');

  const out = await call(u, 'set_my_name', { first_name: 'עידן', confirmed: true }, turn);
  assert.equal(out.user.name_confirmed, true, 'the name is still saved, and confirmed');
  assert.equal(out.nextStep, undefined, 'and it says nothing about what to write');

  // Their next message is a turn of its own — last_inbound_at moves, first_turn_at
  // does not — and from there the invitation is free to fire for anyone it
  // still applies to.
  await turnStart(u, turn);
  const later = await call(u, 'set_my_name', { first_name: 'עידן', confirmed: true }, turn);
  assert.match(later.nextStep, /invite them/i,
    'the guard is about THIS turn, not about ever having had an opening one');
});

test('...and still not when the model reached for the tool before turn_start', async () => {
  // The other door into the same turn. brokerd's recovery opens it and carries
  // the first-turn verdict, but only turn_start stamps first_turn_at — so the
  // timestamps alone read "not the opening turn" on the one turn that most is.
  const u = await makeUser(db.pool, '+972611003015', { firstName: null, locale: 'he' });
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.FLAG, 'all'));

  const turn = { opened: false, counted: false };
  const out = await call(u, 'set_my_name', { first_name: 'עידן', confirmed: true }, turn);
  assert.equal(turn.firstTurn, true, 'the recovery ran and captured the verdict');
  const stamp = await db.pool.query('SELECT first_turn_at FROM users WHERE id=$1', [u.id]);
  assert.equal(stamp.rows[0].first_turn_at, null, 'and nothing has stamped first_turn_at');
  assert.equal(out.nextStep, undefined, 'the opening copy is still the whole reply');
});

test('turn_start stamps first_turn_at exactly when it hands out the opening, equal to last_inbound_at', async () => {
  // sweeps.sweepNameConfirm (2026-09-04) depends on these being equal at the
  // moment the opening is sent — its silence test IS this equality holding.
  const u = await makeUser(db.pool, '+972611003011', { firstName: null });
  const before = await db.pool.query(`SELECT first_turn_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(before.rows[0].first_turn_at, null);

  await turnStart(u, { opened: false, counted: false });

  const after = await db.pool.query(
    `SELECT first_turn_at, last_inbound_at FROM users WHERE id = $1`, [u.id]);
  assert.notEqual(after.rows[0].first_turn_at, null);
  assert.deepEqual(after.rows[0].first_turn_at, after.rows[0].last_inbound_at,
    'both written by the same statement-window inside one transaction');
});

test('a returning user never gets first_turn_at stamped', async () => {
  const u = await makeUser(db.pool, '+972611003012', { firstName: 'Vatik' });
  await db.pool.query(
    `UPDATE users SET last_inbound_at = now() - interval '5 days' WHERE id = $1`, [u.id]);
  await turnStart(u, { opened: false, counted: false });
  const { rows } = await db.pool.query(`SELECT first_turn_at FROM users WHERE id = $1`, [u.id]);
  assert.equal(rows[0].first_turn_at, null);
});
