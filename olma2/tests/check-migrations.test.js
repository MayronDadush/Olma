'use strict';
// The CLI wrapper around listMigrations(), which tests/db-types.test.js
// already covers thoroughly — this only exercises the thin, untested part:
// exit code and where the message goes when scripts/check-migrations.js runs
// as CI actually runs it, as a subprocess with no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-migrations.js');

test('a clean tree exits 0 and says how many migrations it found', () => {
  const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /^\d+ migrations, no duplicate version numbers\.\n$/);
});

// Staged in a throwaway directory. Writing the decoy into the real
// migrations/ directory — which is what this test did until 2026-09-04 — took
// out whichever other test file happened to be calling freshDb() at that
// instant, and hung it rather than failing it. See incidents.md, "A test file
// poisoned every other one".
test('a real collision exits 1 with the same message listMigrations gives', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-migrations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '001-init.sql'), '-- decoy\n');
  fs.writeFileSync(path.join(dir, '001-decoy-collision.sql'), '-- decoy\n');

  assert.throws(
    () => execFileSync('node', [SCRIPT, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /two migrations share version 1/);
      assert.match(err.stderr, /001-decoy-collision\.sql/);
      return true;
    }
  );
});
