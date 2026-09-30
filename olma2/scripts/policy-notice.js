#!/usr/bin/env node
// Tell everybody Olma serves that the privacy policy and terms changed
// (domain/policy-notice.js holds the why).
//
// Usage (on the box, from /opt/olma2):
//   node scripts/policy-notice.js                    # preview: who would get it, counts only
//   node scripts/policy-notice.js --enqueue --yes    # queue it; the gate sends it in their hours
//   node scripts/policy-notice.js --enqueue --yes --only <userId>   # one person first, as a sample
//   node scripts/policy-notice.js --stats            # how many it reached
//   add --version <id> for another published version (2026-09-28 is the default and the only one)
//
// Idempotent per person per version. Nothing here prints a name or a number.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const notice = require('../src/domain/policy-notice');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const version = arg('version') || '2026-09-28';

(async () => {
  if (!notice.VERSIONS[version]) { console.error(`unknown version: ${version}`); process.exit(2); }
  const pool = createPool();
  try {
    if (process.argv.includes('--stats')) {
      const s = await withTx(pool, (c) => notice.stats(c, version));
      console.log(`policy notice ${version}: ${s.rows} queued, ${s.delivered} reached them, ${s.waiting} waiting, ${s.dropped} will never go`);
      return;
    }
    const a = await withTx(pool, (c) => notice.audience(c, version));
    console.log(`policy notice ${version}: ${a.eligible} would get it (he ${a.he}, en ${a.en}); ${a.paused} paused are left out; `
      + `${a.shown} already read the link in their opening and are left out.`);
    if (!process.argv.includes('--enqueue')) { console.log('preview only — add --enqueue --yes to queue it'); return; }
    if (!process.argv.includes('--yes')) { console.error('refusing without --yes'); process.exit(2); }
    const only = arg('only');
    if (only != null && !/^\d+$/.test(only)) { console.error('--only takes a user id'); process.exit(2); }
    const r = await withTx(pool, (c) => notice.enqueueAll(c, version, { only }));
    console.log(`queued ${r.queued} of ${r.candidates} (the rest were already queued)`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
