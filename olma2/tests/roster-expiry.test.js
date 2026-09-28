'use strict';
// Numbers seen only on a room's roster are aged out (domain/roster-expiry.js,
// compliance review 2026-09-28). The cases that matter are the ones where it
// would delete somebody it must not: a person who wrote, an invited stranger,
// a member row of somebody Olma talks to, a room member still inside the window.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const flags = require('../src/domain/flags');
const rosterExpiry = require('../src/domain/roster-expiry');
const { sweepRetention } = require('../src/jobs/retention');

let db;
before(async () => {
  db = await freshDb();
  await withTx(db.pool, (c) => flags.setFlag(c, groups.ROSTER_USERS_FLAG, true));
});
after(async () => { await db.teardown(); });

const JID = (n) => `12036342828299881${n}@g.us`;

async function room(n, members) {
  return withTx(db.pool, async (c) => {
    const r = await groups.registerGroup(c, { externalId: JID(n), subject: 'בדיקה', members });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    await groups.ensureRosterUsers(c, r.data.group.id, members);
    await groups.syncRoster(c, r.data.group.id, members);
    return r.data.group.id;
  });
}

async function writer(phone) {
  const u = await makeUser(db.pool, phone);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  return u;
}

const userByPhone = async (phone) =>
  (await db.pool.query(`SELECT * FROM users WHERE phone = $1`, [phone])).rows[0] || null;
const memberRow = async (groupId, phone) =>
  (await db.pool.query(`SELECT * FROM chat_group_members WHERE group_id = $1 AND phone = $2`, [groupId, phone])).rows[0] || null;
const expire = () => withTx(db.pool, (c) => rosterExpiry.expireRoster(c));

test('a roster row inside its window, still in the room, is kept', async () => {
  const me = await writer('+972502100001');
  const g = await room(1, [{ phone: me.phone }, { phone: '+972502100002', displayName: 'דנה' }]);
  assert.ok(await userByPhone('+972502100002'), 'minted');
  const out = await expire();
  assert.equal(out.rosterUsersExpired, 0);
  assert.ok(await userByPhone('+972502100002'));
  assert.ok(await memberRow(g, '+972502100002'));
});

test('past the window without a word: the users row goes, the member row stays, and it is not minted again', async () => {
  const me = await writer('+972502100011');
  const members = [{ phone: me.phone }, { phone: '+972502100012', displayName: 'יוסי' }];
  const g = await room(2, members);
  await db.pool.query(`UPDATE users SET created_at = now() - interval '61 days' WHERE phone = '+972502100012'`);
  await db.pool.query(`UPDATE chat_group_members SET first_seen_at = now() - interval '61 days' WHERE phone = '+972502100012'`);
  const out = await expire();
  assert.equal(out.rosterUsersExpired, 1);
  assert.equal(await userByPhone('+972502100012'), null);
  const m = await memberRow(g, '+972502100012');
  assert.ok(m && m.user_id === null, 'the room keeps its own list; the link is cut');
  // The next sweep pass sees the same roster.
  const again = await withTx(db.pool, (c) => groups.ensureRosterUsers(c, g, members));
  assert.equal(again.data.created.length, 0);
  assert.equal(again.data.skipped.expired, 1);
  assert.equal(await userByPhone('+972502100012'), null);
});

test('left every room: the row goes after the grace, and so does the member row', async () => {
  const me = await writer('+972502100021');
  const g = await room(3, [{ phone: me.phone }, { phone: '+972502100022' }]);
  await withTx(db.pool, (c) => groups.syncRoster(c, g, [{ phone: me.phone }]));
  assert.ok((await memberRow(g, '+972502100022')).left_at);
  let out = await expire();
  assert.equal(out.rosterUsersExpired, 0, 'inside the grace a rejoin must find them');
  await db.pool.query(`UPDATE chat_group_members SET left_at = now() - interval '8 days' WHERE phone = '+972502100022'`);
  out = await expire();
  assert.equal(out.rosterUsersExpired, 1);
  assert.equal(out.rosterMembersExpired, 1);
  assert.equal(await userByPhone('+972502100022'), null);
  assert.equal(await memberRow(g, '+972502100022'), null);
});

test('never deleted: somebody who wrote, an invited stranger, or a real user who left', async () => {
  const me = await writer('+972502100031');
  const g = await room(4, [{ phone: me.phone }, { phone: '+972502100032' }, { phone: '+972502100033' }]);
  // 32 wrote to the greeter, so they stopped being a roster row in all but status.
  await db.pool.query(`UPDATE users SET opening_sent_at = now() WHERE phone = '+972502100032'`);
  // 33 is somebody a member asked for by name.
  const u33 = await userByPhone('+972502100033');
  await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status) VALUES ($1, $2, $3, 'invited')`,
    [me.id, u33.id, u33.phone]);
  await db.pool.query(`UPDATE users SET created_at = now() - interval '100 days' WHERE phone IN ('+972502100032', '+972502100033')`);
  // And the real user leaves the room.
  await withTx(db.pool, (c) => groups.syncRoster(c, g, [{ phone: '+972502100032' }, { phone: '+972502100033' }]));
  await db.pool.query(`UPDATE chat_group_members SET left_at = now() - interval '30 days' WHERE phone = $1`, [me.phone]);
  const out = await expire();
  assert.equal(out.rosterUsersExpired, 0);
  assert.equal(out.rosterMembersExpired, 0);
  assert.ok(await userByPhone('+972502100032'));
  assert.ok(await userByPhone('+972502100033'));
  assert.ok(await memberRow(g, me.phone), 'a real user\'s membership history is not ours to age');
});

test('the daily retention sweep runs it and reports the counts', async () => {
  const out = await withTx(db.pool, (c) => sweepRetention(c));
  assert.equal(typeof out.rosterUsersExpired, 'number');
  assert.equal(typeof out.rosterMembersExpired, 'number');
});
