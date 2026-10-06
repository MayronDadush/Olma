'use strict';
// The game-only track (domain/game-track.js, owner 2026-10-06). Somebody a
// game night's code brought in hears the night and the welcome, and nothing
// the check-in ladder decides to say, until they use her for something else —
// and then their day one starts from that moment, without the name check.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const gameTrack = require('../src/domain/game-track');
const checkin = require('../src/jobs/checkin');
const selfInitiated = require('../src/domain/self-initiated');
const { createBrokerServer } = require('../src/brokerd/server');
const hook = require('../gateway-hooks/olma-turn-open/handler');

const H = 3600_000;

// ---- pure ------------------------------------------------------------------
test('on the track means joined through a code and not yet left', () => {
  assert.equal(gameTrack.onTrack({ game_track_at: new Date(), game_track_left_at: null }), true);
  assert.equal(gameTrack.onTrack({ game_track_at: new Date(), game_track_left_at: new Date() }), false);
  assert.equal(gameTrack.onTrack({ game_track_at: null }), false);
  assert.equal(gameTrack.onTrack(undefined), false);
});

test('a message leaves the track only when no night is open or just closed, and never a thanks or a code', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const open = [{ status: 'open' }];
  const lastNight = [{ status: 'settled', closedAt: new Date(now - 9 * H).toISOString() }];
  const lastWeek = [{ status: 'settled', closedAt: new Date(now - 4 * 24 * H).toISOString() }];
  assert.equal(gameTrack.leavesOnMessage({ nights: open, now }), null, 'mid-game');
  assert.equal(gameTrack.leavesOnMessage({ nights: lastNight, now }), null, 'the morning after is still the night');
  assert.equal(gameTrack.leavesOnMessage({ nights: lastWeek, now }), 'message');
  assert.equal(gameTrack.leavesOnMessage({ nights: [], now }), 'message', 'read, and nothing there');
  assert.equal(gameTrack.leavesOnMessage({ nights: null, now }), null, 'unreadable is never evidence they moved on');
  assert.equal(gameTrack.leavesOnMessage({ nights: [], thanks: true, now }), null);
  assert.equal(gameTrack.leavesOnMessage({ nights: [], byCode: true, now }), null);
  assert.equal(gameTrack.leavesOnMessage({ nights: open, abilities: true, now }), 'abilities', 'asking what she does leaves even mid-game');
});

test('the nights are read only when they decide anything', async () => {
  let reads = 0;
  const read = async () => { reads += 1; return []; };
  assert.equal(await gameTrack.leavesOnTurn({ abilities: true }, read), 'abilities');
  assert.equal(await gameTrack.leavesOnTurn({ thanks: true }, read), null);
  assert.equal(reads, 0);
  assert.equal(await gameTrack.leavesOnTurn({}, read), 'message');
  assert.equal(reads, 1);
});

test('nightsOf keeps "none" and "could not tell" apart', async () => {
  assert.deepEqual(await gameTrack.nightsOf(1, async () => ({ ok: true, nights: [] })), []);
  assert.equal(await gameTrack.nightsOf(1, async () => ({ ok: false, error: 'down' })), null);
  assert.equal(await gameTrack.nightsOf(1, async () => { throw new Error('refused'); }), null);
});

test('a tool leaves the track only off the allowlist — reading and housekeeping do not', () => {
  for (const t of ['add_task', 'set_task_reminder', 'start_meeting_coordination', 'request_connection']) {
    assert.equal(gameTrack.leavesOnTool(t), 'tool', t);
  }
  for (const t of ['turn_start', 'list_my_tasks', 'set_my_name', 'set_my_timezone', 'games__join', 'open_my_dashboard']) {
    assert.equal(gameTrack.leavesOnTool(t), null, t);
  }
});

test('"what can you do" is read by the hook — and "למה" is not "מה"', () => {
  for (const s of ['מה את יודעת לעשות?', 'מה את יכולה לעשות', 'מה עוד את עושה?', 'מי את?', 'what can you do?', 'who are you']) {
    assert.equal(hook.asksAbilities(s), true, s);
  }
  // u56's real message, the false positive the first draft took.
  for (const s of ['למה את יכולה לכתוב רק הודעה אחת ביום ?', 'מה את עושה מחר בערב, בא לך?', 'עוד כניסה', '', null]) {
    assert.equal(hook.asksAbilities(s), false, String(s));
  }
});

// ---- with a database -------------------------------------------------------
let db, broker, nights;
before(async () => {
  db = await freshDb();
  await require('../src/domain/flags').setFlag(db.pool, 'turn_context_phones', 'all');
  broker = createBrokerServer({
    pool: db.pool, placeMark: () => ({ attempted: true }),
    games: { mine: async () => nights },
  });
});
after(async () => { await db.teardown(); });
beforeEach(() => { selfInitiated._reset(); selfInitiated._setGraceMs(0); nights = { ok: true, nights: [] }; });

let seq = 0;
async function player({ ageH = 30, left = null } = {}) {
  seq += 1;
  const phone = `+9725266${String(seq).padStart(5, '0')}`;
  const u = await makeUser(db.pool, phone, { firstName: 'רפי' });
  const agent = `u-${7000 + seq}`;
  await db.pool.query(
    `UPDATE users SET agent_id = $2, onboarded_at = now() - ($3 * interval '1 hour'),
            created_at = now() - ($3 * interval '1 hour'),
            game_track_at = now() - ($3 * interval '1 hour'), game_track_left_at = $4
      WHERE id = $1`, [u.id, agent, ageH, left]);
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - ($2 * interval '1 hour') WHERE actor_id = $1`, [u.id, ageH]);
  return { ...u, agent };
}
const rowOf = async (id) => (await db.pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
const checkinsOf = async (id) => (await db.pool.query(
  `SELECT idempotency_key, payload FROM outbox WHERE user_id = $1 AND kind = 'checkin' ORDER BY id`, [id])).rows;

test('the ladder says nothing to somebody on the track — not day one, not "מה איתך"', async () => {
  const fresh = await player({ ageH: 0.3 });   // the 15m step would be due
  const old = await player({ ageH: 24 * 5 });  // an ordinary check-in would be due
  const ids = (await checkin.eligibleUsers(db.pool, Date.now())).map((u) => Number(u.id));
  assert.ok(!ids.includes(Number(fresh.id)));
  assert.ok(!ids.includes(Number(old.id)));
  await withTx(db.pool, (c) => checkin.run(c));
  assert.deepEqual(await checkinsOf(fresh.id), []);
  assert.deepEqual(await checkinsOf(old.id), []);
});

test('leaving starts day one from that moment, with its own keys and no name check', async () => {
  // Joined at the game four days ago, started using her twenty minutes ago.
  const u = await player({ ageH: 96, left: new Date(Date.now() - 20 * 60_000) });
  const me = (await checkin.eligibleUsers(db.pool, Date.now())).find((r) => Number(r.id) === Number(u.id));
  assert.ok(me, 'eligible again');
  assert.equal(me.after_game, true);
  assert.equal(me.onboardingStep.slot, '15m', 'the ladder they skipped is the one they get');
  await withTx(db.pool, (c) => checkin.run(c));
  const [row] = await checkinsOf(u.id);
  assert.equal(row.idempotency_key, `onboarding:${u.id}:15m:after_game`);
  const said = row.payload.checkinInstruction;
  assert.match(said, /more than their game nights/);
  assert.doesNotMatch(said, /They joined/);
  assert.doesNotMatch(said, /ONLY question mark|name we hold/i, 'they gave their name at the table');
});

test('the steps of the night they joined do not make them deaf for the day one that starts now', async () => {
  const u = await player({ ageH: 96, left: new Date(Date.now() - 6 * H) });
  // Two steps reached them the night they joined, and they wrote nothing then.
  for (const slot of ['15m', '2h']) {
    await db.pool.query(
      `INSERT INTO outbox (user_id, kind, payload, idempotency_key, sent_at, created_at)
       VALUES ($1, 'checkin', $2, $3, now() - interval '95 hours', now() - interval '95 hours')`,
      [u.id, JSON.stringify({ rung: `onboarding_${slot}` }), `onboarding:${u.id}:${slot}`]);
  }
  const client = await db.pool.connect();
  try {
    const me = (await checkin.eligibleUsers(client, Date.now())).find((r) => Number(r.id) === Number(u.id));
    assert.equal(await checkin.isDeafOnDayOne(client, u.id, me.onboarded_at), false);
  } finally { client.release(); }
});

test('the name sweep leaves somebody on the track alone', async () => {
  const u = await player({ ageH: 2 });
  await db.pool.query(
    `UPDATE users SET name_confirmed = false, first_turn_at = now() - interval '2 minutes',
            last_inbound_at = now() - interval '2 minutes' WHERE id = $1`, [u.id]);
  const sweeps = require('../src/jobs/sweeps');
  await sweeps.sweepNameConfirm(db.pool);
  const count = async () => (await db.pool.query(
    'SELECT count(*)::int AS n FROM outbox WHERE user_id = $1', [u.id])).rows[0].n;
  assert.equal(await count(), 0);
  await db.pool.query('UPDATE users SET game_track_left_at = now() WHERE id = $1', [u.id]);
  await sweeps.sweepNameConfirm(db.pool);
  assert.equal(await count(), 1, 'the same person off the track is asked — the exclusion is what held it');
});

// ---- brokerd ---------------------------------------------------------------
const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const call = (user, name, args, turn = newTurn()) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: user.identity_token, ...args } } }, turn);
const open = (params) => broker.dispatch({ id: 1, method: 'turn_open', params });
const context = (params) => broker.dispatch({ id: 1, method: 'turn_context', params });
const leftWhy = async (id) => (await db.pool.query(
  `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'game_track.left'`, [id])).rows.map((r) => r.detail);
let msg = 0;
const mid = () => `3EB0GTRK${String(++msg).padStart(4, '0')}`;

test('saving a task is using her: the track ends, once, with the tool named', async () => {
  const u = await player();
  const r = await call(u, 'add_task', { title: 'לקנות חלב' });
  assert.equal(r.ok, true, r.text);
  assert.ok((await rowOf(u.id)).game_track_left_at);
  assert.deepEqual(await leftWhy(u.id), [{ reason: 'tool', tool: 'add_task' }]);
  await call(u, 'add_task', { title: 'לקנות לחם' });
  assert.equal((await leftWhy(u.id)).length, 1, 'stamped once');
});

test('a turn Olma started does not end the track, and a reading tool does not', async () => {
  const u = await player();
  await call(u, 'list_my_tasks', {});
  assert.equal((await rowOf(u.id)).game_track_left_at, null);
  selfInitiated.begin(u.id);
  await call(u, 'add_task', { title: 'משהו' });
  assert.equal((await rowOf(u.id)).game_track_left_at, null);
});

test('a free message ends it when no night is near, and not mid-game', async () => {
  const u = await player();
  nights = { ok: true, nights: [{ status: 'open', code: 'K7M2Q' }] };
  await open({ agentId: u.agent, messageId: mid(), kind: 'text' });
  await context({ agentId: u.agent, trigger: 'user', messageProvider: 'whatsapp' });
  assert.equal((await rowOf(u.id)).game_track_left_at, null, 'a message during the game is about the game');

  nights = { ok: true, nights: [] };
  await open({ agentId: u.agent, messageId: mid(), kind: 'text' });
  await context({ agentId: u.agent, trigger: 'user', messageProvider: 'whatsapp' });
  assert.ok((await rowOf(u.id)).game_track_left_at);
  assert.deepEqual(await leftWhy(u.id), [{ reason: 'message' }]);
});

test('asking what she can do ends it even mid-game; a thanks does not; gamesd down keeps them on', async () => {
  const thanks = await player();
  await open({ agentId: thanks.agent, messageId: mid(), kind: 'text', thanks: true });
  await context({ agentId: thanks.agent });
  assert.equal((await rowOf(thanks.id)).game_track_left_at, null);

  const down = await player();
  nights = { ok: false, error: 'unreachable' };
  await open({ agentId: down.agent, messageId: mid(), kind: 'text' });
  await context({ agentId: down.agent });
  assert.equal((await rowOf(down.id)).game_track_left_at, null);

  const curious = await player();
  nights = { ok: true, nights: [{ status: 'open' }] };
  await open({ agentId: curious.agent, messageId: mid(), kind: 'text', abilities: true });
  await context({ agentId: curious.agent });
  assert.deepEqual(await leftWhy(curious.id), [{ reason: 'abilities' }]);
});
