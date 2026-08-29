'use strict';
// The CLI wrapper around listMigrations(), which tests/db-types.test.js
// already covers thoroughly — this only exercises the thin, untested part:
// exit code and where the message goes when scripts/check-migrations.js runs
// as CI actually runs it, as a subprocess with no database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-migrations.js');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

test('a clean tree exits 0 and says how many migrations it found', () => {
  const out = execFileSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.match(out, /^\d+ migrations, no duplicate version numbers\.\n$/);
});

test('a real collision exits 1 with the same message listMigrations gives', (t) => {
  const decoy = path.join(MIGRATIONS_DIR, '001-decoy-collision.sql');
  fs.writeFileSync(decoy, '-- deliberate collision, removed by this test\n');
  t.after(() => fs.rmSync(decoy, { force: true }));

  assert.throws(
    () => execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /two migrations share version 1/);
      assert.match(err.stderr, /001-decoy-collision\.sql/);
      return true;
    }
  );
});
