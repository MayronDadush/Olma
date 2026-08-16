'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const users = require('../src/domain/users');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

test('createUser creates user + primary channel + free entitlement atomically', async () => {
  const u = await makeUser(db.pool, '+972501111111');
  assert.equal(u.phone, '+972501111111');
  assert.match(u.identity_token, /^olma_tok_[0-9a-f]{32}$/);

  const ch = await db.pool.query(`SELECT * FROM user_channels WHERE user_id = $1`, [u.id]);
  assert.equal(ch.rows.length, 1);
  assert.equal(ch.rows[0].channel_type, 'whatsapp');
  assert.equal(ch.rows[0].channel_identifier, '+972501111111');
  assert.equal(ch.rows[0].is_primary, true);

  const ent = await db.pool.query(`SELECT * FROM entitlements WHERE user_id = $1`, [u.id]);
  assert.equal(ent.rows[0].plan, 'free');
});

test('createUser rejects duplicates and bad phones', async () => {
  await makeUser(db.pool, '+972502222222');
  const client = await db.pool.connect();
  try {
    const dup = await users.createUser(client, { phone: '+972502222222' });
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, 'conflict');

    const bad = await users.createUser(client, { phone: 'not-a-phone' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'invalid');
  } finally { client.release(); }
});

test('resolveByToken is the only door — bad/blocked tokens rejected', async () => {
  const u = await makeUser(db.pool, '+972503333333');
  const client = await db.pool.connect();
  try {
    const good = await users.resolveByToken(client, u.identity_token);
    assert.equal(good.ok, true);
    assert.equal(good.data.user.id, u.id);

    const missing = await users.resolveByToken(client, null);
    assert.equal(missing.error.code, 'forbidden');
    const wrong = await users.resolveByToken(client, 'olma_tok_' + '0'.repeat(32));
    assert.equal(wrong.error.code, 'forbidden');

    await client.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [u.id]);
    const blocked = await users.resolveByToken(client, u.identity_token);
    assert.equal(blocked.error.code, 'forbidden');
  } finally { client.release(); }
});

test('primaryChannel + sessionKeyFor build the proactive send target', async () => {
  const u = await makeUser(db.pool, '+972504444444');
  const client = await db.pool.connect();
  try {
    const res = await users.primaryChannel(client, u.id);
    assert.equal(res.ok, true);
    const key = users.sessionKeyFor('u-7', res.data.channel);
    assert.equal(key, 'agent:u-7:whatsapp:direct:+972504444444');
  } finally { client.release(); }
});

test('setTimezone validates IANA names', async () => {
  const u = await makeUser(db.pool, '+972505555555');
  const client = await db.pool.connect();
  try {
    const good = await users.setTimezone(client, u.id, 'Asia/Jerusalem', true);
    assert.equal(good.ok, true);
    const bad = await users.setTimezone(client, u.id, 'Middle/Nowhere', true);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'invalid');
  } finally { client.release(); }
});
