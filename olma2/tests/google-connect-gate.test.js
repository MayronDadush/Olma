'use strict';
// The door in front of every NEW Google consent link (domain/google-connect-
// gate.js). The feature's code half deploys itself; the half in Google's
// console — scopes and verification tier — does not, and in between the link
// lands on "this app is not verified". Closed by default for that reason
// (owner, 2026-09-08), and closed means the OFFER stops too: an offer the
// tool would then refuse is the worst kind, because they say yes first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-gcg-'));
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
const flags = require('../src/domain/flags');
const calendar = require('../src/domain/calendar');
const googleContacts = require('../src/domain/google-contacts');
const googleConnect = require('../src/domain/google-connect');
const gate = require('../src/domain/google-connect-gate');

let db, user, admin;

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972651300001', { firstName: 'Dana' });
  admin = await makeUser(db.pool, '+972651300002', { firstName: 'Mayron' });
  await db.pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
});
after(async () => {
  await db.teardown();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const setFlag = (v) => withTx(db.pool, (c) => flags.setFlag(c, gate.FLAG, v));

test('closed by default: all three doors refuse, and none of them mints a state', async () => {
  await setFlag('');
  const cal = await withTx(db.pool, (c) => calendar.beginConnection(c, user.id, 'read_only'));
  const con = await withTx(db.pool, (c) => googleContacts.beginConnection(c, user.id));
  const both = await withTx(db.pool, (c) => googleConnect.beginConnection(c, user,
    { calendarAccess: 'read_write', wantContacts: true }));
  for (const [name, res] of [['calendar', cal], ['contacts', con], ['combined', both]]) {
    assert.equal(res.ok, false, name + ' should have been refused');
    assert.equal(res.error.code, 'forbidden', name);
    assert.equal(res.error.reason, 'google_connect_closed', name);
    assert.ok(!res.data || !res.data.url, name + ' must not hand back a link');
  }
  // Refused BEFORE the write, so a link nobody may open leaves no state row
  // behind to be completed later — the same order the past-remind_at refusal
  // uses at the tool boundary.
  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM oauth_states WHERE user_id = $1`, [user.id]);
  assert.equal(rows[0].n, 0);
});

test('the refusal tells the model not to offer it and not to send them asking', async () => {
  await setFlag('');
  const res = await withTx(db.pool, (c) => calendar.beginConnection(c, user.id, 'read_only'));
  assert.match(res.error.message, /[Dd]o not offer it/);
  assert.match(res.error.message, /not suggest they ask anyone for access/);
  // No server vocabulary in what reaches the person's ear.
  assert.doesNotMatch(res.error.message, /flag|feature flag|allowlist/i);
});

test('"all" opens it, a listed phone opens it for that person only, admin always', async () => {
  await setFlag('all');
  assert.equal((await withTx(db.pool, (c) => calendar.beginConnection(c, user.id, 'read_only'))).ok, true);

  await setFlag(user.phone);
  assert.equal((await withTx(db.pool, (c) => calendar.beginConnection(c, user.id, 'read_only'))).ok, true);
  const other = await makeUser(db.pool, '+972651300003', { firstName: 'Roni' });
  assert.equal((await withTx(db.pool, (c) => calendar.beginConnection(c, other.id, 'read_only'))).ok, false);

  // The owner can always try the flow on himself — that is how he finds out
  // whether Google's screen is still shouting.
  await setFlag('');
  assert.equal((await withTx(db.pool, (c) => calendar.beginConnection(c, admin.id, 'read_only'))).ok, true);
});

test('closing the door does not touch a connection already made', async () => {
  await setFlag('all');
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level)
     VALUES ($1, 'google_calendar', 'connected', 'read_write')`, [user.id]);
  await setFlag('');
  const status = await withTx(db.pool, (c) => calendar.getStatus(c, user.id));
  assert.equal(status.ok, true);
  assert.equal(status.data.connected, true);
  assert.equal(status.data.access, 'read_write');
  await db.pool.query(`DELETE FROM integrations WHERE user_id = $1`, [user.id]);
});

test('mail keeps its own gate: an open Google door does not open the mail one', async () => {
  await setFlag('all');
  await withTx(db.pool, (c) => flags.setFlag(c, 'email_access_phones', ''));
  const res = await withTx(db.pool, (c) => googleConnect.beginConnection(c, user,
    { calendarAccess: 'read_only', wantMail: true }));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_enabled', 'mail refuses in its own words');
});
