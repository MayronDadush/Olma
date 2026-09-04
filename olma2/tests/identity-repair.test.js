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

// ---- rotating a leaked token ------------------------------------------------

const { rotateIdentityToken } = require('../src/domain/identity-repair');
const { renderAgentsMd } = require('../src/intake/provision');
const usersDomain = require('../src/domain/users');
const { fingerprint } = require('../src/domain/token-leak');

// A workspace complete enough to rotate: both the primary (AGENTS.md) and the
// recovery (.olma-identity) copies of the token, which is what the real ones
// carry since 2026-08-27.
async function rotatable(agentId, phone, token) {
  const u = await makeUser(db.pool, phone);
  const w = workspace(agentId, token);
  fs.writeFileSync(path.join(w, 'AGENTS.md'), renderAgentsMd(token), { mode: 0o600 });
  await db.pool.query(
    'UPDATE users SET workspace_path = $2, identity_token = $3, agent_id = $4 WHERE id = $1',
    [u.id, w, token, agentId]);
  return { u, w };
}

test('rotating replaces the token in all three places, and proves it', async () => {
  const old = 'olma_tok_' + 'a'.repeat(32);
  const { u, w } = await rotatable('u-rot', '+972700000101', old);
  const { run } = recorder();

  const r = await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run, reason: 'leaked in chat' });
  assert.equal(r.ok, true, r.ok ? '' : r.error && r.error.message);
  assert.equal(r.data.rotated, true);
  assert.equal(r.data.verified, true);
  assert.equal(r.data.oldFingerprint, fingerprint(old));
  assert.notEqual(r.data.newFingerprint, r.data.oldFingerprint);

  const { rows } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  const now = rows[0].identity_token;
  assert.match(now, /^olma_tok_[0-9a-f]{32}$/);
  assert.notEqual(now, old);
  // All three copies agree, or the next turn authenticates against nothing.
  assert.equal(fs.readFileSync(path.join(w, '.olma-identity'), 'utf8').trim(), now);
  assert.ok(fs.readFileSync(path.join(w, 'AGENTS.md'), 'utf8').includes(now));
  assert.equal(fs.readFileSync(path.join(w, 'AGENTS.md'), 'utf8').includes(old), false);

  // The whole point: the leaked string must stop being a credential.
  assert.equal((await usersDomain.resolveByToken(db.pool, old)).ok, false);
  assert.equal((await usersDomain.resolveByToken(db.pool, now)).data.user.id, u.id);
});

test('the audit row carries fingerprints and never the token itself', async () => {
  const old = 'olma_tok_' + 'b'.repeat(32);
  const { u } = await rotatable('u-rot-audit', '+972700000102', old);
  const { run } = recorder();
  await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run, reason: 'leaked in chat' });

  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'admin.identity_token_rotated'`, [u.id]);
  assert.equal(rows.length, 1);
  const d = rows[0].detail;
  assert.equal(d.oldFingerprint, fingerprint(old));
  assert.equal(d.reason, 'leaked in chat');
  // A rotation prompted by a leak must not become the next place the
  // credential is written down — not the old one, not the new one.
  const { rows: after } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  const text = JSON.stringify(d);
  assert.equal(text.includes(old), false);
  assert.equal(text.includes(after[0].identity_token), false);
  assert.equal(/olma_tok_/.test(text), false);
});

test('a dry run reports the rotation and changes nothing at all', async () => {
  const old = 'olma_tok_' + 'c'.repeat(32);
  const { u, w } = await rotatable('u-rot-dry', '+972700000103', old);
  const { run, calls } = recorder();

  const r = await rotateIdentityToken(db.pool, { userId: u.id, run });
  assert.equal(r.ok, true);
  assert.equal(r.data.rotated, false);
  assert.equal(fs.readFileSync(path.join(w, '.olma-identity'), 'utf8').trim(), old);
  const { rows } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].identity_token, old);
  assert.deepEqual(calls, [], 'a dry run must not touch the immutable bit either');
});

test('a workspace missing either copy of the token is refused, not created', async () => {
  const old = 'olma_tok_' + 'd'.repeat(32);
  // .olma-identity present, AGENTS.md absent.
  const u = await makeUser(db.pool, '+972700000104');
  const w = workspace('u-rot-noagents', old);
  await db.pool.query('UPDATE users SET workspace_path = $2, identity_token = $3 WHERE id = $1',
    [u.id, w, old]);

  const r = await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run: recorder().run });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /AGENTS\.md/);
  // Writing a brand-new live credential into a directory that may not be this
  // person's workspace any more is worse than the exposure it would remediate.
  assert.equal(fs.existsSync(path.join(w, 'AGENTS.md')), false);
  const { rows } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].identity_token, old, 'the DB must not move when the files cannot');
});

test('a mint that returns the same or a malformed token rotates nothing', async () => {
  const old = 'olma_tok_' + 'e'.repeat(32);
  const { u, w } = await rotatable('u-rot-badmint', '+972700000105', old);

  for (const bad of [() => old, () => 'nope', () => '']) {
    const r = await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run: recorder().run, mint: bad });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /unusable/);
  }
  // The refusal happens before anything is written, so all three copies stand.
  assert.equal(fs.readFileSync(path.join(w, '.olma-identity'), 'utf8').trim(), old);
  const { rows } = await db.pool.query('SELECT identity_token FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].identity_token, old);
});

test('the file is unlocked before the write and locked after it', async () => {
  const old = 'olma_tok_' + '1'.repeat(32);
  const { u } = await rotatable('u-rot-lock', '+972700000106', old);
  const { run, calls } = recorder();
  const r = await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run });
  assert.equal(r.data.relocked, true);
  // The immutable bit stops root too: skipping the unlock fails with EPERM on
  // exactly the files that are correctly protected.
  assert.equal(calls.length, 3);
  assert.match(calls[0], /^chattr -i/);
  assert.match(calls[1], /^chattr \+i/);
  assert.match(calls[2], /^lsattr/);
});

test('a lock that cannot be set is reported, never assumed', async () => {
  const old = 'olma_tok_' + '2'.repeat(32);
  const { u } = await rotatable('u-rot-nolock', '+972700000107', old);
  const { run } = recorder({ lsattrLocked: false });
  const r = await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run });
  assert.equal(r.ok, true, 'a filesystem without chattr must not fail the rotation');
  assert.equal(r.data.relocked, false, 'and it must not claim a lock it did not get');
  assert.equal(r.data.verified, true);
});

test('after a rotation the leak finding drops itself — the guard closes its own issue', async () => {
  const tokenLeak = require('../src/domain/token-leak');
  const old = 'olma_tok_' + '3'.repeat(32);
  const { u } = await rotatable('u-rot-leak', '+972700000108', old);

  // The finding config_guard remembers: this user, this fingerprint.
  const stored = [{
    userId: u.id, fingerprint: fingerprint(old), agentId: 'u-rot-leak',
    ownAgent: true, at: 1, sessionId: 's1',
  }];
  const before = tokenLeak.reconcile(stored, [], (await tokenLeak.liveTokens(db.pool)).fpByUser);
  assert.equal(before.filter((e) => Number(e.userId) === u.id).length, 1,
    'while the token is live the exposure is real and must stay reported');

  await rotateIdentityToken(db.pool, { userId: u.id, apply: true, run: recorder().run });

  // This is what makes rotation the whole remediation rather than half of it:
  // reconcile keeps a finding only while its fingerprint is still somebody's
  // live token, so nobody has to remember to resolve the issue by hand.
  const after = tokenLeak.reconcile(stored, [], (await tokenLeak.liveTokens(db.pool)).fpByUser);
  assert.equal(after.filter((e) => Number(e.userId) === u.id).length, 0);
});
