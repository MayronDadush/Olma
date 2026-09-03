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

test('the eval user cannot file into the operator list, and is not an error either', async () => {
  const evalUser = await makeUser(db.pool, '+972599999901');
  await db.pool.query('UPDATE users SET is_eval = true WHERE id = $1', [evalUser.id]);

  await withClient(async (c) => {
    const before = (await issues.listIssues(c, { status: 'new' })).data.issues.length;

    // The nightly school-essay scenario: the agent refuses correctly, and its
    // doctrine tells it to log the gap. That call must not reach the list.
    const r = await issues.reportIssue(c, evalUser.id, {
      category: 'feature_request', source: 'agent_detected',
      title: 'User requested a 300-word essay on Herzl for school',
      detail: 'general writing is out of scope',
    });
    assert.equal(r.ok, true, 'a dropped call must not fail the scenario under test');
    assert.equal(r.data.issue, null);
    assert.equal(r.data.dropped, 'eval_user');

    const after = (await issues.listIssues(c, { status: 'new' })).data.issues;
    assert.equal(after.length, before, 'nothing was written');
    assert.equal(after.some((i) => Number(i.reporter_id) === Number(evalUser.id)), false);
  });
});

test('a real user filing the very same issue is untouched', async () => {
  await withClient(async (c) => {
    // The seal is on WHO reports, never on what the issue says — otherwise a
    // real person hitting the same gap would be silenced by a keyword.
    const r = await issues.reportIssue(c, user.id, {
      category: 'feature_request', source: 'agent_detected',
      title: 'User requested a 300-word essay on Herzl for school',
    });
    assert.equal(r.ok, true);
    assert.ok(r.data.issue && r.data.issue.id, 'a real report still lands');
    assert.equal(Number(r.data.issue.reporter_id), Number(user.id));
  });
});

test('a malformed call from the eval user is still refused, not swallowed', async () => {
  const evalUser2 = await makeUser(db.pool, '+972599999902');
  await db.pool.query('UPDATE users SET is_eval = true WHERE id = $1', [evalUser2.id]);
  await withClient(async (c) => {
    // Validation runs before the seal: a bad call from the suite is a defect
    // in the doctrine under test, and hiding it defeats the point of the suite.
    const r = await issues.reportIssue(c, evalUser2.id, {
      category: 'rant', source: 'agent_detected', title: 'x',
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /category must be one of/);
  });
});
