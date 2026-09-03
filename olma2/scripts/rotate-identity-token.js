#!/usr/bin/env node
// Replace one user's identity token, for when the old one leaked.
//
// The case this exists for: on 2026-09-02 u-3's agent garbled a tool call and
// emitted its own `olma_identity` as ordinary reply text during a delivery
// turn, so a live credential — the whole auth mechanism for every tool — went
// to a real WhatsApp chat. config_guard files that as a violation
// (domain/token-leak.js) and it stays open for as long as the token works,
// because it stays exposed for as long as the token works.
//
// Ordering, the live-session cost, and why nothing here logs the token are all
// in src/domain/identity-repair.js. Dry-run by default.
//
// Usage: node scripts/rotate-identity-token.js (--user N | --phone <digits>) [--apply] [--reason "..."]
'use strict';
const { createPool } = require('../src/db/pool');
const { rotateIdentityToken } = require('../src/domain/identity-repair');
const { findUserByPhoneFragment } = require('../src/domain/repair');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const val = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

(async () => {
  const pool = createPool();
  try {
    let userId = val('--user');
    const phone = val('--phone');
    if (!userId && !phone) {
      console.error('give --user N or --phone <digits>');
      process.exit(2);
    }
    // Trailing-digit matching that refuses an ambiguous fragment, same as
    // every other repair script — aiming a credential rotation at the wrong
    // person breaks a stranger's agent for no reason.
    if (!userId) {
      const found = await findUserByPhoneFragment(pool, phone);
      if (!found.ok) {
        console.error(found.error.message);
        if (found.error.candidates) console.error(found.error.candidates.join('\n'));
        process.exit(1);
      }
      userId = found.data.user.id;
    }

    const r = await rotateIdentityToken(pool, {
      userId: Number(userId), apply: APPLY, reason: val('--reason') || undefined,
      log: (m) => console.log(m),
    });
    if (!r.ok) {
      console.error(r.error.message);
      process.exit(1);
    }
    if (!APPLY) {
      console.log('\ndry run — pass --apply to rotate');
    } else {
      console.log(`\nrotated: ${r.data.oldFingerprint} → ${r.data.newFingerprint}`
        + `${r.data.relocked ? '' : ' (WARNING: .olma-identity is not immutable)'}`);
      console.log('verified: the new token resolves to this user and the old one no longer resolves');
      console.log('config_guard closes its own issue on the next tick — the leaked token is no'
        + ' longer live, so token-leak.reconcile drops the finding.');
      console.log('Their open session still holds the old token in context: each turn will fail'
        + ' one call and recover from .olma-identity until the session rotates.');
    }
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
