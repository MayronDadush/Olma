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
const { ok, err } = require('./results');

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

// ---- rotating a token that leaked ------------------------------------------
// A token that reached a real person's chat (domain/token-leak.js) stays
// exposed for exactly as long as it keeps working, so the only remediation is
// a different one. Almost all of that machinery already existed and is
// reviewed: scripts/resync-agent-templates.js renders AGENTS.md per user from
// users.identity_token, and repairIdentityFiles above rewrites .olma-identity
// from the same column. The only missing piece was minting the new value and
// swapping it in without locking somebody out of their own agent mid-sentence.
//
// ORDER IS THE WHOLE DESIGN. The token lives in three places: the DB (the
// verifier — domain/users.resolveByToken), AGENTS.md (the primary, read into
// context at session start) and .olma-identity (the recovery path that both
// the doctrine and bin/olma-mcp.js point at). Writing the FILE first is what
// makes this safe:
//
//   1. .olma-identity ← new   DB and AGENTS.md are both still old, so the
//                             token already in the model's context keeps
//                             working. Nothing fails during this window.
//   2. DB             ← new   the in-context token dies this instant. The
//                             agent's next call fails once with "unknown
//                             identity token", whose own text tells it to
//                             re-read .olma-identity — which step 1 fixed.
//   3. AGENTS.md      ← new   so the NEXT session starts correct instead of
//                             paying for that fallback on every turn.
//
// Every other order leaves a window where the file and the DB are wrong at the
// same time, and that window is a total auth failure rather than one retried
// call. The live session cannot be spared completely — AGENTS.md is read at
// session start, so its context holds the dead token until the session rotates
// — but one extra tool call per turn is precisely what the 2026-08-27 recovery
// path was built to absorb.
//
// The new token is never logged, never audited and never returned. A rotation
// caused by a leak must not become the next place the credential is written
// down; the audit row carries fingerprints, which is what token-leak.js
// compares on anyway.
async function rotateIdentityToken(client, { userId, apply = false, run, log, mint, reason } = {}) {
  const say = log || (() => {});
  const users = require('./users');
  const { fingerprint } = require('./token-leak');
  const { renderAgentsMd } = require('../intake/provision');

  const { rows } = await client.query(
    `SELECT id, phone, first_name, status, workspace_path, identity_token
       FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) return err('not_found', `no user ${userId}`);
  if (u.status !== 'active') return err('invalid', `user ${userId} is ${u.status}, not active`);
  if (!u.workspace_path) return err('invalid', `user ${userId} has no workspace`);
  if (!u.identity_token) return err('invalid', `user ${userId} has no token to rotate`);

  const identityPath = path.join(u.workspace_path, '.olma-identity');
  const agentsPath = path.join(u.workspace_path, 'AGENTS.md');

  // Both files must already be there. A rotation that CREATES either one is
  // writing a live credential into a directory that may no longer be this
  // person's workspace — the same refusal repairIdentityFiles makes above,
  // and the stakes here are higher because the value is brand new.
  for (const [label, p] of [['.olma-identity', identityPath], ['AGENTS.md', agentsPath]]) {
    if (!fs.existsSync(p)) return err('invalid', `user ${userId} has no ${label} at ${p} — repair that first`);
  }

  const oldFp = fingerprint(u.identity_token);
  say(`  user ${u.id} ${u.first_name || u.phone}: token ${oldFp} → a new one`);
  say(`    .olma-identity  ${identityPath}`);
  say(`    AGENTS.md       ${agentsPath}`);
  if (!apply) return ok({ userId: u.id, oldFingerprint: oldFp, rotated: false });

  const newToken = (mint || users.newIdentityToken)();
  const newFp = fingerprint(newToken);
  // Refusing this is cheap and the alternative is silent: a mint that returned
  // the same value, or a malformed one, would "rotate" nothing while every
  // report said it had.
  if (!newFp || newFp === oldFp || !/^olma_tok_[0-9a-f]{32}$/.test(newToken)) {
    return err('internal', 'minted token is unusable — nothing was changed');
  }

  // 1. the recovery path, while the old token is still the live one
  setImmutable(identityPath, false, run);
  fs.writeFileSync(identityPath, newToken + '\n', { mode: 0o600 });
  fs.chmodSync(identityPath, 0o600); // writeFileSync's mode applies at creation only
  const relocked = setImmutable(identityPath, true, run);
  if (!relocked) say(`    ! could not set the immutable bit on ${identityPath}`);

  // 2. the verifier
  await client.query(`UPDATE users SET identity_token = $1 WHERE id = $2`, [newToken, u.id]);

  // 3. the primary path
  fs.writeFileSync(agentsPath, renderAgentsMd(newToken), { mode: 0o600 });
  fs.chmodSync(agentsPath, 0o600);

  await client.query(
    `INSERT INTO audit_log (actor_id, event, detail) VALUES ($1, 'admin.identity_token_rotated', $2::jsonb)`,
    [u.id, JSON.stringify({
      source: 'domain/identity-repair',
      reason: reason || 'token rotation',
      oldFingerprint: oldFp, newFingerprint: newFp, relocked,
    })]);

  // Writing three files is not the same claim as replacing a credential, and
  // only one of those is what the issue is about. Ask the verifier.
  const nowLive = await users.resolveByToken(client, newToken);
  const oldDead = await users.resolveByToken(client, u.identity_token);
  const verified = nowLive.ok && Number(nowLive.data.user.id) === Number(u.id) && !oldDead.ok;
  if (!verified) return err('internal', 'the new token does not resolve, or the old one still does');

  return ok({
    userId: u.id, oldFingerprint: oldFp, newFingerprint: newFp,
    rotated: true, relocked, verified,
  });
}

module.exports = { repairIdentityFiles, setImmutable, rotateIdentityToken };
