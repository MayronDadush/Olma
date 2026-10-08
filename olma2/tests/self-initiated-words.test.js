'use strict';
// A turn Olma started passes nobody's words (2026-09-28). A `stalled_goal`
// check-in told the model to ask its reader one question; it messaged a
// connection directly instead, in the reader's name, with a day it had
// assumed. The tools that pass words to somebody else refuse inside such a
// turn — unless the person has written since it began, because inside the
// grace minute a real reply is theirs. Same guard as the answer-writing
// tools (tests/self-initiated-answers.test.js), from src/adapters/mcp/our-turn.js.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const selfInitiated = require('../src/domain/self-initiated');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
afterEach(() => selfInitiated._reset());

const tx = (fn) => withTx(db.pool, fn);
const TOOLS_DIR = path.join(__dirname, '../src/adapters/mcp/tools');
const find = (name) => require('../src/adapters/mcp/registry').TOOLS.find((t) => t.name === name);
const call = (name, user, args) => tx((c) => find(name).handler(c, user, args, {}));

let seq = 0;
async function pair() {
  seq += 1;
  const a = await makeUser(db.pool, `+97253397${String(seq).padStart(2, '0')}01`, { firstName: 'Ann' });
  const b = await makeUser(db.pool, `+97253397${String(seq).padStart(2, '0')}02`, { firstName: 'Ben' });
  const { rows } = await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [a.id, b.id, b.phone]);
  for (const g of [a, b]) {
    await db.pool.query(
      `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature) VALUES ($1, $2, 'messages')`,
      [rows[0].id, g.id]);
  }
  await db.pool.query(`UPDATE users SET last_woke_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
  return { a, b };
}

const relayed = async (b) => Number((await db.pool.query(
  `SELECT count(*) FROM outbox WHERE user_id = $1 AND kind = 'relayed_message'`, [b.id])).rows[0].count);

test('inside a turn Olma started, nothing is passed on in their name', async () => {
  const { a, b } = await pair();
  selfInitiated.begin(a.id);
  const res = await call('send_message_to_connection', a, { phone: b.phone, message: 'מחר בשלוש?' });
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_their_turn');
  assert.match(res.error.message, /ask THEM/);
  assert.equal(await relayed(b), 0, 'nothing reached the other person');

  // The room door refuses before it looks at the meeting at all.
  const room = await call('relay_to_group', a, { meeting_id: 999999, what: 'אני מאחר' });
  assert.equal(room.error.reason, 'not_their_turn');
});

test('they wrote after the delivery began: the words are theirs, and outside any mark nothing changes', async () => {
  const { a, b } = await pair();
  selfInitiated.begin(a.id);
  await new Promise((r) => setTimeout(r, 5));
  await db.pool.query(`UPDATE users SET last_woke_at = now() WHERE id = $1`, [a.id]);
  const theirs = await call('send_message_to_connection', a, { phone: b.phone, message: 'מחר בשלוש?' });
  assert.equal(theirs.ok, true, theirs.ok ? '' : JSON.stringify(theirs.error));
  assert.equal(await relayed(b), 1);

  selfInitiated._reset();
  await db.pool.query(`UPDATE users SET last_woke_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
  const plain = await call('send_message_to_connection', a, { phone: b.phone, message: 'ועוד משהו' });
  assert.equal(plain.ok, true, plain.ok ? '' : JSON.stringify(plain.error));
  assert.equal(await relayed(b), 2);
});

// A tool that reaches a relay function without the guard is the next u-11.
// Scanned across every slice, so a new door in a new file is caught too.
test('every tool that passes words to somebody else is behind the guard', () => {
  const PASSES = /relay\.relayMessage|relayToRoom\(/;
  const guarded = new Set();
  let seen = 0;
  for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    if (!PASSES.test(src)) continue;
    const tools = require(path.join(TOOLS_DIR, file));
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      const at = src.indexOf(`tool('${t.name}'`);
      if (at === -1) continue;
      const next = src.indexOf("\n  tool('", at + 1);
      const body = src.slice(at, next === -1 ? src.length : next);
      if (!PASSES.test(body)) continue;
      seen += 1;
      assert.ok(t.speaksFor, `${t.name} (${file}) passes words on and is not in SPEAKS_FOR`);
      guarded.add(t.name);
    }
  }
  assert.ok(seen >= 2, 'the scan found the two known doors');
  assert.ok(guarded.has('send_message_to_connection') && guarded.has('relay_to_group'));
});
