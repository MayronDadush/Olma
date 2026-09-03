'use strict';
// What release is actually serving, and when it landed.
//
// Nothing recorded this, and on 2026-09-03 that cost real time: a merge to
// main had its `test` job wedge, so `deploy` was SKIPPED — main and the box
// diverged with nothing anywhere saying so. Answering "is production running
// what I just merged?" meant grepping the deployed source for a string from
// the diff. Worse, the deploy that eventually shipped that code was a
// DIFFERENT session's merge minutes later; the natural reading — "my re-run
// fixed it" — was wrong, and only file contents could tell the difference.
//
// The stamp is written by scripts/deploy.sh AFTER the post-restart health
// check passes, never before. That ordering is the entire guarantee: a deploy
// that failed its health check is rolled back to /opt/olma2-previous, whose
// snapshot carries the PREVIOUS stamp, so the file always names the release
// that is genuinely serving rather than the one that was last attempted.
const fs = require('node:fs');
const path = require('node:path');

const STAMP_FILE = '.deployed';

// A box deployed before this shipped has no stamp, and neither does a dev
// checkout. That is 'unknown', never a problem: reading a missing file as a
// fault would put a red row on the dashboard for a perfectly healthy system,
// which is the failure this repo has recorded more than any other.
function readDeployStamp(root) {
  const base = root || process.env.OLMA_DEPLOY_ROOT || path.join(__dirname, '..', '..');
  let raw;
  try { raw = fs.readFileSync(path.join(base, STAMP_FILE), 'utf8'); }
  catch { return { known: false }; }

  const sha = (raw.match(/^sha=([0-9a-f]{7,40})$/m) || [])[1] || null;
  const at = (raw.match(/^at=(.+)$/m) || [])[1] || null;
  const when = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  // A file that exists but cannot be parsed is also 'unknown' rather than a
  // guess — half a stamp is not a release identifier.
  if (!sha) return { known: false };
  return { known: true, sha, at: when };
}

module.exports = { readDeployStamp, STAMP_FILE };
