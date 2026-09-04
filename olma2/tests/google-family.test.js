'use strict';
// google-family.js: the keep-alive check that stops disconnecting ONE Google
// service (calendar/contacts/gmail) from revoking a token a sibling still
// depends on, when all three came from one combined consent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { hasOtherGoogleConnection, GOOGLE_FAMILY_PROVIDERS } = require('../src/domain/google-family');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972631900001', { firstName: 'Tal' });
});
after(async () => { await db.teardown(); });

async function addRow(provider) {
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, $2, 'connected')`,
    [user.id, provider]
  );
}

test('every family provider is exactly calendar, contacts, gmail — nothing more, nothing less', () => {
  assert.deepEqual([...GOOGLE_FAMILY_PROVIDERS].sort(), ['gmail', 'google_calendar', 'google_contacts']);
});

test('no other row at all — nothing to keep alive for', async () => {
  const alive = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, user.id, 'google_calendar'));
  assert.equal(alive, false);
});

test('a sibling row exists — keep the token alive', async () => {
  await addRow('google_contacts');
  const alive = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, user.id, 'google_calendar'));
  assert.equal(alive, true);
});

test('the excluded provider itself does not count as an "other" row', async () => {
  // Only google_contacts exists (from the previous test); asking whether
  // anything OTHER than google_contacts exists must say no.
  const alive = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, user.id, 'google_contacts'));
  assert.equal(alive, false);
});

test('a non-Google provider row never keeps a Google token alive', async () => {
  const other = await makeUser(db.pool, '+972631900002', { firstName: 'Roni' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'monday', 'connected')`,
    [other.id]
  );
  const alive = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, other.id, 'google_calendar'));
  assert.equal(alive, false);
});

test('rows belong to a user, not to everyone — another user\'s connection is invisible here', async () => {
  const stranger = await makeUser(db.pool, '+972631900003', { firstName: 'Dor' });
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status) VALUES ($1, 'google_contacts', 'connected')`,
    [stranger.id]
  );
  const alive = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, stranger.id, 'google_calendar'));
  assert.equal(alive, true);
  const unrelatedUser = await makeUser(db.pool, '+972631900004', { firstName: 'Ela' });
  const aliveForOther = await withTx(db.pool, (c) => hasOtherGoogleConnection(c, unrelatedUser.id, 'google_calendar'));
  assert.equal(aliveForOther, false);
});
