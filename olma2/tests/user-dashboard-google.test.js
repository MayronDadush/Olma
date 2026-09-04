'use strict';
// The one provider on the dashboard with a real connection behind it.
//
// Everything on that screen used to be theatre: pressing "connect" span a
// spinner, drew a tick and toasted "connected to Google" without a single
// request leaving the browser. On a mockup that is the mockup working. On the
// page a person opened from a WhatsApp message it is the product claiming
// something it had not done, which is the one thing this codebase refuses to
// do anywhere else. So these are the routes that had to become real before the
// buttons were allowed to keep their animation.
//
// No network: the consent URL is built locally and nothing here exchanges a
// code. What is asserted is the SHAPE of what the browser is sent to — which
// scopes, for which services — because that is the part a person is agreeing
// to and the part a wrong payload would quietly change.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-udg-'));
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
const { perform } = require('../src/domain/user-dashboard-write');
const cryptoStore = require('../src/domain/crypto-store');

let db, me;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531920051', { firstName: 'מירון' });
});
after(async () => { if (db) await db.teardown(); });

const act = (action, payload) =>
  withTx(db.pool, (c) => perform(c, me.id, action, payload || {}));

// A connected service, without going through a code exchange. The secret is
// really encrypted because disconnect decrypts it to decide whether the token
// may be revoked at Google — a plaintext stub would take a different branch
// than production does.
async function connectService(provider, access) {
  await withTx(db.pool, (c) => c.query(
    `INSERT INTO integrations (user_id, provider, status, access_level, account_label,
                               credential_enc, refresh_enc, connected_at)
     VALUES ($1, $2, 'connected', $3, 'mayron@example.com', $4, $5, now())
     ON CONFLICT (user_id, provider) DO UPDATE SET status = 'connected'`,
    [me.id, provider, access || null,
      cryptoStore.encrypt('access-token'), cryptoStore.encrypt('refresh-token')]
  ));
}
const providers = async () => withTx(db.pool, async (c) => {
  const { rows } = await c.query(
    `SELECT provider FROM integrations WHERE user_id = $1 ORDER BY provider`, [me.id]);
  return rows.map((r) => r.provider);
});

test('one button, one consent screen, both services on it', async () => {
  // Calendar and contacts only. Gmail is allowlist-gated (mail.requireMailAccess)
  // and asking for it here would fail the WHOLE consent for everybody not on
  // that list — the button would refuse to open at all, for a service the page
  // was only ever offering as a bonus.
  const res = await act('startGoogle', { calendarAccess: 'read_write', contacts: true });
  assert.ok(res.ok, JSON.stringify(res.error));
  const url = new URL(res.data.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const scope = url.searchParams.get('scope');
  assert.match(scope, /calendar\.events/, 'no calendar write scope');
  assert.match(scope, /contacts\.readonly/, 'no contacts scope');
  // Three services, ONE state row — three would mean three Google screens for
  // a person who pressed one button.
  const states = await withTx(db.pool, async (c) => {
    const { rows } = await c.query(
      `SELECT state FROM oauth_states WHERE user_id = $1 AND used_at IS NULL`, [me.id]);
    return rows;
  });
  assert.equal(states.length, 1, `expected one pending consent, got ${states.length}`);
  assert.equal(url.searchParams.get('state'), states[0].state);
});

test('the read-only chip asks Google for a different grant, not a local setting', async () => {
  const rw = await act('startGoogle', { calendarAccess: 'read_write' });
  const ro = await act('startGoogle', { calendarAccess: 'read_only' });
  assert.ok(rw.ok && ro.ok);
  assert.match(new URL(rw.data.url).searchParams.get('scope'), /calendar\.events/);
  assert.match(new URL(ro.data.url).searchParams.get('scope'), /calendar\.readonly/);
  assert.doesNotMatch(new URL(ro.data.url).searchParams.get('scope'), /calendar\.events/,
    'read-only asked for write access anyway');
});

test('turning ONE service on asks for that scope and no others', async () => {
  const res = await act('startGoogle', { contacts: true });
  assert.ok(res.ok, JSON.stringify(res.error));
  const scope = new URL(res.data.url).searchParams.get('scope');
  assert.match(scope, /contacts\.readonly/);
  assert.doesNotMatch(scope, /calendar/, 'a contacts switch asked for the calendar too');
  assert.doesNotMatch(scope, /gmail/, 'a contacts switch asked for Gmail too');
});

// The one service on the Google row that is NOT ours to give yet. It has to
// come back as a refusal the page can say out loud, not as a consent screen
// that grants a mailbox nobody approved this person for.
test('the Gmail switch is refused with a reason, not quietly opened', async () => {
  const res = await act('startGoogle', { mail: true });
  assert.equal(res.ok, false, 'a mailbox consent was opened for somebody not allowed one');
  assert.equal(res.error.reason, 'not_enabled');
});

test('an access level the page did not offer is refused before Google is involved', async () => {
  const res = await act('startGoogle', { calendarAccess: 'write_everything' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
});

test('asking for nothing is refused rather than opening an empty consent', async () => {
  const res = await act('startGoogle', {});
  assert.equal(res.ok, false);
});

test('one switch off removes one service and leaves the others connected', async () => {
  await connectService('google_calendar', 'read_write');
  await connectService('google_contacts', 'read_only');
  await connectService('gmail', 'read_only');
  assert.deepEqual(await providers(), ['gmail', 'google_calendar', 'google_contacts']);

  const res = await act('stopGoogleService', { service: 'contacts' });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.deepEqual(await providers(), ['gmail', 'google_calendar'],
    'turning contacts off took something else with it');
});

test('a service that was never on is not an error — the row is already in the asked-for state', async () => {
  const res = await act('stopGoogleService', { service: 'contacts' });
  assert.ok(res.ok, 'disconnecting an already-disconnected service failed');
});

test('a service key the page does not draw is refused, not silently ignored', async () => {
  const res = await act('stopGoogleService', { service: 'drive' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
});

test('ending the account ends all of Google, because the page draws it as one', async () => {
  await connectService('google_calendar', 'read_write');
  await connectService('google_contacts', 'read_only');
  await connectService('gmail', 'read_only');
  const res = await act('stopGoogle', {});
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.deepEqual(await providers(), [],
    'a Google service survived disconnecting the account');
});
