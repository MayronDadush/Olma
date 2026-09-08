'use strict';
// Being in the same room is the introduction (owner's rule, 2026-09-09).
//
// Most of this file is about the three things it must NOT do — invite a
// stranger, undo a revoke, or write a second time on the next pass — because
// those are what separate "the room introduced you" from "an assistant added
// people to your life without asking".
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupConnections = require('../src/domain/group-connections');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const userDashboard = require('../src/domain/user-dashboard');

let db;
let seq = 0;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(() => { seq += 1; });

// A room, its phones, and whichever of them are users. `people` is the list of
// user rows in roster order; `strangers` are phones with no user behind them,
// which is the ordinary case — most people in a WhatsApp group have never
// heard of Olma.
async function room({ users = 3, strangers = 0, subject = 'פאדל' } = {}) {
  const n = seq;
  const people = [];
  const roster = [];
  for (let i = 0; i < users; i++) {
    const u = await makeUser(db.pool, `+97260${String(n).padStart(2, '0')}10${i}0`,
      { firstName: ['דני', 'דנה', 'יובל', 'רון', 'מאיה'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
    roster.push({ phone: u.phone, displayName: u.first_name });
  }
  for (let i = 0; i < strangers; i++) {
    roster.push({ phone: `+97260${String(n).padStart(2, '0')}90${i}0`, displayName: `זר ${i}` });
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `g-${n}-${Date.now()}@g.us`, subject, members: roster,
    });
    assert.ok(reg.ok, reg.ok ? '' : reg.error.message);
    return reg.data.group;
  });
  return { group, people, roster };
}

async function activeBetween(a, b) {
  const client = await db.pool.connect();
  try { return await connections.activeConnectionBetween(client, a.id, b.id); }
  finally { client.release(); }
}

test('everybody in the room ends up connected to everybody else, all features on', async () => {
  const { group, people } = await room({ users: 3 });
  const [a, b, c] = people;

  const res = await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  assert.equal(res.data.created, 3, 'three people is three pairs');

  for (const [x, y] of [[a, b], [a, c], [b, c]]) {
    const conn = await activeBetween(x, y);
    assert.ok(conn, `${x.first_name} and ${y.first_name} are connected`);
    // Both sides, because a grant is per side and one-sided is unusable: the
    // gate checks both on every call.
    for (const who of [x, y]) {
      const gate = await withTx(db.pool, (cl) =>
        grants.requireFeatureBetween(cl, who.id, who.id === x.id ? y.id : x.id, 'meetings'));
      assert.ok(gate.ok, 'meetings is open in both directions');
    }
  }
});

test('a stranger in the room is never invited — connections are for people already here', async () => {
  const { group, people } = await room({ users: 2, strangers: 3 });
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));

  // This room's phones only — the database is shared across the file.
  const { rows } = await db.pool.query(
    `SELECT status, target_id, target_phone FROM connections
      WHERE target_phone LIKE $1 OR requester_id = ANY($2)`,
    [`+97260${String(seq).padStart(2, '0')}%`, people.map((p) => p.id)]);
  assert.equal(rows.length, 1, 'one pair, not one per phone in the roster');
  assert.equal(rows[0].status, 'active');
  assert.equal(Number(rows[0].target_id), people[1].id);
  // The invite path sends a stranger a message. Nothing here may reach it.
  assert.equal(rows.filter((r) => r.status === 'invited').length, 0);
});

test('a second pass writes nothing at all', async () => {
  const { group } = await room({ users: 3 });
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  const before = await db.pool.query(`SELECT count(*)::int n FROM audit_log`);

  const again = await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  assert.equal(again.data.created, 0);
  assert.equal(again.data.activated, 0);
  assert.equal(again.data.already, 3);
  const after2 = await db.pool.query(`SELECT count(*)::int n FROM audit_log`);
  assert.equal(after2.rows[0].n, before.rows[0].n, 'no audit row for a pass that changed nothing');
});

test('somebody who joins later is connected to everyone already in the room', async () => {
  const { group, people, roster } = await room({ users: 2 });
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));

  const late = await makeUser(db.pool, `+97260${String(seq).padStart(2, '0')}7777`, { firstName: 'רון' });
  await withTx(db.pool, (cl) => groups.syncRoster(cl, group.id,
    [...roster, { phone: late.phone, displayName: 'רון' }]));

  const res = await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  assert.equal(res.data.created, 2, 'the newcomer, to each of the two');
  assert.ok(await activeBetween(late, people[0]));
  assert.ok(await activeBetween(late, people[1]));
});

test('a connection somebody revoked is never re-created by the room', async () => {
  const { group, people } = await room({ users: 2 });
  const [a, b] = people;
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  const conn = await activeBetween(a, b);

  await withTx(db.pool, (cl) => connections.revokeConnection(cl, a.id, conn.id));
  assert.equal(await activeBetween(a, b), null, 'revoked');

  const res = await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  assert.equal(res.data.created, 0);
  assert.equal(res.data.refusedBefore, 1);
  assert.equal(await activeBetween(a, b), null,
    'revoking is the only way out, so the room must not be a way back in');
});

test('a request already on the table is answered by the room, not duplicated', async () => {
  const { group, people } = await room({ users: 2 });
  const [a, b] = people;
  const asked = await withTx(db.pool, (cl) =>
    connections.requestConnection(cl, a.id, b.phone, { reason: 'padel' }));
  assert.ok(asked.ok);
  assert.equal(asked.data.connection.status, 'pending_target');

  const res = await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));
  assert.equal(res.data.activated, 1);
  assert.equal(res.data.created, 0);

  const { rows } = await db.pool.query(
    `SELECT id, status FROM connections
      WHERE status IN ('invited','pending_target','active')
        AND (requester_id = ANY($1) OR target_id = ANY($1))`, [[a.id, b.id]]);
  assert.equal(rows.length, 1, 'one live row for one pair, not a mirror beside it');
  assert.equal(Number(rows[0].id), Number(asked.data.connection.id));
  assert.equal(rows[0].status, 'active');
});

test('the auto-connection is on both records, and it is not counted as an approval', async () => {
  const { group, people } = await room({ users: 2 });
  const [a, b] = people;
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));

  // Scoped to this test's two people: the database is shared across the file
  // and every earlier test left its own pairs behind.
  const { rows } = await db.pool.query(
    `SELECT actor_id, event, retention_class FROM audit_log
      WHERE event LIKE 'connection.%' AND actor_id = ANY($1) ORDER BY actor_id`, [[a.id, b.id]]);
  assert.deepEqual(rows.map((r) => r.event), ['connection.auto_connected', 'connection.auto_connected']);
  assert.deepEqual(rows.map((r) => Number(r.actor_id)).sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
  // The daily metrics count `connection.approved` as a friction signal. This
  // must never land in that number.
  assert.equal(rows.filter((r) => r.event === 'connection.approved').length, 0);
  assert.deepEqual([...new Set(rows.map((r) => r.retention_class))], ['permanent']);
});

test('the room reaches the personal dashboard by its WhatsApp name, with its people', async () => {
  const { group, people } = await room({ users: 2, strangers: 1, subject: 'פאדל רביעי' });
  await withTx(db.pool, (cl) => groupConnections.connectRoom(cl, group.id));

  const page = await withTx(db.pool, (cl) => userDashboard.load(cl, people[0].id));
  assert.ok(page.ok);
  const rooms = page.data.groups;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].name, 'פאדל רביעי', 'the name it has in WhatsApp');
  assert.equal(rooms[0].members.length, 3, 'the stranger is drawn too — it is the same room');

  const me = rooms[0].members.find((m) => m.self);
  assert.ok(me, 'the viewer is marked, so the page does not draw them as a stranger');
  const stranger = rooms[0].members.find((m) => !m.onOlma);
  assert.equal(stranger.id, null);
  assert.equal(stranger.name, 'זר 0', 'by the name the room already shows');

  // The room's own row is its door. Nothing bound for a browser may carry it.
  const json = JSON.stringify(rooms);
  assert.equal(/identity_token|identityToken/.test(json), false);
  assert.equal(/\+9726/.test(json), false, 'and no phone numbers');
});
