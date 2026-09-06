'use strict';
// jobs/registry.js is the list of what brokerd arms; jobs/expectations.js is
// how often each must run and what /health judges staleness against. Two
// lists describing one fact is the exact shape that drifted once already
// (brokerd carried its own copy of every interval). This file is what holds
// them together now: a job with no cadence would be armed at the fallback
// hour and read as healthy; a cadence with no job would be a row that never
// turns red because nothing ever writes it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jobs } = require('../src/jobs/registry');
const { JOB_INTERVAL_SECONDS } = require('../src/jobs/expectations');

// Rows in job_heartbeats that something OTHER than this daemon writes, and so
// have a cadence but no entry here. Each one is named, on purpose: a job that
// quietly stops being armed must not be able to hide in an "other" bucket.
const NOT_ARMED = new Set([
  'brokerd',        // the daemon's own liveness beat, written directly at startup and every 60s
  'backup_offbox',  // root's crontab (scripts/backup-offbox.sh) writes it after the nightly dump
]);

// A pool nothing here should ever query: building the list must be pure.
const inertPool = {
  query: () => { throw new Error('jobs() must not query the database while building the list'); },
  connect: () => { throw new Error('jobs() must not check out a client while building the list'); },
};

test('every armed job has a cadence, and every cadence names an armed job', () => {
  const list = jobs({ pool: inertPool });
  const names = list.map((j) => j.name);
  assert.deepEqual(names, [...new Set(names)], 'no job is armed twice');
  for (const j of list) {
    assert.equal(typeof j.run, 'function', `${j.name} has a run()`);
    assert.ok(JOB_INTERVAL_SECONDS[j.name], `${j.name} has a cadence in expectations.js`);
  }
  const orphans = Object.keys(JOB_INTERVAL_SECONDS).filter((n) => !names.includes(n) && !NOT_ARMED.has(n));
  assert.deepEqual(orphans, [], 'cadences with nothing armed under them (add to NOT_ARMED only if something else writes the row)');
});

test('the daemon knows the jobs only as a list — no arm() by name survives in bin/olma-brokerd.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'olma-brokerd.js'), 'utf8');
  assert.doesNotMatch(src, /arm\('/, 'a job armed by name in the daemon is one the registry does not know about');
  assert.match(src, /for \(const job of list\) arm\(job\.name, job\.run\)/);
});

test('the order is the arming order the daemon had: outbox first, drift last', () => {
  const names = jobs({ pool: inertPool }).map((j) => j.name);
  assert.equal(names[0], 'outbox_worker');
  assert.equal(names[names.length - 1], 'deploy_drift');
  assert.equal(names.length, 26); // +onboarding_review, 2026-09-05
});
