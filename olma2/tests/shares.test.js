'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const tasks = require('../src/domain/tasks');
const shares = require('../src/domain/shares');

let db, owner, viewer, conn;
before(async () => {
  db = await freshDb();
  owner = await makeUser(db.pool, '+972541000001', { firstName: 'Owner' });
  viewer = await makeUser(db.pool, '+972541000002', { firstName: 'Viewer' });
  const c = await db.pool.connect();
  try {
    const req = await connections.requestConnection(c, owner.id, viewer.phone, {});
    conn = (await connections.respondToConnection(c, viewer.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, owner.id, conn.id, 'sharing');
    await grants.grantFeature(c, viewer.id, conn.id, 'sharing');
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('offer → accept → view; project share shows subtasks added later', async () => {
  await withClient(async (c) => {
    const project = (await tasks.addTask(c, owner.id, { title: 'groceries' })).data.task;
    await tasks.addTask(c, owner.id, { title: 'milk', parentId: project.id });

    const s = (await shares.offerShare(c, owner.id, project.id, viewer.id)).data.share;
    await shares.respondToShare(c, viewer.id, s.id, 'accept');

    let view = await shares.viewShared(c, viewer.id, s.id);
    assert.equal(view.data.subtasks.length, 1);

    // dynamic cascade: new subtask visible with NO re-share
    await tasks.addTask(c, owner.id, { title: 'bread', parentId: project.id });
    view = await shares.viewShared(c, viewer.id, s.id);
    assert.equal(view.data.subtasks.length, 2);
  });
});

// One kind of share (2026-09-19). Whoever is on the task completes and adds
// items; a pending offer is not being on it yet, and a `role` the row still
// carries decides nothing — the live rows written as 'viewer' are equal too.
test('everyone on a shared task can complete and add items, and a pending offer cannot', async () => {
  await withClient(async (c) => {
    const list = (await tasks.addTask(c, owner.id, { title: 'shopping list' })).data.task;
    const item = (await tasks.addTask(c, owner.id, { title: 'eggs', parentId: list.id })).data.task;

    const s = (await shares.offerShare(c, owner.id, list.id, viewer.id)).data.share;
    const early = await shares.completeSharedTask(c, viewer.id, item.id);
    assert.equal(early.ok, false, 'an offer nobody accepted let them write');
    assert.equal(early.error.code, 'forbidden');

    await shares.respondToShare(c, viewer.id, s.id, 'accept');
    await c.query(`UPDATE shares SET role = 'viewer' WHERE id = $1`, [s.id]);
    assert.equal((await shares.completeSharedTask(c, viewer.id, item.id)).ok, true,
      "a row written as 'viewer' before the roles went is still refused");

    const added = await shares.addSubtaskToShared(c, viewer.id, list.id, 'butter');
    assert.equal(added.ok, true);
    assert.equal(added.data.task.owner_id, owner.id); // the item is a line on the OWNER's list

    const view = await shares.viewShared(c, viewer.id, s.id);
    assert.ok(view.data.subtasks.some((t) => t.title === 'butter'));

    const acting = await shares.actingOwner(c, viewer.id, item.id);
    assert.equal(String(acting.ownerId), String(owner.id));
    assert.equal(String(acting.share.id), String(s.id));
    assert.deepEqual(await shares.actingOwner(c, owner.id, item.id), { ownerId: owner.id, share: null });
    assert.equal(await shares.actingOwner(c, viewer.id, 999999), null);
  });
});

test('leaving: a participant drops off, the opener hands the task to whoever accepted first', async () => {
  const third = await makeUser(db.pool, '+972541000004', { firstName: 'Third' });
  await withClient(async (c) => {
    const req = await connections.requestConnection(c, owner.id, third.phone, {});
    const c2 = (await connections.respondToConnection(c, third.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, owner.id, c2.id, 'sharing');
    await grants.grantFeature(c, third.id, c2.id, 'sharing');

    const list = (await tasks.addTask(c, owner.id, { title: 'trip' })).data.task;
    const item = (await tasks.addTask(c, owner.id, { title: 'tent', parentId: list.id })).data.task;
    // The order they ACCEPTED in decides who inherits, not the order offered.
    const sThird = (await shares.offerShare(c, owner.id, list.id, third.id)).data.share;
    const sViewer = (await shares.offerShare(c, owner.id, list.id, viewer.id)).data.share;
    await shares.respondToShare(c, viewer.id, sViewer.id, 'accept');
    await c.query(`UPDATE shares SET responded_at = responded_at + interval '1 minute' WHERE id = $1`, [sViewer.id]);
    await shares.respondToShare(c, third.id, sThird.id, 'accept');
    await c.query(`UPDATE shares SET responded_at = responded_at + interval '2 minute' WHERE id = $1`, [sThird.id]);
    const reminders = require('../src/domain/reminders');
    const rem = await reminders.setReminder(c, owner.id, list.id, new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, '+00:00'));
    assert.equal(rem.ok, true, rem.ok ? '' : JSON.stringify(rem.error));

    assert.equal((await shares.leaveTask(c, owner.id, item.id)).error.reason, 'is_item');
    assert.equal((await shares.leaveTask(c, third.id, 999999)).error.code, 'not_found');

    // A participant leaves: their share alone goes, the task does not move.
    const gone = await shares.leaveTask(c, third.id, list.id);
    assert.equal(gone.ok, true, gone.ok ? '' : JSON.stringify(gone.error));
    assert.equal(gone.data.handedTo, null);
    assert.equal((await c.query(`SELECT status FROM shares WHERE id = $1`, [sThird.id])).rows[0].status, 'revoked');
    assert.equal(String((await c.query(`SELECT owner_id FROM tasks WHERE id = $1`, [list.id])).rows[0].owner_id), String(owner.id));
    assert.equal((await shares.leaveTask(c, third.id, list.id)).error.code, 'not_found', 'left twice');

    // The opener leaves: the viewer inherits the list and its items, the
    // opener's pending reminder is cancelled rather than re-aimed at them.
    const handed = await shares.leaveTask(c, owner.id, list.id);
    assert.equal(handed.ok, true, handed.ok ? '' : JSON.stringify(handed.error));
    assert.equal(String(handed.data.handedTo), String(viewer.id));
    const { rows: owned } = await c.query(`SELECT id, owner_id FROM tasks WHERE id = $1 OR parent_id = $1`, [list.id]);
    assert.equal(owned.length, 2);
    for (const r of owned) assert.equal(String(r.owner_id), String(viewer.id), `task ${r.id} stayed with the leaver`);
    assert.equal((await c.query(`SELECT status FROM shares WHERE id = $1`, [sViewer.id])).rows[0].status, 'revoked',
      'the heir kept a share row on a task they now own');
    const { rows: pending } = await c.query(
      `SELECT id FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL AND sent_at IS NULL`, [list.id]);
    assert.equal(pending.length, 0, "the leaver's reminder would now reach the heir");
    assert.equal((await tasks.completeTask(c, viewer.id, item.id)).ok, true, 'the heir cannot tick their own item');
    assert.equal((await shares.leaveTask(c, viewer.id, list.id)).error.reason, 'alone',
      'the last person on a task left it into nobody\'s list');
  });
});

test('a task of mine dropped onto a list shared with me goes to the list\'s owner', async () => {
  await withClient(async (c) => {
    const list = (await tasks.addTask(c, owner.id, { title: 'house' })).data.task;
    const s = (await shares.offerShare(c, owner.id, list.id, viewer.id)).data.share;
    await shares.respondToShare(c, viewer.id, s.id, 'accept');

    const mine = (await tasks.addTask(c, viewer.id, { title: 'fix the tap' })).data.task;
    const res = await shares.adoptIntoList(c, viewer.id, mine.id, list.id);
    assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
    const { rows: [row] } = await c.query(`SELECT owner_id, parent_id FROM tasks WHERE id = $1`, [mine.id]);
    assert.equal(String(row.owner_id), String(owner.id), 'an item on their list that they could not tick');
    assert.equal(String(row.parent_id), String(list.id));
    assert.equal((await tasks.completeTask(c, owner.id, mine.id)).ok, true);
    const { rows: trail } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'task.given'`, [viewer.id]);
    assert.equal(trail.length, 1);
    assert.equal(Number(trail[0].detail.toUserId), Number(owner.id));

    // What may not change hands: a task with a reminder pending, or one that
    // is not theirs outright — and a plain nest into their OWN list is untouched.
    const reminders = require('../src/domain/reminders');
    const nudged = (await tasks.addTask(c, viewer.id, { title: 'call the plumber' })).data.task;
    okOrThrow(await reminders.setReminder(c, viewer.id, nudged.id, new Date(Date.now() + 7200e3).toISOString().replace(/\.\d+Z$/, '+00:00')));
    assert.equal((await shares.adoptIntoList(c, viewer.id, nudged.id, list.id)).error.reason, 'has_reminder');
    assert.equal((await shares.adoptIntoList(c, viewer.id, list.id, list.id)).error.code, 'not_found',
      'the shared list itself went into itself');
    const own = (await tasks.addTask(c, viewer.id, { title: 'my own list' })).data.task;
    const plain = await shares.adoptIntoList(c, viewer.id, nudged.id, own.id);
    assert.equal(plain.ok, true, plain.ok ? '' : JSON.stringify(plain.error));
    assert.equal(String((await c.query(`SELECT owner_id FROM tasks WHERE id = $1`, [nudged.id])).rows[0].owner_id), String(viewer.id));
  });
});

function okOrThrow(r) { assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error)); }

test('sharing requires both sides granted; unshared task is invisible', async () => {
  const stranger = await makeUser(db.pool, '+972541000003', { firstName: 'Stranger' });
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, owner.id, { title: 'secret' })).data.task;
    const noConn = await shares.offerShare(c, owner.id, t.id, stranger.id);
    assert.equal(noConn.error.reason, 'not_connected');

    // viewer cannot complete a task never shared with them
    const denied = await shares.completeSharedTask(c, viewer.id, t.id);
    assert.equal(denied.ok, false);
  });
});

test('cannot share someone else\'s task', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, viewer.id, { title: 'viewer own task' })).data.task;
    const res = await shares.offerShare(c, owner.id, t.id, viewer.id);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'not_found');
  });
});
