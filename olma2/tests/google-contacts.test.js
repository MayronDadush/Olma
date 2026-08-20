'use strict';
// Google Contacts import: consent, token lifecycle, the public callback's
// provider dispatch, and paginated import. Same no-network philosophy as
// calendar.test.js — every Google call is an injected fake.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-gc-'));
process.env.OLMA_ENC_KEY_PATH = path.join(TMP, 'enc-key');
process.env.OLMA_GOOGLE_OAUTH_PATH = path.join(TMP, 'google-oauth.json');
fs.writeFileSync(process.env.OLMA_GOOGLE_OAUTH_PATH, JSON.stringify({
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  public_base_url: 'https://olmachat.example',
}));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const cryptoStore = require('../src/domain/crypto-store');
const googleContacts = require('../src/domain/google-contacts');
const calendar = require('../src/domain/calendar');
const contacts = require('../src/domain/contacts');

let db, user, server, base;
const AUTH = 'Basic ' + Buffer.from('admin:test-password-123').toString('base64');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [fragment, responder] of Object.entries(routes)) {
      if (String(url).includes(fragment)) {
        const r = typeof responder === 'function' ? await responder(url, init) : responder;
        return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body || {} };
      }
    }
    throw new Error(`unexpected outbound call: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const tokenOk = (over = {}) => ({
  body: {
    access_token: 'ya29.fake-access-token',
    refresh_token: '1//fake-refresh-token',
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/userinfo.email',
    ...over,
  },
});
const userInfo = { body: { email: 'someone@example.com' } };

async function connect(userId, { routes } = {}) {
  const begun = await withTx(db.pool, (c) => googleContacts.beginConnection(c, userId));
  assert.ok(begun.ok, 'beginConnection failed');
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch(routes || {
    'oauth2.googleapis.com/token': tokenOk(),
    'oauth2/v2/userinfo': userInfo,
    'oauth2.googleapis.com/revoke': { body: {} },
  });
  const done = await withTx(db.pool, (c) => googleContacts.completeOAuth(c, { state, code: 'auth-code' }, { fetchImpl }));
  return { state, done, fetchImpl, url: begun.data.url };
}

function integrationRow(userId) {
  return db.pool.query(
    `SELECT * FROM integrations WHERE user_id = $1 AND provider = 'google_contacts'`, [userId]
  ).then((r) => r.rows[0]);
}

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972631200001', { firstName: 'Dana' });
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });

// ---- consent ------------------------------------------------------------

test('the consent link requests exactly the contacts.readonly scope, always read_only', async () => {
  const begun = await withTx(db.pool, (c) => googleContacts.beginConnection(c, user.id));
  assert.ok(begun.ok);
  const scope = new URL(begun.data.url).searchParams.get('scope');
  assert.match(scope, /contacts\.readonly\b/);
  assert.doesNotMatch(scope, /calendar/, 'a contacts consent must never carry a calendar scope');
  const { rows } = await db.pool.query(`SELECT requested_access, provider FROM oauth_states WHERE state = $1`,
    [new URL(begun.data.url).searchParams.get('state')]);
  assert.equal(rows[0].provider, 'google_contacts');
  assert.equal(rows[0].requested_access, 'read_only');
});

test('a completed consent stores an encrypted token and notifies through the outbox', async () => {
  const u = await makeUser(db.pool, '+972631200002', { firstName: 'Yael' });
  const { done } = await connect(u.id);
  assert.ok(done.ok);
  const row = await integrationRow(u.id);
  assert.equal(row.status, 'connected');
  assert.equal(row.access_level, 'read_only');
  assert.equal(cryptoStore.decrypt(row.credential_enc), 'ya29.fake-access-token');
  const { rows: out } = await db.pool.query(
    `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'contacts_connected'`, [u.id]);
  assert.equal(out.length, 1);
});

test('a consent with NO contacts scope at all is refused, revoked, and explained — never stored', async () => {
  const u = await makeUser(db.pool, '+972631200003', { firstName: 'Gali' });
  const { done, fetchImpl } = await connect(u.id, {
    routes: {
      // Exactly the live D-024 checkbox trap, reproduced for contacts: the
      // exchange succeeds but only email/openid was actually ticked.
      'oauth2.googleapis.com/token': tokenOk({ scope: 'https://www.googleapis.com/auth/userinfo.email openid' }),
      'oauth2.googleapis.com/revoke': { body: {} },
    },
  });
  assert.equal(done.ok, false);
  assert.equal(done.error.reason, 'no_contacts_scope');
  assert.equal(await integrationRow(u.id), undefined, 'a scope-less token must never be stored');
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/revoke')), 'the useless grant must be revoked at Google');
  const { rows: out } = await db.pool.query(
    `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'contacts_scope_missing'`, [u.id]);
  assert.equal(out.length, 1);
  const { rows: aud } = await db.pool.query(
    `SELECT * FROM audit_log WHERE actor_id = $1 AND event = 'contacts.auth_incomplete'`, [u.id]);
  assert.equal(aud.length, 1);
});

test('declining at the consent screen burns the state and exchanges nothing', async () => {
  const u = await makeUser(db.pool, '+972631200004', { firstName: 'Roni' });
  const begun = await withTx(db.pool, (c) => googleContacts.beginConnection(c, u.id));
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch({});
  const res = await withTx(db.pool, (c) => googleContacts.completeOAuth(c, { state, error: 'access_denied' }, { fetchImpl }));
  assert.equal(res.error.reason, 'declined');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- callback provider dispatch ------------------------------------------
// The one shared route (/oauth/google/callback) must send a google_contacts
// state to THIS module and a google_calendar state to calendar.js — a
// regression here would silently break whichever provider goes untested.

test('the callback dispatches by the state\'s own provider, not the URL', async () => {
  const contactsUser = await makeUser(db.pool, '+972631200005', { firstName: 'Contacts' });
  const calendarUser = await makeUser(db.pool, '+972631200006', { firstName: 'Calendar' });

  const cBegun = await withTx(db.pool, (c) => googleContacts.beginConnection(c, contactsUser.id));
  const calBegun = await withTx(db.pool, (c) => calendar.beginConnection(c, calendarUser.id, 'read_only'));

  const httpServer = createDashboard({
    pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123',
    googleOpts: { fetchImpl: fakeFetch({
      'oauth2.googleapis.com/token': tokenOk({
        scope: 'https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email',
      }),
      'calendars/primary': { body: { id: 'someone@example.com' } },
      'oauth2/v2/userinfo': userInfo,
    }) },
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    const cState = new URL(cBegun.data.url).searchParams.get('state');
    const calState = new URL(calBegun.data.url).searchParams.get('state');

    const cRes = await fetch(`${url}/oauth/google/callback?state=${encodeURIComponent(cState)}&code=a`);
    assert.match(await cRes.text(), /אנשי הקשר חוברו/);
    assert.ok(await integrationRow(contactsUser.id), 'contacts state must land in google_contacts');

    const calRes = await fetch(`${url}/oauth/google/callback?state=${encodeURIComponent(calState)}&code=b`);
    assert.match(await calRes.text(), /היומן חובר/);
    const { rows } = await db.pool.query(
      `SELECT * FROM integrations WHERE user_id = $1 AND provider = 'google_calendar'`, [calendarUser.id]);
    assert.equal(rows.length, 1, 'calendar dispatch must still work unchanged');
  } finally {
    httpServer.close();
  }
});

test('a stale/unknown state falls through to the existing bad_state page', async () => {
  const res = await fetch(`${base}/oauth/google/callback?state=nope&code=x`);
  assert.equal(res.status, 400);
});

// ---- importing -------------------------------------------------------------

test('importFromGoogle paginates, prefers canonicalForm, and lands rows via importContacts', async () => {
  const u = await makeUser(db.pool, '+972631200007', { firstName: 'Importer' });
  await connect(u.id);

  let calls = 0;
  const fetchImpl = fakeFetch({
    'people/me/connections': (url) => {
      calls++;
      if (!String(url).includes('pageToken')) {
        return { body: {
          connections: [
            { names: [{ displayName: 'דנה כהן' }], phoneNumbers: [{ canonicalForm: '+972541111111', type: 'mobile' }] },
          ],
          nextPageToken: 'page2',
        } };
      }
      return { body: {
        connections: [
          // No canonicalForm — falls back to raw value, still normalised downstream.
          { names: [{ displayName: 'עודד לוי' }], phoneNumbers: [{ value: '054-2222222', type: 'home' }] },
          { names: [], phoneNumbers: [{ value: '054-3333333' }] }, // no name at all — must be skipped, not crash
        ],
      } };
    },
  });
  const res = await withTx(db.pool, (c) => googleContacts.importFromGoogle(c, u.id, { fetchImpl }));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(calls, 2, 'both pages must be fetched');
  assert.equal(res.data.imported, 2);
  assert.equal(res.data.totalSeen, 2, 'the nameless entry never became an importContacts entry at all');

  const { rows } = await db.pool.query(
    `SELECT display_name, phone FROM user_contacts WHERE user_id = $1 ORDER BY display_name`, [u.id]);
  assert.deepEqual(rows.map((r) => r.phone).sort(), ['+972542222222', '+972541111111'].sort());
});

test('401 triggers exactly one refresh-and-retry', async () => {
  const u = await makeUser(db.pool, '+972631200008', { firstName: 'Retry' });
  await connect(u.id);
  let attempts = 0;
  const fetchImpl = fakeFetch({
    'oauth2.googleapis.com/token': tokenOk({ access_token: 'ya29.refreshed', refresh_token: undefined }),
    'people/me/connections': () => {
      attempts++;
      if (attempts === 1) return { status: 401, body: {} };
      return { body: { connections: [] } };
    },
  });
  const res = await withTx(db.pool, (c) => googleContacts.importFromGoogle(c, u.id, { fetchImpl }));
  assert.ok(res.ok);
  assert.equal(attempts, 2);
});

test('invalid_grant marks needs_reauth and nudges once', async () => {
  const u = await makeUser(db.pool, '+972631200009', { firstName: 'Dead' });
  await connect(u.id);
  await db.pool.query(`UPDATE integrations SET expires_at = now() - interval '1 hour' WHERE user_id = $1 AND provider = 'google_contacts'`, [u.id]);
  const fetchImpl = fakeFetch({ 'oauth2.googleapis.com/token': { status: 400, body: { error: 'invalid_grant' } } });
  const res = await withTx(db.pool, (c) => googleContacts.importFromGoogle(c, u.id, { fetchImpl }));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'needs_reauth');
  const row = await integrationRow(u.id);
  assert.equal(row.status, 'needs_reauth');
  const { rows: out } = await db.pool.query(
    `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'contacts_needs_reauth'`, [u.id]);
  assert.equal(out.length, 1);
});

test('disconnect revokes at Google but leaves the already-imported address book alone', async () => {
  const u = await makeUser(db.pool, '+972631200010', { firstName: 'Bye' });
  await connect(u.id);
  await withTx(db.pool, (c) => contacts.importContacts(c, u.id, [
    { name: 'נשאר', phones: [{ value: '054-4444444', type: 'mobile' }] },
  ], 'google'));

  const fetchImpl = fakeFetch({ 'oauth2.googleapis.com/revoke': { body: {} } });
  const res = await withTx(db.pool, (c) => googleContacts.disconnect(c, u.id, { fetchImpl }));
  assert.ok(res.ok);
  assert.equal(res.data.revokedAtGoogle, true);
  assert.equal(await integrationRow(u.id), undefined);

  const { rows } = await db.pool.query(`SELECT * FROM user_contacts WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1, 'disconnecting the sync must not delete anything already saved');
});
