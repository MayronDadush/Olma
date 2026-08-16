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

    const s = (await shares.offerShare(c, owner.id, project.id, viewer.id, 'viewer')).data.share;
    await shares.respondToShare(c, viewer.id, s.id, 'accept');

    let view = await shares.viewShared(c, viewer.id, s.id);
    assert.equal(view.data.subtasks.length, 1);

    // dynamic cascade: new subtask visible with NO re-share
    await tasks.addTask(c, owner.id, { title: 'bread', parentId: project.id });
    view = await shares.viewShared(c, viewer.id, s.id);
    assert.equal(view.data.subtasks.length, 2);
  });
});

test('viewer role cannot write; editor can complete and add subtasks', async () => {
  await withClient(async (c) => {
    const list = (await tasks.addTask(c, owner.id, { title: 'shopping list' })).data.task;
    const item = (await tasks.addTask(c, owner.id, { title: 'eggs', parentId: list.id })).data.task;

    // viewer-role share first
    const sv = (await shares.offerShare(c, owner.id, list.id, viewer.id, 'viewer')).data.share;
    await shares.respondToShare(c, viewer.id, sv.id, 'accept');
    const denied = await shares.completeSharedTask(c, viewer.id, item.id);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'forbidden');

    // upgrade path: revoke, re-offer as editor
    await shares.revokeShare(c, owner.id, sv.id);
    const se = (await shares.offerShare(c, owner.id, list.id, viewer.id, 'editor')).data.share;
    await shares.respondToShare(c, viewer.id, se.id, 'accept');

    const done = await shares.completeSharedTask(c, viewer.id, item.id);
    assert.equal(done.ok, true);

    const added = await shares.addSubtaskToShared(c, viewer.id, list.id, 'butter');
    assert.equal(added.ok, true);
    assert.equal(added.data.task.owner_id, owner.id); // task belongs to the OWNER, editor just wrote it

    const view = await shares.viewShared(c, viewer.id, se.id);
    assert.ok(view.data.subtasks.some((t) => t.title === 'butter'));
  });
});

test('sharing requires both sides granted; unshared task is invisible', async () => {
  const stranger = await makeUser(db.pool, '+972541000003', { firstName: 'Stranger' });
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, owner.id, { title: 'secret' })).data.task;
    const noConn = await shares.offerShare(c, owner.id, t.id, stranger.id, 'viewer');
    assert.equal(noConn.error.reason, 'not_connected');

    // viewer cannot complete a task never shared with them
    const denied = await shares.completeSharedTask(c, viewer.id, t.id);
    assert.equal(denied.ok, false);
  });
});

test('cannot share someone else\'s task', async () => {
  await withClient(async (c) => {
    const t = (await tasks.addTask(c, viewer.id, { title: 'viewer own task' })).data.task;
    const res = await shares.offerShare(c, owner.id, t.id, viewer.id, 'viewer');
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'not_found');
  });
});
