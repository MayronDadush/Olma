'use strict';
// The dashboard's sign-in. These tests are mostly about what is NOT in the
// database and what a second caller does NOT get.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const auth = require('../src/domain/dashboard-auth');

let db, me;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531910001', { firstName: 'Miron' });
});
after(async () => { if (db) await db.teardown(); });

const tx = (fn) => withTx(db.pool, fn);
const newLink = async (uid = me.id) => {
  const r = await tx((c) => auth.createLink(c, uid));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.token;
};
const openSession = async (uid = me.id) => {
  const token = await newLink(uid);
  const r = await tx((c) => auth.redeemLink(c, token));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.sessionId;
};

test('the raw token is never stored — only its sha256', async () => {
  const token = await newLink();
  const { rows } = await db.pool.query(`SELECT token_hash FROM magic_links WHERE user_id = $1`, [me.id]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, 'the token itself is in the table');
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('a link opens exactly once, however many callers race for it', async () => {
  const token = await newLink();
  // Sequential rather than concurrent on purpose: the guard being tested is
  // `used_at IS NULL` inside the UPDATE, and a second COMMITTED attempt is the
  // strictest version of the race — it cannot be won by lock ordering.
  const first = await tx((c) => auth.redeemLink(c, token));
  const second = await tx((c) => auth.redeemLink(c, token));
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'a spent link opened a second session');
  assert.equal(second.error.code, 'not_found');
});

test('peeking at a link does not spend it — the WhatsApp preview rule', async () => {
  const token = await newLink();
  const peek = await tx((c) => auth.peekLink(c, token));
  assert.equal(peek.ok, true);
  assert.equal(peek.data.firstName, 'Miron');
  const used = await tx((c) => auth.redeemLink(c, token));
  assert.equal(used.ok, true, 'a link the crawler merely looked at was burned');
});

test('minting a new link kills the person\'s previous one', async () => {
  const old = await newLink();
  await newLink();
  const r = await tx((c) => auth.redeemLink(c, old));
  assert.equal(r.ok, false);
});

test('an expired link is not_found, not an error the page can retry past', async () => {
  const token = await newLink();
  await db.pool.query(`UPDATE magic_links SET expires_at = now() - interval '1 minute'`);
  const r = await tx((c) => auth.redeemLink(c, token));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
});

test('a malformed token never reaches the database as a comparison', async () => {
  for (const bad of ['', 'x', "' OR 1=1 --", 'A'.repeat(64), 'f'.repeat(63)]) {
    const r = await tx((c) => auth.redeemLink(c, bad));
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the session cookie is stored hashed too, not just the link', async () => {
  const token = await newLink();
  const r = await tx((c) => auth.redeemLink(c, token));
  const { rows } = await db.pool.query(`SELECT id FROM dashboard_sessions WHERE user_id = $1`, [me.id]);
  assert.equal(rows.some((x) => x.id === r.data.sessionId), false, 'the cookie value itself is in the table');
  assert.equal(rows.some((x) => x.id === crypto.createHash('sha256').update(r.data.sessionId).digest('hex')), true);
});

test('a live session resolves, and resolving keeps it alive', async () => {
  const sid = await openSession();
  await db.pool.query(`UPDATE dashboard_sessions SET last_seen_at = now() - interval '3 days'`);
  const r = await tx((c) => auth.resolveSession(c, sid));
  assert.equal(r.ok, true);
  assert.equal(String(r.data.userId), String(me.id));
  const { rows } = await db.pool.query(
    `SELECT extract(epoch from now() - last_seen_at) AS age FROM dashboard_sessions WHERE id = $1`,
    [crypto.createHash('sha256').update(sid).digest('hex')]);
  assert.ok(Number(rows[0].age) < 5, 'resolving did not touch last_seen_at');
});

test('an idle session dies, and so does a very old busy one', async () => {
  const sid = await openSession();
  await db.pool.query(`UPDATE dashboard_sessions SET last_seen_at = now() - interval '400 days'`);
  assert.equal((await tx((c) => auth.resolveSession(c, sid))).ok, false, 'idle session still open');

  const sid2 = await openSession();
  // Touched five minutes ago, but opened a year ago: the absolute cap is the
  // only thing that can end a session somebody keeps warm forever.
  await db.pool.query(
    `UPDATE dashboard_sessions SET created_at = now() - interval '400 days', last_seen_at = now() - interval '5 minutes'
      WHERE id = $1`, [crypto.createHash('sha256').update(sid2).digest('hex')]);
  assert.equal((await tx((c) => auth.resolveSession(c, sid2))).ok, false, 'a session outlived the absolute cap');
});

test('blocking someone closes the tab they left open', async () => {
  const other = await makeUser(db.pool, '+972531910002', { firstName: 'Gali' });
  const sid = await openSession(other.id);
  assert.equal((await tx((c) => auth.resolveSession(c, sid))).ok, true);
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [other.id]);
  assert.equal((await tx((c) => auth.resolveSession(c, sid))).ok, false,
    'a blocked user kept a working session');
});

test('the eval user can neither be linked nor stay signed in', async () => {
  const ev = await makeUser(db.pool, '+972599999002', { firstName: 'Eval' });
  const sid = await openSession(ev.id);
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [ev.id]);
  assert.equal((await tx((c) => auth.resolveSession(c, sid))).ok, false);
  assert.equal((await tx((c) => auth.createLink(c, ev.id))).ok, false);
});

test('signing out ends this session and nothing else', async () => {
  const a = await openSession();
  const b = await openSession();
  await tx((c) => auth.endSession(c, a));
  assert.equal((await tx((c) => auth.resolveSession(c, a))).ok, false);
  assert.equal((await tx((c) => auth.resolveSession(c, b))).ok, true, 'signing out on one device signed out another');
  await tx((c) => auth.endAllSessions(c, me.id));
  assert.equal((await tx((c) => auth.resolveSession(c, b))).ok, false);
});

test('the cookie is HttpOnly, Secure and SameSite=Lax, and round-trips', async () => {
  const sid = 'a'.repeat(64);
  const h = auth.cookieHeader(sid);
  for (const bit of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
    assert.ok(h.includes(bit), `cookie is missing ${bit}`);
  }
  assert.equal(auth.readCookie('other=1; ' + h.split(';')[0] + '; x=2'), sid);
  assert.equal(auth.readCookie('olma_dash=nothex'), null);
  assert.equal(auth.readCookie(''), null);
  assert.ok(auth.clearCookieHeader().includes('Max-Age=0'));
});

test('purge removes what nobody can use, and leaves live rows alone', async () => {
  await db.pool.query(`DELETE FROM magic_links; DELETE FROM dashboard_sessions`);
  const liveToken = await newLink();
  const liveSid = await openSession((await makeUser(db.pool, '+972531910003')).id);
  await db.pool.query(
    `INSERT INTO magic_links (token_hash, user_id, expires_at)
     VALUES ('dead', $1, now() - interval '3 days')`, [me.id]);
  await db.pool.query(
    `INSERT INTO dashboard_sessions (id, user_id, created_at, last_seen_at)
     VALUES ('deadsession', $1, now() - interval '400 days', now() - interval '400 days')`, [me.id]);
  const r = await tx((c) => auth.purgeExpired(c));
  assert.equal(r.data.links >= 1, true);
  assert.equal(r.data.sessions >= 1, true);
  assert.equal((await tx((c) => auth.peekLink(c, liveToken))).ok, true, 'purge ate a live link');
  assert.equal((await tx((c) => auth.resolveSession(c, liveSid))).ok, true, 'purge ate a live session');
});
