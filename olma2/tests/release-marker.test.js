'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readReleaseMarker, parseStampedAt, MARKER_FILE } = require('../src/adapters/release-marker');

function marked(contents) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-release-'));
  if (contents !== null) fs.writeFileSync(path.join(d, MARKER_FILE), contents);
  return d;
}

// Byte-for-byte what deploy.sh wrote onto the live box, so this test fails if
// the marker's shape ever changes underneath the reader.
const LIVE = [
  'sha=1cd3c6352300aa1a72fdb5568092844bb441d519',
  'subject=ops: the rollback was one release deep, on a five-merge day (#126)',
  'deployed_at=2026-09-03T21-15-59Z',
  'origin=github-actions run 33802418775',
  '',
].join('\n');

test('the real marker from the live box parses completely', () => {
  const r = readReleaseMarker(marked(LIVE));
  assert.equal(r.known, true);
  assert.equal(r.sha, '1cd3c6352300aa1a72fdb5568092844bb441d519');
  assert.equal(r.short, '1cd3c6352300');
  assert.equal(r.subject, 'ops: the rollback was one release deep, on a five-merge day (#126)');
  assert.equal(r.origin, 'github-actions run 33802418775');
  assert.equal(r.at.toISOString(), '2026-09-03T21:15:59.000Z');
});

test("the stamp's path-safe time is undone without touching the date", () => {
  // deploy.sh writes `-` where a clock puts `:` because the same string names
  // an archive directory. Only the time-of-day half may be rewritten.
  assert.equal(parseStampedAt('2026-09-03T21-15-59Z').toISOString(), '2026-09-03T21:15:59.000Z');
  assert.equal(parseStampedAt('2026-01-02T00-00-00Z').toISOString(), '2026-01-02T00:00:00.000Z');
  assert.equal(parseStampedAt('nonsense'), null);
  assert.equal(parseStampedAt(null), null);
});

test('no marker is unknown, never a fault', () => {
  // Any box deployed before #126, and every dev checkout. Rendering this red
  // would put a problem on the dashboard for a healthy system.
  assert.deepEqual(readReleaseMarker(marked(null)), { known: false });
});

test('a marker with no usable sha is unknown rather than a guess', () => {
  assert.equal(readReleaseMarker(marked('subject=x\ndeployed_at=2026-09-03T21-15-59Z\n')).known, false);
  assert.equal(readReleaseMarker(marked('sha=unknown\n')).known, false, 'deploy.sh writes literal "unknown" outside a git checkout');
  assert.equal(readReleaseMarker(marked('garbage\n')).known, false);
});

test('a sha whose timestamp is unreadable still identifies the release', () => {
  // The sha answers "what is running"; the clock is context, and losing it
  // must not throw away the identifier.
  const r = readReleaseMarker(marked('sha=abcdef1234567\ndeployed_at=whenever\n'));
  assert.equal(r.known, true);
  assert.equal(r.short, 'abcdef1234567'.slice(0, 12));
  assert.equal(r.at, null);
});

test('a commit subject cannot smuggle another field in', () => {
  // The subject is arbitrary text from a commit; a newline inside it would
  // otherwise let it declare its own origin= line.
  const r = readReleaseMarker(marked('sha=abcdef1234567\nsubject=fix: thing\norigin=real\n'));
  assert.equal(r.subject, 'fix: thing');
  assert.equal(r.origin, 'real');
});
