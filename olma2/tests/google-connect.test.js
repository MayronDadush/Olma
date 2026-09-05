'use strict';
// The combined calendar+contacts+mail consent flow (domain/google-connect.js):
// one link, one code exchange, up to three integrations rows. Same
// no-network philosophy as calendar.test.js — every Google call is injected.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-gcn-'));
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
const flags = require('../src/domain/flags');
const googleConnect = require('../src/domain/google-connect');
const calendar = require('../src/domain/calendar');
const googleContacts = require('../src/domain/google-contacts');

let db, user, server;

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

const tokenOk = (scope) => ({
  body: {
    access_token: 'ya29.fake-access-token',
    refresh_token: '1//fake-refresh-token',
    expires_in: 3600,
    scope,
    ...{},
  },
});
const userInfo = { body: { email: 'someone@example.com' } };
const ALL_SCOPES = 'https://www.googleapis.com/auth/calendar.events '
  + 'https://www.googleapis.com/auth/contacts.readonly '
  + 'https://www.googleapis.com/auth/gmail.readonly '
  + 'https://www.googleapis.com/auth/userinfo.email';

async function connect(userId, { calendarAccess, wantContacts, wantMail, routes, code = 'auth-code' } = {}) {
  const u = { id: userId, role: 'user', phone: '+972631900099' };
  const begun = await withTx(db.pool, (c) => googleConnect.beginConnection(c, u, { calendarAccess, wantContacts, wantMail }));
  assert.ok(begun.ok, 'beginConnection failed: ' + JSON.stringify(begun.error));
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch(routes || {
    'oauth2.googleapis.com/token': tokenOk(ALL_SCOPES),
    'oauth2/v2/userinfo': userInfo,
    'oauth2.googleapis.com/revoke': { body: {} },
  });
  const done = await withTx(db.pool, (c) => googleConnect.completeOAuth(c, { state, code }, { fetchImpl }));
  return { state, done, fetchImpl, url: begun.data.url, begun };
}

function integrationRow(userId, provider) {
  return db.pool.query(
    `SELECT * FROM integrations WHERE user_id = $1 AND provider = $2`, [userId, provider]
  ).then((r) => r.rows[0]);
}

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972631900010', { firstName: 'Noa' });
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => { server.close(); await db.teardown(); });

// ---- consent --------------------------------------------------------------

test('asking for nothing at all is refused before any state is written', async () => {
  const u = { id: user.id, role: 'user', phone: user.phone };
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, u, {}));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
});

test('the consent link unions exactly the requested scopes, plus userinfo.email once', async () => {
  const u = { id: user.id, role: 'user', phone: user.phone };
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, u, { calendarAccess: 'read_write', wantContacts: true }));
  assert.ok(res.ok);
  const scope = new URL(res.data.url).searchParams.get('scope');
  assert.ok(scope.includes('calendar.events'));
  assert.ok(scope.includes('contacts.readonly'));
  assert.ok(!scope.includes('gmail.readonly'), 'mail was not requested');
  assert.equal(scope.split('userinfo.email').length - 1, 1, 'userinfo.email must appear exactly once');
});

test('mail is gated by the same email_access_phones flag as start_email_connection', async () => {
  const closedUser = await makeUser(db.pool, '+972631900011', { firstName: 'Guy' });
  const u = { id: closedUser.id, role: 'user', phone: closedUser.phone };
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, u, { wantMail: true }));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_enabled');
});

test('an admin reaches mail even while the flag is closed for everyone else', async () => {
  const admin = await makeUser(db.pool, '+972631900012', { firstName: 'Admin', role: 'admin' });
  const u = { id: admin.id, role: 'admin', phone: admin.phone };
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, u, { wantMail: true }));
  assert.ok(res.ok);
});

// ---- completeOAuth: full grant ---------------------------------------------

test('granting everything asked for writes three integrations rows from ONE token', async () => {
  const u = await makeUser(db.pool, '+972631900020', { firstName: 'Shir' });
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', 'all'));
  const { done, fetchImpl } = await connect(u.id, { calendarAccess: 'read_write', wantContacts: true, wantMail: true });
  assert.ok(done.ok, JSON.stringify(done.error));
  assert.equal(done.data.missing.length, 0);
  assert.equal(done.data.connected.calendar, 'read_write');
  assert.equal(done.data.connected.contacts, true);
  assert.equal(done.data.connected.mail, true);

  const cal = await integrationRow(u.id, 'google_calendar');
  const contacts = await integrationRow(u.id, 'google_contacts');
  const gmail = await integrationRow(u.id, 'gmail');
  assert.ok(cal && contacts && gmail);
  assert.equal(cal.access_level, 'read_write');
  assert.equal(contacts.access_level, 'read_only');
  assert.equal(gmail.access_level, 'read_only');

  // Exactly one code exchange for all three — never three separate ones.
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('oauth2.googleapis.com/token'));
  assert.equal(tokenCalls.length, 1);

  const outboxKinds = (await db.pool.query(
    `SELECT kind FROM outbox WHERE user_id = $1 ORDER BY id`, [u.id]
  )).rows.map((r) => r.kind);
  assert.deepEqual(outboxKinds.sort(), ['calendar_connected', 'contacts_connected', 'email_connected'].sort());
});

// ---- completeOAuth: partial grant -------------------------------------------

test('a partially-ticked consent connects what was granted and reports the rest as missing, without touching the token', async () => {
  const u = await makeUser(db.pool, '+972631900021', { firstName: 'Idan' });
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', 'all'));
  const partialScope = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email';
  const { done, fetchImpl } = await connect(u.id, {
    calendarAccess: 'read_write', wantContacts: true, wantMail: true,
    routes: { 'oauth2.googleapis.com/token': tokenOk(partialScope), 'oauth2/v2/userinfo': userInfo },
  });
  assert.ok(done.ok);
  assert.equal(done.data.connected.calendar, 'read_only', 'Google narrowed it — the grant Google returned wins, not what was asked');
  assert.equal(done.data.connected.contacts, false);
  assert.equal(done.data.connected.mail, false);
  assert.deepEqual(done.data.missing.sort(), ['contacts', 'mail']);

  assert.ok(await integrationRow(u.id, 'google_calendar'));
  assert.equal(await integrationRow(u.id, 'google_contacts'), undefined);
  assert.equal(await integrationRow(u.id, 'gmail'), undefined);

  // Calendar still works, so the shared token must NOT have been revoked.
  const revokeCalls = fetchImpl.calls.filter((c) => c.url.includes('revoke'));
  assert.equal(revokeCalls.length, 0);

  const kinds = (await db.pool.query(`SELECT kind, payload FROM outbox WHERE user_id = $1 ORDER BY id`, [u.id])).rows;
  assert.ok(kinds.some((r) => r.kind === 'calendar_connected'));
  const incomplete = kinds.find((r) => r.kind === 'google_connect_incomplete');
  assert.ok(incomplete, 'the missing pieces must produce their own notice');
  assert.deepEqual(incomplete.payload.missing.sort(), ['contacts', 'mail']);
});

// ---- completeOAuth: total failure -------------------------------------------

test('nothing granted at all revokes the token and stores nothing', async () => {
  const u = await makeUser(db.pool, '+972631900022', { firstName: 'Maya' });
  const bareScope = 'https://www.googleapis.com/auth/userinfo.email';
  const { done, fetchImpl } = await connect(u.id, {
    calendarAccess: 'read_only', wantContacts: true,
    routes: { 'oauth2.googleapis.com/token': tokenOk(bareScope), 'oauth2.googleapis.com/revoke': { body: {} } },
  });
  assert.equal(done.ok, false);
  assert.equal(done.error.reason, 'no_scope_granted');
  assert.equal(await integrationRow(u.id, 'google_calendar'), undefined);
  assert.equal(await integrationRow(u.id, 'google_contacts'), undefined);
  const revokeCalls = fetchImpl.calls.filter((c) => c.url.includes('revoke'));
  assert.equal(revokeCalls.length, 1, 'a token that grants nothing usable must not be left alive at Google');
});

test('declining at the consent screen burns the state and exchanges nothing', async () => {
  const u = await makeUser(db.pool, '+972631900023', { firstName: 'Ben' });
  const uArg = { id: u.id, role: 'user', phone: u.phone };
  const begun = await withTx(db.pool, (c) => googleConnect.beginConnection(c, uArg, { calendarAccess: 'read_only' }));
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch({});
  const done = await withTx(db.pool, (c) => googleConnect.completeOAuth(c, { state, error: 'access_denied' }, { fetchImpl }));
  assert.equal(done.ok, false);
  assert.equal(done.error.reason, 'declined');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a burned state cannot be replayed', async () => {
  const u = await makeUser(db.pool, '+972631900024', { firstName: 'Liron' });
  const { state } = await connect(u.id, { calendarAccess: 'read_only' });
  const fetchImpl = fakeFetch({});
  const replay = await withTx(db.pool, (c) => googleConnect.completeOAuth(c, { state, code: 'auth-code' }, { fetchImpl }));
  assert.equal(replay.ok, false);
  assert.equal(replay.error.reason, 'bad_state');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a state minted for the combined flow cannot be redeemed by the single-purpose calendar completer, or vice versa', async () => {
  const u = await makeUser(db.pool, '+972631900025', { firstName: 'Ori' });
  const uArg = { id: u.id, role: 'user', phone: u.phone };
  const begun = await withTx(db.pool, (c) => googleConnect.beginConnection(c, uArg, { calendarAccess: 'read_only' }));
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch({});
  const crossed = await withTx(db.pool, (c) => calendar.completeOAuth(c, { state, code: 'x' }, { fetchImpl }));
  assert.equal(crossed.ok, false);
  assert.equal(crossed.error.reason, 'bad_state');
  assert.equal(fetchImpl.calls.length, 0);
});

// ---- disconnect keeps siblings alive ---------------------------------------

test('disconnecting calendar after a combined connect does NOT revoke the token that contacts and mail still use', async () => {
  const u = await makeUser(db.pool, '+972631900030', { firstName: 'Tom' });
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', 'all'));
  await connect(u.id, { calendarAccess: 'read_write', wantContacts: true, wantMail: true });

  const fetchImpl = fakeFetch({ 'oauth2.googleapis.com/revoke': { body: {} } });
  const res = await withTx(db.pool, (c) => calendar.disconnect(c, u.id, { fetchImpl }));
  assert.ok(res.ok);
  assert.equal(res.data.revokedAtGoogle, false, 'contacts and mail still hold the same token');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(await integrationRow(u.id, 'google_calendar'), undefined, 'the row itself is still removed locally');
  assert.ok(await integrationRow(u.id, 'google_contacts'), 'the sibling must be untouched');
  assert.ok(await integrationRow(u.id, 'gmail'), 'the sibling must be untouched');
});

test('disconnecting the LAST sibling finally revokes at Google', async () => {
  const u = await makeUser(db.pool, '+972631900031', { firstName: 'Yael' });
  await connect(u.id, { calendarAccess: 'read_write', wantContacts: true });

  const fetchImpl1 = fakeFetch({ 'oauth2.googleapis.com/revoke': { body: {} } });
  const first = await withTx(db.pool, (c) => calendar.disconnect(c, u.id, { fetchImpl: fetchImpl1 }));
  assert.equal(first.data.revokedAtGoogle, false, 'contacts still holds it');

  const fetchImpl2 = fakeFetch({ 'oauth2.googleapis.com/revoke': { body: {} } });
  const second = await withTx(db.pool, (c) => googleContacts.disconnect(c, u.id, { fetchImpl: fetchImpl2 }));
  assert.equal(second.data.revokedAtGoogle, true, 'the last one standing must actually revoke');
  assert.equal(fetchImpl2.calls.length, 1);
});

test('a solo calendar connection (never combined) still revokes exactly as before', async () => {
  const u = await makeUser(db.pool, '+972631900032', { firstName: 'Adi' });
  const begun = await withTx(db.pool, (c) => calendar.beginConnection(c, u.id, 'read_write'));
  const state = new URL(begun.data.url).searchParams.get('state');
  const fetchImpl = fakeFetch({
    'oauth2.googleapis.com/token': tokenOk('https://www.googleapis.com/auth/calendar.events'),
    'calendars/primary': userInfo, 'oauth2/v2/userinfo': userInfo,
  });
  await withTx(db.pool, (c) => calendar.completeOAuth(c, { state, code: 'auth-code' }, { fetchImpl }));

  const revokeFetch = fakeFetch({ 'oauth2.googleapis.com/revoke': { body: {} } });
  const res = await withTx(db.pool, (c) => calendar.disconnect(c, u.id, { fetchImpl: revokeFetch }));
  assert.equal(res.data.revokedAtGoogle, true);
  assert.equal(revokeFetch.calls.length, 1);
});

// ---- dashboard callback dispatch -------------------------------------------

test('the OAuth callback routes a google_connect state to the combined domain', async () => {
  const u = await makeUser(db.pool, '+972631900040', { firstName: 'Nir' });
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', 'all'));
  const uArg = { id: u.id, role: 'user', phone: u.phone };
  const begun = await withTx(db.pool, (c) => googleConnect.beginConnection(c, uArg, { calendarAccess: 'read_write', wantContacts: true }));
  const state = new URL(begun.data.url).searchParams.get('state');

  const calendarDomain = { PROVIDER: calendar.PROVIDER, completeOAuth: async () => { throw new Error('must not be called'); } };
  const s2 = createDashboard({
    pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123',
    calendarDomain,
    googleOpts: { fetchImpl: fakeFetch({
      'oauth2.googleapis.com/token': tokenOk(
        'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/contacts.readonly'),
      'oauth2/v2/userinfo': userInfo,
    }) },
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const res = await fetch(`${b2}/oauth/google/callback?state=${state}&code=auth-code`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('החיבור לגוגל הושלם'));
  s2.close();
});

// ---- tool registry ----------------------------------------------------------

test('start_google_connection exists and never guesses calendar access', () => {
  const { toolDefinitions } = require('../src/adapters/mcp/registry');
  const defs = toolDefinitions();
  const t = defs.find((d) => d.name === 'start_google_connection');
  assert.ok(t, 'start_google_connection is not registered');
  assert.ok(/ASK FIRST/.test(t.description) || /ask which/i.test(t.description));
  assert.equal(t.inputSchema.required.filter((r) => r !== 'identity' && !/token|identity/i.test(r)).length, 0,
    'none of calendar_access/contacts/mail should be forced required — a user may want just one');
});

// ---- outbox delivery instructions -------------------------------------------

test('the delivery instruction exists for a partially-granted combined connect', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  const text = instructionFor({ kind: 'google_connect_incomplete', payload: { connected: ['יומן (צפייה + עריכה)'], missing: ['contacts', 'mail'] } });
  assert.ok(text && !text.includes('System update for the user'));
  assert.ok(/start_google_connection/.test(text));
});
