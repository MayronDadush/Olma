'use strict';
// brokerd's `identity_resolve` — how a pack's server (games/, game nights)
// learns who a token belongs to and which packs they have — and the
// user_packs table it reads (migration 100). Stage 2 ships every pack hidden,
// so the cases that matter are the refusals and the empty list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { createBrokerServer } = require('../src/brokerd/server');
const toolPolicy = require('../src/intake/agent-tool-policy');

let db, broker, now;
before(async () => {
  db = await freshDb();
  now = Date.now();
  broker = createBrokerServer({ pool: db.pool, placeMark: () => ({ attempted: false }), now: () => now });
});
after(async () => { await db.teardown(); });

let seq = 0;
async function agentUser(extra = {}) {
  seq += 1;
  const u = await makeUser(db.pool, `+9726431${String(seq).padStart(4, '0')}`, { firstName: 'דנה', ...extra });
  await db.pool.query('UPDATE users SET agent_id = $2 WHERE id = $1', [u.id, `u-${970 + seq}`]);
  return { ...u, agentId: `u-${970 + seq}` };
}
const resolve = (token, caller = 'games') =>
  broker.dispatch({ id: 1, method: 'identity_resolve', params: { token, caller } });
const lastAuthFail = async () => (await db.pool.query(
  `SELECT detail FROM audit_log WHERE event = 'auth.failed' ORDER BY id DESC LIMIT 1`)).rows[0];

test('a person\'s token resolves to who they are and no packs, and nothing that identifies them further', async () => {
  const u = await agentUser();
  const out = await resolve(u.identity_token);
  assert.equal(out.ok, true);
  assert.deepEqual(out.packs, [], 'stage 2: nobody has a pack');
  assert.equal(out.user.id, Number(u.id));
  assert.equal(out.user.name, 'דנה');
  assert.equal(out.user.locale, 'he');
  assert.ok('timezone' in out.user);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(u.phone), 'never the phone');
  assert.ok(!text.includes(u.identity_token), 'never the token');
});

test('a pack row is handed back, and the policy reader sees the same row', async () => {
  const u = await agentUser();
  await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'games', 'owner')`, [u.id]);
  assert.deepEqual((await resolve(u.identity_token)).packs, ['games']);
  const packs = await toolPolicy.packsByAgent(db.pool);
  assert.deepEqual(packs.get(u.agentId), ['games']);
  // A pack the table does not know is refused by the CHECK, not stored.
  await assert.rejects(db.pool.query(
    `INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'poker', 'owner')`, [u.id]));
  // Deleting the person takes the row with them.
  await db.pool.query('DELETE FROM users WHERE id = $1', [u.id]);
  assert.equal((await toolPolicy.packsByAgent(db.pool)).has(u.agentId), false);
});

test('an unknown, malformed, group or blocked token is refused and audited, with the shim\'s own wording', async () => {
  const unknown = await resolve('olma_tok_' + '0'.repeat(32));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'forbidden');
  assert.match(unknown.error.message, /unknown identity token/, 'the games shim self-heals on this exact text');
  assert.equal((await lastAuthFail()).detail.tool, 'games:identity_resolve');

  assert.match((await resolve('')).error.message, /missing identity token/);
  assert.match((await resolve(undefined)).error.message, /missing identity token/);
  assert.equal((await resolve('olma_grp_' + 'a'.repeat(32))).ok, false, 'a room holds no pack');

  const b = await agentUser();
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [b.id]);
  assert.equal((await resolve(b.identity_token)).ok, false);
});

test('a resolve with a pack counts as a tool having run, so the "רשמתי" after it is backed', async () => {
  const u = await agentUser();
  await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'games', 'owner')`, [u.id]);
  await broker.dispatch({ id: 1, method: 'turn_open', params: { agentId: u.agentId, messageId: '3EBGAMES0001', kind: 'text' } });
  now += 2000;
  await resolve(u.identity_token);
  now += 2000;
  const out = await broker.dispatch({ id: 1, method: 'reply_claim', params: { agentId: u.agentId, word: 'רשמתי' } });
  assert.deepEqual(out, { ok: true, verdict: 'backed' });
});
