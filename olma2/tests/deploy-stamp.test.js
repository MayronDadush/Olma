'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDeployStamp, STAMP_FILE } = require('../src/adapters/deploy-stamp');

function stamped(contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-stamp-'));
  if (contents !== null) fs.writeFileSync(path.join(d, STAMP_FILE), contents);
  return d;
}

test('a written stamp reads back as the release that is serving', () => {
  const d = stamped('sha=6662cf1a2b3c\nat=2026-09-03T20:15:00Z\n');
  const r = readDeployStamp(d);
  assert.equal(r.known, true);
  assert.equal(r.sha, '6662cf1a2b3c');
  assert.equal(r.at.toISOString(), '2026-09-03T20:15:00.000Z');
});

test('no stamp at all is unknown, never a fault', () => {
  // Every box deployed before this shipped has no file, and so does any dev
  // checkout. Treating that as a problem would put a red row on the dashboard
  // for a perfectly healthy system.
  assert.deepEqual(readDeployStamp(stamped(null)), { known: false });
});

test('half a stamp is not a release identifier', () => {
  // A file that exists but carries no sha is unknown rather than a guess —
  // reporting a partial stamp as a version is worse than reporting nothing.
  assert.equal(readDeployStamp(stamped('at=2026-09-03T20:15:00Z\n')).known, false);
  assert.equal(readDeployStamp(stamped('garbage\n')).known, false);
  assert.equal(readDeployStamp(stamped('sha=nothex\n')).known, false);
});

test('a sha with an unreadable timestamp still identifies the release', () => {
  // The sha is the answer to "what is running"; the time is context. Losing
  // the clock must not throw away the identifier.
  const r = readDeployStamp(stamped('sha=abcdef1234\nat=not-a-date\n'));
  assert.equal(r.known, true);
  assert.equal(r.sha, 'abcdef1234');
  assert.equal(r.at, null);
});
