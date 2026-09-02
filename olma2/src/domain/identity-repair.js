'use strict';
// Put every active user's .olma-identity back in agreement with the DB, and
// give every one of them the immutable bit that was supposed to make this
// impossible.
//
// Scope first, because #97 corrected the panic this was written during: since
// 2026-08-27 the token is rendered inline into AGENTS.md, so .olma-identity is
// the RECOVERY path, not the credential. A stale one blocks nobody while
// doctrine is intact — it is the spare key, and this repairs the spare key.
// It matters exactly when the primary fails, which is the moment nobody wants
// to discover the fallback was overwritten months ago.
//
// chattr +i landed on 2026-08-27, after an agent "repaired" its own identity
// file with a truncated token and permanently broke its own auth. It was only
// ever applied at PROVISIONING, so it reached new workspaces and nobody else.
// On 2026-09-01 the split was visible in a single `lsattr`: three files
// carried the bit and thirteen did not — and the eight a test suite running on
// the box overwrote that morning were, exactly, eight of the thirteen unlocked
// ones. Every locked file survived, without exception. The protection works;
// it had simply never been backfilled.
//
// Two separate jobs, and the second is the one that stops this recurring:
//   1. repair — rewrite a file whose token does not match users.identity_token
//   2. lock   — set +i on every active user's file, matching or not
//
// A file that already matches is still locked. That is the point: the eight
// that were overwritten matched the DB right up until the moment they did not,
// so locking only the broken ones protects precisely nobody.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Best-effort, exactly as provision.js treats it: a filesystem without chattr
// keeps the old behaviour rather than failing the repair. Reports whether the
// bit is actually set AFTERWARDS by reading it back, so a result can never
// claim a lock it did not get.
function setImmutable(p, on, run = execFileSync) {
  try { run('chattr', [on ? '+i' : '-i', p]); } catch { /* no chattr / no file */ }
  if (!on) return false;
  try {
    return /^-{4}i/.test(run('lsattr', [p], { encoding: 'utf8' }).toString().trim());
  } catch { return false; }
}

async function repairIdentityFiles(client, { apply = false, run, log } = {}) {
  const say = log || (() => {});
  const { rows } = await client.query(
    `SELECT id, phone, first_name, workspace_path, identity_token FROM users
      WHERE status = 'active' AND workspace_path IS NOT NULL ORDER BY id`);

  const repaired = [];
  let alreadyOk = 0, missing = 0, locked = 0, lockFailed = 0;

  for (const u of rows) {
    const p = path.join(u.workspace_path, '.olma-identity');
    let onDisk = null;
    try { onDisk = fs.readFileSync(p, 'utf8').trim(); } catch { /* missing */ }

    // A workspace with no file at all is not repaired blind: writing a token
    // into a directory that may not be this user's workspace any more is a
    // worse outcome than the auth failure it would paper over.
    if (onDisk === null) {
      say(`  ! ${u.id} ${u.first_name || u.phone}: identity file MISSING at ${p}`);
      missing++;
      continue;
    }

    const mismatched = onDisk !== u.identity_token;
    if (mismatched) say(`  ${apply ? '→' : '·'} ${u.id} ${u.first_name || u.phone}: mismatched — rewriting from DB`);

    if (!apply) {
      if (mismatched) repaired.push(u.id); else alreadyOk++;
      continue;
    }

    // Unlock → write → relock. The immutable bit stops root too, so a repair
    // that skipped the unlock would fail with EPERM on precisely the files
    // that are already correctly protected.
    setImmutable(p, false, run);
    if (mismatched) {
      fs.writeFileSync(p, u.identity_token + '\n', { mode: 0o600 });
      fs.chmodSync(p, 0o600); // writeFileSync's mode applies only at creation
      repaired.push(u.id);
    } else {
      alreadyOk++;
    }
    if (setImmutable(p, true, run)) locked++;
    else { lockFailed++; say(`  ! ${u.id}: could not set the immutable bit on ${p}`); }
  }

  if (apply && repaired.length) {
    // One row per user, so the trail names who was affected — the same shape
    // the 2026-08-27 and 2026-08-31 hand-repairs were audited with.
    for (const id of repaired) {
      await client.query(
        `INSERT INTO audit_log (actor_id, event, detail)
         VALUES ($1, 'admin.identity_repaired', $2::jsonb)`,
        [id, JSON.stringify({
          source: 'domain/identity-repair',
          reason: 'identity file did not match users.identity_token',
        })]);
    }
  }

  return { repaired, alreadyOk, missing, locked, lockFailed };
}

module.exports = { repairIdentityFiles, setImmutable };
