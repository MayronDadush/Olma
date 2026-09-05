'use strict';
// What this suite is actually defending: the four states must stay four.
//
// The cheap version of this job is a boolean — "same sha or not" — and it
// would have been wrong in the exact situation that motivated it. GitHub
// unreachable is not "in sync", a box running a commit that is not on GitHub
// is not "behind", and a drift that has lasted six hours must not re-date
// itself to "just now" on every tick. Each of those is one line of code and
// one collapsed distinction away.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const drift = require('../src/jobs/deploy-drift');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const withClient = async (fn) => {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
};

const MARKER = { known: true, sha: 'b5f8370c91079d7a8997f76830492f92e132c6f7', short: 'b5f8370c9107' };

// A stand-in GitHub. Never a real network call: this suite runs on the
// production box as well as on CI runners, and a test that reaches the
// internet fails for reasons that have nothing to do with the branch.
const github = (body, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// The previous tick, as the job itself would have left it.
async function seed(note) {
  await db.pool.query(
    `INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at, note)
     VALUES ('deploy_drift', now(), now(), $1)
     ON CONFLICT (job_name) DO UPDATE SET note = excluded.note`,
    [note === null ? null : JSON.stringify(note)]);
}
const clearSeed = () => db.pool.query(`DELETE FROM job_heartbeats WHERE job_name = 'deploy_drift'`);

test('no RELEASE marker is unknown, not a drifted deploy', async () => {
  await clearSeed();
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: { known: false },
    fetchImpl: async () => { throw new Error('must not be called'); },
  }));
  assert.equal(out.state, 'unknown');
  assert.match(out.why, /marker/);
});

test('identical to main is in_sync and carries the running sha', async () => {
  await clearSeed();
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ status: 'identical', ahead_by: 0 }),
  }));
  assert.equal(out.state, 'in_sync');
  assert.equal(out.local, 'b5f8370c9107');
});

test('main ahead is behind, by the number of commits main has that we do not', async () => {
  await clearSeed();
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ status: 'ahead', ahead_by: 3 }),
  }));
  assert.equal(out.state, 'behind');
  assert.equal(out.by, 3);
  assert.ok(out.since, 'a drift is dated from when it started');
});

// The whole value of the row is "this has been true for six hours". A `since`
// recomputed every tick would say "just now" for ever, which reads as a
// deploy that is about to happen rather than one that never will.
test('an ongoing drift keeps its original start time', async () => {
  const started = '2026-09-04T06:00:00.000Z';
  await seed({ state: 'behind', local: 'b5f8370c9107', by: 2, since: started, at: '2026-09-04T09:00:00.000Z' });
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ status: 'ahead', ahead_by: 5 }),
    now: '2026-09-04T10:00:00.000Z',
  }));
  assert.equal(out.since, started, 'four hours behind, not one tick behind');
  assert.equal(out.by, 5, 'but the distance is re-measured, not carried');
});

// A deploy happened and left the box behind again — a different gap, so a
// different clock. Carrying the old `since` here would report one continuous
// six-hour drift across a deploy that did in fact run.
test('a new release restarts the clock even if it is still behind', async () => {
  await seed({ state: 'behind', local: 'oldoldoldold', by: 2, since: '2026-09-04T06:00:00.000Z' });
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ status: 'ahead', ahead_by: 1 }),
    now: '2026-09-04T10:00:00.000Z',
  }));
  assert.equal(out.since, '2026-09-04T10:00:00.000Z');
});

test('an unreachable GitHub is unchecked — never in_sync', async () => {
  await seed({ state: 'in_sync', local: 'b5f8370c9107', at: '2026-09-04T09:00:00.000Z' });
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
  }));
  assert.equal(out.state, 'unchecked');
  assert.equal(out.lastKnown, 'in_sync');
  assert.equal(out.lastCheckedAt, '2026-09-04T09:00:00.000Z', 'the row says how old its answer is');
});

// Otherwise the second hour of an outage erases what the first hour still
// knew, and a three-day outage ends with a row that has never known anything.
test('a second failed check does not overwrite the last real verdict', async () => {
  await seed({ state: 'unchecked', why: 'ENOTFOUND', local: 'b5f8370c9107', lastKnown: 'behind', lastCheckedAt: '2026-09-04T08:00:00.000Z' });
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  }));
  assert.equal(out.state, 'unchecked');
  assert.equal(out.lastKnown, 'behind', 'not "unchecked"');
  assert.equal(out.lastCheckedAt, '2026-09-04T08:00:00.000Z');
});

// A sha GitHub has never heard of is a stranger state than being behind: it
// means the box is running something that is not on main at all — a hand
// deploy, or a commit orphaned by a force-push. Saying "behind by 0" there
// would be a confident wrong answer.
test('a deployed sha GitHub does not know says so, and is not in_sync', async () => {
  await clearSeed();
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ message: 'Not Found' }, 404),
  }));
  assert.equal(out.state, 'unchecked');
  assert.match(out.why, /not on GitHub/);
});

test('a 5xx is unchecked, not a verdict', async () => {
  await clearSeed();
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({}, 503),
  }));
  assert.equal(out.state, 'unchecked');
  assert.match(out.why, /503/);
});

// job_heartbeats.note is 200 chars and this note is read back next tick — an
// overflow truncates it into invalid JSON, the parse fails, and `since`
// silently resets every hour. The longest state is 'unchecked' with every
// field populated; this pins it.
test('the worst-case note fits the column and survives a round trip', async () => {
  await seed({ state: 'in_sync', local: 'b5f8370c9107', at: '2026-09-04T09:00:00.000Z' });
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: async () => { throw new Error('x'.repeat(300)); },
  }));
  const note = JSON.stringify(out);
  assert.ok(note.length <= drift.NOTE_MAX, `note is ${note.length} chars, column holds ${drift.NOTE_MAX}`);
  assert.deepEqual(JSON.parse(note.slice(0, drift.NOTE_MAX)), out, 'the stored note parses back');
});

// Nothing here is allowed to be the reason a heartbeat goes ERR: the job is
// pure observation, and a job that errors gets counted as a problem on the
// health page — which would make a GitHub outage look like a broken sweep.
test('a corrupt previous note is ignored rather than thrown on', async () => {
  await db.pool.query(
    `INSERT INTO job_heartbeats (job_name, last_run_at, note) VALUES ('deploy_drift', now(), $1)
     ON CONFLICT (job_name) DO UPDATE SET note = excluded.note`, ['{"state":"behi']);
  const out = await withClient((c) => drift.sweepDeployDrift(c, {
    marker: MARKER, fetchImpl: github({ status: 'ahead', ahead_by: 2 }),
    now: '2026-09-04T10:00:00.000Z',
  }));
  assert.equal(out.state, 'behind');
  assert.equal(out.since, '2026-09-04T10:00:00.000Z');
});

test('the job is armed on a cadence, so a check that goes quiet reads as stale', () => {
  const { JOB_INTERVAL_SECONDS, shouldKickOnStart } = require('../src/jobs/expectations');
  assert.equal(JOB_INTERVAL_SECONDS.deploy_drift, 3600);
  // Every deploy restarts brokerd, and setInterval counts from process start —
  // an hourly job on a box that redeploys more often than that would never run.
  assert.equal(shouldKickOnStart('deploy_drift'), true);
  // Armed = listed in the job registry the daemon loops over.
  const { jobs } = require('../src/jobs/registry');
  const inertPool = { query: () => { throw new Error('no queries while listing jobs'); } };
  assert.ok(jobs({ pool: inertPool }).some((j) => j.name === 'deploy_drift'), 'deploy_drift is armed');
});

test('it compares against main, on this repo', () => {
  assert.equal(drift.BRANCH, 'main');
  assert.equal(drift.REPO, 'MayronDadush/Olma');
});
