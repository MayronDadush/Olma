'use strict';
// prune-releases.sh is the only line in the deploy path that deletes, it runs
// unattended on production after every merge, and its failure modes are silent
// in both directions: delete too much and the rollback archive is empty on the
// morning it is needed; delete nothing and the disk fills. So it is driven
// here as a real script against real directories, not reasoned about.
//
// These are filesystem tests, not database tests — no freshDb, no pool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'prune-releases.sh');

function tmpArchive(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-releases-'));
  for (const n of names) {
    fs.mkdirSync(path.join(dir, n));
    // Something inside, so an accidental `rmdir`-style deletion would not pass
    // where a real `rm -rf` is required.
    fs.writeFileSync(path.join(dir, n, 'RELEASE'), `sha=deadbeef\nstamp=${n}\n`);
  }
  return dir;
}

function prune(dir, keep) {
  const args = keep === undefined ? [SCRIPT, dir] : [SCRIPT, dir, String(keep)];
  return execFileSync('bash', args, { encoding: 'utf8' });
}

function pruneFails(dir, keep) {
  try {
    prune(dir, keep);
    return null;
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr || '') };
  }
}

// ISO-8601 UTC stamps sort lexicographically into chronological order, which
// is the whole reason the archive uses them. Deliberately out of order here so
// a prune that trusted readdir order rather than sorting would fail.
const STAMPS = [
  '2026-09-01T09-00-00Z',
  '2026-09-03T18-21-04Z',
  '2026-08-28T23-59-59Z',
  '2026-09-02T12-30-00Z',
  '2026-09-03T07-15-00Z',
  '2026-08-30T04-00-00Z',
  '2026-09-03T20-00-00Z',
];

function remaining(dir) {
  return fs.readdirSync(dir).sort();
}

test('it deletes the oldest and keeps exactly the newest N', () => {
  const dir = tmpArchive(STAMPS);
  prune(dir, 3);
  assert.deepEqual(remaining(dir), [
    '2026-09-03T07-15-00Z',
    '2026-09-03T18-21-04Z',
    '2026-09-03T20-00-00Z',
  ]);
});

test('under the limit it deletes nothing at all', () => {
  const dir = tmpArchive(STAMPS.slice(0, 3));
  const out = prune(dir, 5);
  assert.equal(remaining(dir).length, 3);
  assert.match(out, /nothing to delete/);
});

test('exactly at the limit it deletes nothing — the boundary, not one past it', () => {
  const dir = tmpArchive(STAMPS.slice(0, 5));
  prune(dir, 5);
  assert.equal(remaining(dir).length, 5);
});

test('an empty archive is not an error', () => {
  const dir = tmpArchive([]);
  const out = prune(dir, 5);
  assert.equal(remaining(dir).length, 0);
  assert.match(out, /nothing to delete/);
});

test('a missing archive is not an error — the first deploy has none yet', () => {
  const dir = path.join(os.tmpdir(), 'olma-releases-does-not-exist-' + process.pid);
  const out = prune(dir, 5);
  assert.match(out, /nothing to prune/);
});

test('the deletion is recursive — a release is a whole tree, not an empty dir', () => {
  const dir = tmpArchive(STAMPS);
  fs.mkdirSync(path.join(dir, STAMPS[2], 'src', 'domain'), { recursive: true });
  fs.writeFileSync(path.join(dir, STAMPS[2], 'src', 'domain', 'flags.js'), 'x');
  prune(dir, 3);
  assert.ok(!fs.existsSync(path.join(dir, STAMPS[2])), 'oldest release should be gone entirely');
});

test('a stray file is neither counted nor deleted', () => {
  // Something that is not a release must not push a real release over the
  // limit, and must not be destroyed by a script that only owns directories.
  const dir = tmpArchive(STAMPS.slice(0, 5));
  fs.writeFileSync(path.join(dir, 'NOTES.txt'), 'left here by a human');
  prune(dir, 5);
  assert.ok(fs.existsSync(path.join(dir, 'NOTES.txt')), 'stray file must survive');
  assert.equal(remaining(dir).filter((n) => n !== 'NOTES.txt').length, 5);
});

test('keep=0 is refused, not obeyed', () => {
  // The state this whole feature exists to prevent is an outage with nothing
  // to roll back to. A deploy variable typoed to 0 must not create it.
  const dir = tmpArchive(STAMPS.slice(0, 3));
  const fail = pruneFails(dir, 0);
  assert.ok(fail, 'should have exited non-zero');
  assert.match(fail.stderr, /refusing to keep/);
  assert.equal(remaining(dir).length, 3, 'and it must not have deleted anything first');
});

test('a non-numeric keep is refused rather than silently treated as zero', () => {
  const dir = tmpArchive(STAMPS.slice(0, 3));
  const fail = pruneFails(dir, 'five');
  assert.ok(fail);
  assert.match(fail.stderr, /whole number/);
  assert.equal(remaining(dir).length, 3);
});

test('no archive directory at all is a usage error, not a silent success', () => {
  // `prune-releases.sh` with an unset variable would otherwise expand to
  // nothing and operate on the current directory.
  let failed = false;
  try {
    execFileSync('bash', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    failed = true;
    assert.match(String(err.stderr), /no archive directory given/);
  }
  assert.ok(failed, 'a missing argument must not exit 0');
});

test('it says what it kept, not only what it deleted', () => {
  // A prune that goes quiet is indistinguishable from a prune that did not
  // run. The deploy log has to carry both halves.
  const dir = tmpArchive(STAMPS);
  const out = prune(dir, 2);
  assert.match(out, /deleted 2026-08-28T23-59-59Z/);
  assert.match(out, /kept 2026-09-03T20-00-00Z/);
});

test('the default keep is 5 when none is given', () => {
  const dir = tmpArchive(STAMPS);
  prune(dir);
  assert.equal(remaining(dir).length, 5);
});
