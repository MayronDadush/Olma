'use strict';
// No test may write into the repo's real migrations/ directory.
//
// This is the guard for the CI wedge of 2026-09-03/04 (incidents.md, "A test
// file poisoned every other one"). Two tests staged a duplicate-version
// collision by dropping a decoy .sql file into the real migrations/ directory
// for a few milliseconds. Test files are separate PROCESSES sharing one
// filesystem, so any other file that happened to call freshDb() in that window
// ran migrate() -> listMigrations(), which correctly threw — in its `before`
// hook, with a pg Client already connected and now never closed. An open
// socket keeps the event loop alive, so that child never exited, and
// `node --test` waited on `once(child, 'exit')` for ever, printing nothing.
// Roughly 1 run in 8-25. It read as an upstream runner bug for two evenings.
//
// The fix was to give listMigrations() a directory argument so a collision can
// be staged in a temp dir. This stops the pattern coming back under a new name
// — the shared directory is what makes it dangerous, not the decoy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;

const MUTATORS = 'writeFileSync|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync|cpSync|createWriteStream|writeSync';

// A name is "tainted" if it refers to the real migrations directory, directly
// or through one hop of path.join. Note what does NOT taint: mkdtempSync with
// a prefix like 'olma2-migrations-', because the literal is not `'migrations'`
// — a temp directory is exactly the safe thing this guard wants to permit.
function taintedNames(src) {
  const assigns = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)]
    .map((m) => ({ name: m[1], expr: m[2] }));
  const tainted = new Set();
  const seedsReal = (expr) => /(^|[^\w$])MIGRATIONS_DIR([^\w$]|$)/.test(expr)
    || /['"]migrations['"]/.test(expr);
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of assigns) {
      if (tainted.has(a.name)) continue;
      const refsTainted = [...tainted].some(
        (t) => new RegExp(`(^|[^\\w$])${t}([^\\w$]|$)`).test(a.expr));
      if (seedsReal(a.expr) || refsTainted) { tainted.add(a.name); changed = true; }
    }
  }
  return tainted;
}

function offendingWrites(src) {
  const tainted = taintedNames(src);
  const out = [];
  // path.join(...) first: the identifier branch would otherwise match just
  // `path` and then find nothing tainted about it.
  const re = new RegExp(`fs\\.(?:${MUTATORS})\\(\\s*(path\\.join\\([^)]*\\)|[A-Za-z_$][\\w$]*)`, 'g');
  for (const m of src.matchAll(re)) {
    const arg = m[1];
    const hit = arg.startsWith('path.join')
      ? (/['"]migrations['"]/.test(arg) || [...tainted].some(
          (t) => new RegExp(`(^|[^\\w$])${t}([^\\w$]|$)`).test(arg)))
      : tainted.has(arg);
    if (hit) out.push(src.slice(0, m.index).split('\n').length);
  }
  return out;
}

test('no test writes into the real migrations/ directory', () => {
  const offenders = [];
  const files = fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.js'))
    // This file itself carries the forbidden pattern on purpose, as the sample
    // the guard is checked against below.
    .filter((f) => f !== path.basename(__filename));
  assert.ok(files.length > 20, 'the scan found almost no test files — it is not looking where it thinks');
  for (const file of files) {
    const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
    for (const line of offendingWrites(src)) offenders.push(`${file}:${line}`);
  }
  assert.deepEqual(offenders, [],
    'a test that mutates the shared migrations/ directory breaks every OTHER '
    + 'test file that calls freshDb() while the file is on disk — stage the '
    + 'collision in a temp dir and pass it to listMigrations(dir) instead');
});

// A guard that can no longer fail is not a guard. This is the code that was
// actually there, verbatim in shape, and it must still be caught.
test('the guard still catches the pattern it was written for', () => {
  const before = `
    const dir = path.join(__dirname, '..', 'migrations');
    const decoy = path.join(dir, '001-decoy-collision.sql');
    fs.writeFileSync(decoy, '-- deliberate collision\\n');
  `;
  assert.equal(offendingWrites(before).length, 1);

  const alsoBefore = `
    const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
    fs.writeFileSync(path.join(MIGRATIONS_DIR, '001-decoy.sql'), 'x');
  `;
  assert.equal(offendingWrites(alsoBefore).length, 1);

  // and the replacement is not flagged
  const after = `
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-migrations-'));
    fs.writeFileSync(path.join(dir, '001-init.sql'), '-- decoy\\n');
  `;
  assert.equal(offendingWrites(after).length, 0);
});
