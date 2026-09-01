'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { repairIdentityFiles } = require('../src/domain/identity-repair');

let db, tmp;

// chattr is unavailable (and unwanted) in a /tmp fixture, so the immutable
// calls are recorded rather than performed. What the tests care about is that
// the unlock/relock happens at all, and for WHICH files.
function recorder({ lsattrLocked = true } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args[0]} ${path.basename(path.dirname(args[args.length - 1]))}`);
    if (cmd === 'lsattr') return lsattrLocked ? `----i---------e------- ${args[0]}` : `--------------e------- ${args[0]}`;
    return '';
  };
  return { calls, run };
}

function workspace(agentId, token) {
  const w = path.join(tmp, agentId);
  fs.mkdirSync(w, { recursive: true });
  if (token !== null) fs.writeFileSync(path.join(w, '.olma-identity'), token + '\n', { mode: 0o600 });
  return w;
}

before(async () => {
  db = await freshDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-idrepair-'));
});
after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.teardown();
});

test('a mismatched identity file is rewritten from the DB, and audited', async () => {
  const u = await makeUser(db.pool, '+972700000001');
  const w = workspace('u-a', 'olma_tok_' + 'f'.repeat(32));
  await db.pool.query('UPDATE users SET workspace_path = $2 WHERE id = $1', [u.id, w]);

  const dry = await repairIdentityFiles(db.pool, { apply: false, run: recorder().run });
  assert.deepEqual(dry.repaired, [Number(u.id)], 'dry run names the user');
  assert.equal(fs.readFileSync(path.join(w, '.olma-identity'), 'utf8').trim(),
    'olma_tok_' + 'f'.repeat(32), 'dry run changes nothing on disk');

  const { rows: [db1] } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  const r = await repairIdentityFiles(db.pool, { apply: true, run: recorder().run });
  assert.deepEqual(r.repaired, [Number(u.id)]);
  assert.equal(fs.readFileSync(path.join(w, '.olma-identity'), 'utf8').trim(), db1.identity_token);
  assert.equal(fs.statSync(path.join(w, '.olma-identity')).mode & 0o777, 0o600);

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'admin.identity_repaired'`, [u.id]);
  assert.equal(rows[0].n, 1, 'the repair names who it touched');
});

// The whole point of the backfill. The eight files that broke on 2026-09-01
// all MATCHED the DB right up until the moment they did not — locking only
// the mismatched ones would leave every healthy user exactly as exposed.
test('a file that already matches is still locked', async () => {
  const u = await makeUser(db.pool, '+972700000002');
  const { rows: [row] } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  const w = workspace('u-b', row.identity_token);
  await db.pool.query('UPDATE users SET workspace_path = $2 WHERE id = $1', [u.id, w]);

  const rec = recorder();
  const r = await repairIdentityFiles(db.pool, { apply: true, run: rec.run });

  assert.ok(!r.repaired.includes(Number(u.id)), 'nothing to rewrite');
  assert.ok(r.alreadyOk >= 1);
  assert.ok(rec.calls.includes('chattr +i u-b'), 'a correct file is locked anyway');
});

test('the unlock precedes the write — the bit stops root too', async () => {
  const u = await makeUser(db.pool, '+972700000003');
  const w = workspace('u-c', 'olma_tok_' + '0'.repeat(32));
  await db.pool.query('UPDATE users SET workspace_path = $2 WHERE id = $1', [u.id, w]);

  const rec = recorder();
  await repairIdentityFiles(db.pool, { apply: true, run: rec.run });
  const mine = rec.calls.filter((c) => c.endsWith('u-c'));
  assert.equal(mine[0], 'chattr -i u-c', 'unlock first, or the write fails EPERM on a protected file');
  assert.ok(mine.includes('chattr +i u-c'), 'and it is locked again afterwards');
});

// A result that claims a lock it did not get is worse than one that admits
// the filesystem cannot do this — the operator would stop looking.
test('a lock that did not take is reported, never counted as locked', async () => {
  const u = await makeUser(db.pool, '+972700000004');
  const w = workspace('u-d', 'olma_tok_' + '1'.repeat(32));
  await db.pool.query('UPDATE users SET workspace_path = $2 WHERE id = $1', [u.id, w]);

  const r = await repairIdentityFiles(db.pool, {
    apply: true, run: recorder({ lsattrLocked: false }).run,
  });
  assert.ok(r.lockFailed >= 1, 'the failure is counted');
});

// Writing a token into a directory that may no longer be this person's
// workspace is worse than the auth failure it would paper over.
test('a missing identity file is reported, never written blind', async () => {
  const u = await makeUser(db.pool, '+972700000005');
  const w = workspace('u-e', null);
  await db.pool.query('UPDATE users SET workspace_path = $2 WHERE id = $1', [u.id, w]);

  const r = await repairIdentityFiles(db.pool, { apply: true, run: recorder().run });
  assert.ok(r.missing >= 1);
  assert.equal(fs.existsSync(path.join(w, '.olma-identity')), false, 'still absent');
  assert.ok(!r.repaired.includes(Number(u.id)));
});
