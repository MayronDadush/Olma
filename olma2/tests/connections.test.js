'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, miron, kapish, gali;
before(async () => {
  db = await freshDb();
  miron = await makeUser(db.pool, '+972521000001', { firstName: 'Miron' });
  kapish = await makeUser(db.pool, '+972521000002', { firstName: 'Kapish' });
  gali = await makeUser(db.pool, '+972521000003', { firstName: 'Gali' });
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function connect(a, b) {
  return withClient(async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, { reason: 'test' });
    assert.equal(req.ok, true);
    const res = await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve');
    assert.equal(res.ok, true);
    return res.data.connection;
  });
}

test('request → pending_target → approve lifecycle for existing user', async () => {
  const conn = await connect(miron, kapish);
  assert.equal(conn.status, 'active');
  await withClient(async (c) => {
    const list = await connections.listConnections(c, miron.id);
    assert.equal(list.data.connections.length, 1);
    assert.equal(list.data.connections[0].other_first_name, 'Kapish');
  });
});

test('unknown phone → invited state, reason stored for the intro message', async () => {
  await withClient(async (c) => {
    const req = await connections.requestConnection(c, miron.id, '+972529999999', {
      reason: 'רוצה לתאם איתך פגישה',
    });
    assert.equal(req.ok, true);
    assert.equal(req.data.targetKnown, false);
    assert.equal(req.data.connection.status, 'invited');
    assert.equal(req.data.connection.invite_reason, 'רוצה לתאם איתך פגישה');
  });
});

test('a nameless requester is refused, with something the agent can act on', async () => {
  // The name is the entire content of the intro the other side reads. Skipping
  // it is not a cosmetic miss: one real recipient got "+972502205854 sent a
  // connection request" and had no idea who was asking or why to say yes.
  const nameless = await makeUser(db.pool, '+972521000009', { firstName: null });
  await withClient(async (c) => {
    const req = await connections.requestConnection(c, nameless.id, kapish.phone, { reason: 'test' });
    assert.equal(req.ok, false);
    assert.equal(req.error.reason, 'requester_name_missing');

    // ...and once they say who they are, the same request goes through.
    const named = await require('../src/domain/users').setName(c, nameless.id, 'Rut', 'Cohen');
    assert.equal(named.ok, true);
    const retry = await connections.requestConnection(c, nameless.id, kapish.phone, { reason: 'test' });
    assert.equal(retry.ok, true);
  });
});

test('duplicate live request rejected; self-connection rejected', async () => {
  await withClient(async (c) => {
    const dup = await connections.requestConnection(c, miron.id, kapish.phone, {});
    assert.equal(dup.ok, false);
    const self = await connections.requestConnection(c, miron.id, miron.phone, {});
    assert.equal(self.ok, false);
  });
});

test('approval auto-grants every feature both ways; revoke stays per-side', async () => {
  const conn = await connect(miron, gali);
  await withClient(async (c) => {
    // Friendship IS the consent moment (2026-08-27): everything comes on for
    // both sides at approval — no toggle conversation.
    for (const f of grants.KNOWN_CONNECTION_FEATURES) {
      const gate = await grants.requireFeatureBetween(c, miron.id, gali.id, f);
      assert.equal(gate.ok, true, `${f} should be enabled by the approval itself`);
    }
    // gali switches sharing off on HER side only — everyone's errors stay
    // distinguishable, and her other features are untouched.
    const off = await grants.revokeFeatureGrant(c, gali.id, conn.id, 'sharing');
    assert.equal(off.ok, true);
    const gateMiron = await grants.requireFeatureBetween(c, miron.id, gali.id, 'sharing');
    assert.equal(gateMiron.ok, false);
    assert.equal(gateMiron.error.reason, 'not_granted_by_them');
    const gateGali = await grants.requireFeatureBetween(c, gali.id, miron.id, 'sharing');
    assert.equal(gateGali.ok, false);
    assert.equal(gateGali.error.reason, 'not_granted_by_you');
    assert.equal((await grants.requireFeatureBetween(c, miron.id, gali.id, 'meetings')).ok, true);

    // ...and she can turn it back on herself.
    await grants.grantFeature(c, gali.id, conn.id, 'sharing');
    assert.equal((await grants.requireFeatureBetween(c, miron.id, gali.id, 'sharing')).ok, true);
  });
});

test('not-connected vs not-granted errors are distinguishable', async () => {
  await withClient(async (c) => {
    const stranger = await grants.requireFeatureBetween(c, kapish.id, gali.id, 'sharing');
    assert.equal(stranger.error.reason, 'not_connected');
    const unknown = await grants.grantFeature(c, miron.id, 999999, 'sharing');
    assert.equal(unknown.error.code, 'not_found');
    const badFeature = await grants.grantFeature(c, miron.id, 1, 'mind_reading');
    assert.equal(badFeature.error.code, 'invalid');
  });
});

test('revoke cascade: shares revoked, grants deleted, pair meeting closed', async () => {
  const tasksD = require('../src/domain/tasks');
  const sharesD = require('../src/domain/shares');
  const meetingsD = require('../src/domain/meetings');

  // fresh pair so earlier tests don't interfere
  const a = await makeUser(db.pool, '+972521000004', { firstName: 'A' });
  const b = await makeUser(db.pool, '+972521000005', { firstName: 'B' });
  const conn = await connect(a, b);

  const { taskId, shareId, meetingId } = await withTx(db.pool, async (c) => {
    // No manual grants: approval already enabled everything for both sides.
    const t = (await tasksD.addTask(c, a.id, { title: 'shared thing' })).data.task;
    const s = (await sharesD.offerShare(c, a.id, t.id, b.id, 'viewer')).data.share;
    await sharesD.respondToShare(c, b.id, s.id, 'accept');

    const m = (await meetingsD.startMeeting(c, a.id, 'coffee', [b.id])).data.meeting;
    return { taskId: t.id, shareId: s.id, meetingId: m.id };
  });

  const result = await withTx(db.pool, (c) => connections.revokeConnection(c, a.id, conn.id));
  assert.equal(result.ok, true);
  assert.equal(result.data.sharesRevoked, 1);
  // every feature × both sides, all auto-granted at approval
  assert.equal(result.data.grantsDeleted, grants.KNOWN_CONNECTION_FEATURES.length * 2);

  await withClient(async (c) => {
    const share = await c.query(`SELECT status FROM shares WHERE id = $1`, [shareId]);
    assert.equal(share.rows[0].status, 'revoked');
    const meeting = await c.query(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
    assert.equal(meeting.rows[0].status, 'cancelled'); // revoker initiated it → cancel path
    const g = await c.query(`SELECT count(*)::int AS n FROM connection_feature_grants WHERE connection_id = $1`, [conn.id]);
    assert.equal(g.rows[0].n, 0);
  });
});

test('revoke by the NON-initiator side closes the pair meeting as no_match', async () => {
  const meetingsD = require('../src/domain/meetings');
  const x = await makeUser(db.pool, '+972521000006', { firstName: 'X' });
  const y = await makeUser(db.pool, '+972521000007', { firstName: 'Y' });
  const conn = await connect(x, y);

  const meetingId = await withTx(db.pool, async (c) =>
    (await meetingsD.startMeeting(c, x.id, 'walk', [y.id])).data.meeting.id);

  // y (participant, not initiator) revokes → opt-out path → no_match
  const result = await withTx(db.pool, (c) => connections.revokeConnection(c, y.id, conn.id));
  assert.equal(result.ok, true);
  await withClient(async (c) => {
    const meeting = await c.query(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
    assert.equal(meeting.rows[0].status, 'no_match');
  });
});
