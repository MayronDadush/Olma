'use strict';
// A person deleting everything, themselves (domain/self-delete.js). The owner's
// two rules are what these guard: ONLY on their explicit, confirmed request —
// never after a pause or silence — and what they share stays with the others.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const tasks = require('../src/domain/tasks');
const shares = require('../src/domain/shares');
const meetings = require('../src/domain/meetings');
const write = require('../src/domain/user-dashboard-write');
const selfDelete = require('../src/domain/self-delete');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Nothing here may reach the live gateway: the deletion's gateway steps are
// injected, and the config is the temp one tests/helpers.js points at.
const deps = { restartGateway: async () => false, deleteSession: async () => null };

async function friends(a, b) {
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    const conn = (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
    for (const f of ['sharing', 'meetings']) {
      await grants.grantFeature(c, a.id, conn.id, f);
      await grants.grantFeature(c, b.id, conn.id, f);
    }
  });
}
const userRow = async (id) => (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0] || null;

test('the chat needs a fresh preview before a confirmation counts', async () => {
  const u = await makeUser(db.pool, '+972542000001');
  let res = await withTx(db.pool, (c) => selfDelete.request(c, u.id, { via: 'chat' }));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_previewed', 'a model cannot confirm what nobody was shown');

  const p = await withTx(db.pool, (c) => selfDelete.preview(c, u.id));
  assert.ok(p.ok && typeof p.data.counts.tasks === 'number');
  assert.equal((await userRow(u.id)).deletion_requested_at, null, 'a preview deletes nothing');

  const late = Date.now() + selfDelete.PREVIEW_TTL_MS + 60_000;
  res = await withTx(db.pool, (c) => selfDelete.request(c, u.id, { via: 'chat', now: late }));
  assert.equal(res.error.reason, 'not_previewed', 'a stale preview is no preview');

  res = await withTx(db.pool, (c) => selfDelete.request(c, u.id, { via: 'chat' }));
  assert.ok(res.ok && res.data.requested);
  const row = await userRow(u.id);
  assert.ok(row.deletion_requested_at && row.paused_at, 'requested, and nothing more reaches them meanwhile');
});

test('the page refuses anything but its own explicit yes', async () => {
  const u = await makeUser(db.pool, '+972542000002');
  let res = await withTx(db.pool, (c) => write.perform(c, u.id, 'deleteAccount', {}));
  assert.equal(res.ok, false);
  res = await withTx(db.pool, (c) => write.perform(c, u.id, 'deleteAccount', { confirm: 'true' }));
  assert.equal(res.ok, false, 'a string is not the button');
  assert.equal((await userRow(u.id)).deletion_requested_at, null);
  res = await withTx(db.pool, (c) => write.perform(c, u.id, 'deleteAccount', { confirm: true }));
  assert.ok(res.ok);
  assert.ok((await userRow(u.id)).deletion_requested_at);
});

test('nobody is deleted for being paused or silent, however long', async () => {
  const u = await makeUser(db.pool, '+972542000003');
  await db.pool.query(
    `UPDATE users SET paused_at = now() - interval '400 days', paused_reason = 'ladder',
            checkin_misses = 9, deletion_previewed_at = now() - interval '400 days' WHERE id = $1`, [u.id]);
  await selfDelete.sweep(db.pool, deps);
  assert.ok(await userRow(u.id), 'only a confirmed request deletes');
});

test('carried out a minute later: shared things stay with the others, and they are gone', async () => {
  const leaver = await makeUser(db.pool, '+972542000011', { firstName: 'Leaver' });
  const bob = await makeUser(db.pool, '+972542000012', { firstName: 'Bob' });
  const carol = await makeUser(db.pool, '+972542000013', { firstName: 'Carol' });
  await friends(leaver, bob);
  await friends(leaver, carol);
  await friends(bob, carol);

  const { taskId, mine, meetingId } = await withTx(db.pool, async (c) => {
    const shared = (await tasks.addTask(c, leaver.id, { title: 'groceries' })).data.task;
    const s = (await shares.offerShare(c, leaver.id, shared.id, bob.id)).data.share;
    await shares.respondToShare(c, bob.id, s.id, 'accept');
    const own = (await tasks.addTask(c, leaver.id, { title: 'my own thing' })).data.task;
    const m = (await meetings.startMeeting(c, leaver.id, 'dinner', [bob.id, carol.id])).data.meeting;
    return { taskId: shared.id, mine: own.id, meetingId: m.id };
  });

  await withTx(db.pool, (c) => write.perform(c, leaver.id, 'deleteAccount', { confirm: true }));
  let out = await selfDelete.sweep(db.pool, deps);
  assert.equal(out.deleted, 0, 'not inside the turn that asked');

  await db.pool.query(`UPDATE users SET deletion_requested_at = now() - interval '2 minutes' WHERE id = $1`, [leaver.id]);
  out = await selfDelete.sweep(db.pool, deps);
  assert.equal(out.deleted, 1, JSON.stringify(out));

  assert.equal(await userRow(leaver.id), null);
  const t = (await db.pool.query(`SELECT owner_id FROM tasks WHERE id = $1`, [taskId])).rows[0];
  assert.ok(t, 'the shared task was not deleted for Bob');
  assert.equal(Number(t.owner_id), Number(bob.id));
  assert.equal((await db.pool.query(`SELECT 1 FROM tasks WHERE id = $1`, [mine])).rows.length, 0,
    'their own task went with them');
  const m = (await db.pool.query(`SELECT initiator_id, status FROM meetings WHERE id = $1`, [meetingId])).rows[0];
  assert.ok(m, 'the coordination was not deleted for the others');
  assert.equal(m.status, 'negotiating');
  assert.ok([Number(bob.id), Number(carol.id)].includes(Number(m.initiator_id)));
  const { rows: trail } = await db.pool.query(
    `SELECT event, detail, retention_class FROM audit_log WHERE actor_id = $1 AND event LIKE 'account.%' ORDER BY id`,
    [leaver.id]);
  assert.deepEqual(trail.map((r) => r.event), ['account.deletion_requested', 'account.deletion_completed']);
  assert.ok(trail.every((r) => r.retention_class === 'permanent'), 'the record that we acted on it is kept');
  assert.ok(!JSON.stringify(trail).includes(leaver.phone), 'and it holds no phone');
});
