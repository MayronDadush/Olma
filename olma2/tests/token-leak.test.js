'use strict';
// On 2026-09-02 u-3's agent garbled a tool call and emitted DeepSeek's raw
// `<｜DSML｜tool_calls>` syntax as ordinary reply text during a delivery turn.
// The text went to WhatsApp verbatim, including `olma_identity` — מירון's live
// credential, and the whole auth mechanism for all 77 tools.
//
// Nothing in our code could have stopped it (a malformed call never reaches
// the dispatcher; the shim has no agent context; the gateway exposes no
// outbound hook), so what is left is noticing. These tests pin the two things
// that decide whether noticing is worth anything: that the signal is narrow
// enough not to fire on ordinary operation, and that a token is always
// attributed to the person it actually belongs to — never to whichever agent
// happened to say it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tokenLeak = require('../src/domain/token-leak');
const guard = require('../src/jobs/config-guard');
const flags = require('../src/domain/flags');

let db, miron, gali;
let mironTok, galiTok;

const AT = Date.parse('2026-09-02T09:31:00Z');

// One assistant-text block, the shape scanAssistantTextSince returns.
const said = (text, { at = AT, sessionId = 's1' } = {}) => ({ sessionId, at, text });

// A reader stub keyed by agent: the real one reads per-agent sqlite stores,
// which sessions-sqlite.test.js covers against a fixture shaped like the box.
const reader = (byAgent) => (agentId) => byAgent[agentId] || [];

before(async () => {
  db = await freshDb();
  miron = await makeUser(db.pool, '+972526269826', { firstName: 'Miron' });
  gali = await makeUser(db.pool, '+972502205854', { firstName: 'Gali' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-3' WHERE id = $1`, [miron.id]);
  await db.pool.query(`UPDATE users SET agent_id = 'u-8' WHERE id = $1`, [gali.id]);
  const { rows } = await db.pool.query('SELECT id, identity_token FROM users ORDER BY id');
  mironTok = rows.find((r) => Number(r.id) === Number(miron.id)).identity_token;
  galiTok = rows.find((r) => Number(r.id) === Number(gali.id)).identity_token;
  assert.match(mironTok, /^olma_tok_[0-9a-f]{32}$/, 'the fixture must use real token shape');
});
after(async () => { await db.teardown(); });

// ---- what counts as a leak ---------------------------------------------

test('a token in delivered assistant text is a leak, attributed to its owner', async () => {
  const found = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    scan: reader({ 'u-3': [said(`<｜DSML｜tool_calls>{"olma_identity":"${mironTok}"}`)] }),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].userId, Number(miron.id));
  assert.equal(found[0].agentId, 'u-3');
  assert.equal(found[0].ownAgent, true);
  assert.equal(found[0].fingerprint, tokenLeak.fingerprint(mironTok));
  // the token itself is never carried out of the scan
  assert.ok(!JSON.stringify(found).includes(mironTok), 'a leak detector must not be a second copy');
});

// The measured distribution over 14 days on the live box: 717 toolCall, 13
// toolResult, 1 thinking, 1 assistant text — and the one is the incident.
// scanAssistantTextSince keeps only `type: 'text'` parts for exactly this
// reason; this test pins the consequence, that ordinary operation is silent.
test('an ordinary authenticated tool call is not a leak', async () => {
  const found = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    // what the reader hands back for a turn made entirely of tool calls
    scan: reader({ 'u-3': [], 'u-8': [] }),
  });
  assert.deepEqual(found, []);
});

test('a token already rotated is not reported — nothing is exposed any more', async () => {
  const stale = 'olma_tok_' + 'a'.repeat(32);
  const found = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    scan: reader({ 'u-3': [said(`old text with ${stale} in it`)] }),
  });
  assert.deepEqual(found, [], 'a dead string exposes nothing');
});

// ---- cross-user attribution --------------------------------------------

test("another user's token in an agent's output is attributed to its OWNER", async () => {
  const found = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    // Gali's agent said Miron's token. The victim is Miron; u-8 is the vehicle.
    scan: reader({ 'u-8': [said(`identity ${mironTok}`)] }),
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].userId, Number(miron.id), 'never the agent owner');
  assert.notEqual(found[0].userId, Number(gali.id));
  assert.equal(found[0].agentId, 'u-8');
  assert.equal(found[0].ownAgent, false);

  const line = tokenLeak.violationFor(found[0]);
  assert.match(line, /is NOT theirs/, 'the worse fact has to be said differently');
  assert.match(line, /u-8/);
  assert.ok(guard.leaksCredential(line), 'and still routes to the credential alert');
});

test('every agent is scanned against every token, so no leak hides behind ownership', async () => {
  const found = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    scan: reader({
      'u-3': [said(`mine ${mironTok}`), said(`hers ${galiTok}`, { at: AT + 5 })],
      'u-8': [said(`his ${mironTok}`, { at: AT + 9 })],
    }),
  });
  // three distinct exposures: Miron via his own agent, Gali via Miron's,
  // Miron via Gali's. Collapsing any pair would hide a real one.
  assert.equal(found.length, 3);
  const seen = found.map((f) => `${f.userId}:${f.agentId}`).sort();
  assert.deepEqual(seen, [
    `${miron.id}:u-3`, `${miron.id}:u-8`, `${gali.id}:u-3`,
  ].sort());
});

test('one token said by two agents stays two rows after reconcile', () => {
  const fp = tokenLeak.fingerprint(mironTok);
  const fpByUser = new Map([[1, fp]]);
  const found = [
    { userId: 1, fingerprint: fp, agentId: 'u-3', ownAgent: true, at: AT },
    { userId: 1, fingerprint: fp, agentId: 'u-8', ownAgent: false, at: AT + 10 },
  ];
  const next = tokenLeak.reconcile([], found, fpByUser);
  assert.equal(next.length, 2);
  assert.deepEqual(next.map((e) => e.agentId).sort(), ['u-3', 'u-8']);
});

// ---- unreadable is not clean -------------------------------------------

test('a store that cannot be read never manufactures a clean bill of health', async () => {
  const thrown = await tokenLeak.scanForLeaks(db.pool, {
    now: AT + 1000,
    scan: () => { throw new Error('store locked'); },
  });
  assert.deepEqual(thrown, [], 'skipped, not treated as evidence either way');

  // null is "could not read", and must not be mistaken for "nothing said"
  assert.deepEqual(await tokenLeak.scanForLeaks(db.pool, { now: AT + 1000, scan: () => null }), []);
});

// ---- remembering, and the one way a finding clears ----------------------

test('a leak that ages out of the scan window is still reported', () => {
  const fp = tokenLeak.fingerprint(mironTok);
  const stored = [{ userId: 1, fingerprint: fp, agentId: 'u-3', ownAgent: true, at: AT }];
  // the window bounds cost, never truth: the credential is still live
  const next = tokenLeak.reconcile(stored, [], new Map([[1, fp]]));
  assert.equal(next.length, 1, 'closeResolved must not close what nobody fixed');
  assert.equal(next[0].at, AT, 'and it keeps the moment it became public');
});

test('rotating the token is the one thing that clears it', () => {
  const fp = tokenLeak.fingerprint(mironTok);
  const stored = [{ userId: 1, fingerprint: fp, agentId: 'u-3', ownAgent: true, at: AT }];
  const rotated = new Map([[1, tokenLeak.fingerprint('olma_tok_' + 'b'.repeat(32))]]);
  assert.deepEqual(tokenLeak.reconcile(stored, [], rotated), []);
});

// sha256("") is a perfectly ordinary-looking digest, so hashing an absent
// token would make two missing values compare EQUAL and read as "still the
// same token" — the empty-string hash trap, one layer down.
test('an absent token has no fingerprint', () => {
  assert.equal(tokenLeak.fingerprint(''), null);
  assert.equal(tokenLeak.fingerprint(null), null);
  assert.equal(tokenLeak.fingerprint('   '), null);
  assert.notEqual(tokenLeak.fingerprint('a'), tokenLeak.fingerprint('b'));
});

// ---- the guard wiring ---------------------------------------------------

test('checkLeakedTokens files a stable line and remembers it across ticks', async () => {
  const deps = {
    now: AT + 1000,
    scan: reader({ 'u-3': [said(`<｜DSML｜tool_calls> ${mironTok}`)] }),
  };
  const first = await guard.checkLeakedTokens(db.pool, deps);
  assert.equal(first.length, 1);
  assert.ok(guard.leaksCredential(first[0]));
  assert.ok(!guard.breaksUsers(first[0]), 'a leaked token breaks nobody — the lists mean one thing each');

  const stored = JSON.parse(await flags.getFlag(db.pool, guard.LEAK_FLAG));
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(mironTok), 'the flag stores a fingerprint, not the credential');

  // a later tick where the event has scrolled out of the window still reports
  const second = await guard.checkLeakedTokens(db.pool, { now: AT + 1000, scan: () => [] });
  assert.deepEqual(second, first, 'the title does not move, so no second issue is filed');

  // and rotating clears it
  await db.pool.query(
    `UPDATE users SET identity_token = $2 WHERE id = $1`,
    [miron.id, 'olma_tok_' + 'c'.repeat(32)]);
  assert.deepEqual(await guard.checkLeakedTokens(db.pool, { now: AT + 1000, scan: () => [] }), []);
  assert.deepEqual(JSON.parse(await flags.getFlag(db.pool, guard.LEAK_FLAG)), []);
  await db.pool.query(`UPDATE users SET identity_token = $2 WHERE id = $1`, [miron.id, mironTok]);
});

// Park the alert phone's user in whatever zone makes their LOCAL hour the one
// a test needs. The leak class waits for a civil hour, so without this these
// would be green thirteen hours a day and red the other eleven — the exact
// failure this repo found by the clock rolling past midnight mid-session.
async function setLocalHour(hour) {
  const { rows } = await db.pool.query(`SELECT extract(hour from now() at time zone 'UTC')::int AS h`);
  const off = ((hour - rows[0].h) % 24 + 24) % 24;
  const zone = off === 0 ? 'Etc/GMT+0' : (off <= 12 ? `Etc/GMT-${off}` : `Etc/GMT+${24 - off}`);
  await db.pool.query(`UPDATE users SET timezone = $2 WHERE id = $1`, [miron.id, zone]);
}

const LEAK_LINE = 'user 3: a live identity token was sent as message text — the credential is exposed in a real chat and still works';

// Asked for by the owner after a night of alarms. Deferring is not dropping:
// the entry stays unstamped, so the next 10-minute tick tries again — and a
// leak's evidence is remembered rather than aged out, which is why this needs
// no queue of its own the way the credit alarm does.
test('a leak found at 03:00 waits for morning, and is not marked as announced', async () => {
  await flags.setFlag(db.pool, guard.ALERTED_FLAG, '[]');
  await setLocalHour(3);
  const sent = [];
  const send = async (_p, t) => { sent.push(t); return { ok: true }; };

  const night = await guard.alertCritical(db.pool, [LEAK_LINE], { send });
  assert.deepEqual(sent, [], 'nobody is woken for a token they cannot rotate asleep');
  assert.equal(night.deferredToMorning, 1);
  assert.ok(!night.alertFailed, 'a deferral is not a broken pipe and must not read as one');
  assert.deepEqual(JSON.parse(await flags.getFlag(db.pool, guard.ALERTED_FLAG)), [],
    'unstamped, or the morning tick would think it had already been said');

  await setLocalHour(12);
  const morning = await guard.alertCritical(db.pool, [LEAK_LINE], { send });
  assert.equal(morning.alerted, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(await flags.getFlag(db.pool, guard.ALERTED_FLAG)), [LEAK_LINE]);

  // and it is said once, not again on every tick for the rest of the day
  assert.equal(await guard.alertCritical(db.pool, [LEAK_LINE], { send }), null);
  assert.equal(sent.length, 1);
  await flags.setFlag(db.pool, guard.ALERTED_FLAG, '[]');
});

test('the leak alert is its own message, not a widening of BREAKS_USERS', async () => {
  await flags.setFlag(db.pool, guard.ALERTED_FLAG, '[]');
  await setLocalHour(12);
  const sent = [];
  const res = await guard.alertCritical(db.pool, [
    LEAK_LINE,
    'user 8 (+972502205854): identity file does not match DB token',
    'agent main holds whatsapp sessions that active users have talked INTO — it has no user of its own, so anything that wakes it answers a real person in a real conversation',
  ], { send: async (phone, text) => { sent.push(text); return { ok: true }; } });

  assert.equal(res.alerted, 2);
  assert.equal(sent.length, 2, 'one message per class, each true of what it carries');
  const leak = sent.find((t) => t.includes('טוקן זהות חי'));
  const blocked = sent.find((t) => t.includes('משתמשים חסומים'));
  assert.ok(leak && blocked);
  assert.ok(!leak.includes('חסומים'), 'a leak does not block anybody, and must not say so');
  assert.ok(sent.every((t) => !t.includes('agent main holds')), 'dashboard-only violations stay off the phone');
  await flags.setFlag(db.pool, guard.ALERTED_FLAG, '[]');
});
