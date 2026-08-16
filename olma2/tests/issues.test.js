'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const issues = require('../src/domain/issues');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972561000001');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('report → triage → fixed lifecycle, filterable listing', async () => {
  await withClient(async (c) => {
    const r = await issues.reportIssue(c, user.id, {
      category: 'friction', source: 'agent_detected',
      title: 'user retried task creation 3 times',
      relatedEntityType: 'task', relatedEntityId: 42,
    });
    assert.equal(r.ok, true);

    await issues.reportIssue(c, null, {
      category: 'feature_request', source: 'user_reported', title: 'wants recurring digests',
    });

    const frictionOnly = await issues.listIssues(c, { category: 'friction' });
    assert.equal(frictionOnly.data.issues.length, 1);

    const moved = await issues.setStatus(c, r.data.issue.id, 'triaged');
    assert.equal(moved.data.issue.status, 'triaged');
    const done = await issues.setStatus(c, r.data.issue.id, 'fixed');
    assert.equal(done.data.issue.status, 'fixed');

    const openOnly = await issues.listIssues(c, { status: 'new' });
    assert.equal(openOnly.data.issues.length, 1); // only the feature request remains new
  });
});

test('validation: bad category/source/status rejected', async () => {
  await withClient(async (c) => {
    const badCat = await issues.reportIssue(c, null, { category: 'rant', source: 'user_reported', title: 'x' });
    assert.equal(badCat.ok, false);
    const badSrc = await issues.reportIssue(c, null, { category: 'bug', source: 'psychic', title: 'x' });
    assert.equal(badSrc.ok, false);
    const badStatus = await issues.setStatus(c, 1, 'maybe');
    assert.equal(badStatus.ok, false);
  });
});
