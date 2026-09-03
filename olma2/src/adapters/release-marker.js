'use strict';
// What release is actually serving, read from the RELEASE marker that
// scripts/deploy.sh writes into the live tree.
//
// The marker exists (#126) and rollback.sh reads it, but nothing ever showed
// it to a person. On 2026-09-03 that gap cost real time: a merge to main had
// its `test` job wedge, so `deploy` was SKIPPED — main and the box diverged
// with nothing anywhere saying so, and answering "is production running what
// I just merged?" meant grepping the deployed source for a string out of the
// diff. Worse, the deploy that eventually carried that code was a DIFFERENT
// session's merge minutes later; the natural reading — "my re-run fixed it" —
// was wrong, and only file contents could tell the two apart.
//
// This is a READER only. Everything about how the marker is written, and why
// it is deliberately not rsync-excluded, lives in deploy.sh next to the write.
const fs = require('node:fs');
const path = require('node:path');

const MARKER_FILE = 'RELEASE';

// deploy.sh stamps the time with `-` where a clock would put `:`, because a
// colon is legal in a Linux path but a menace in the tools that handle one —
// the same string names the archive directory. Undo exactly that, and only
// in the time-of-day half, so the date's own hyphens survive.
function parseStampedAt(raw) {
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(raw.trim());
  const iso = m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : raw.trim();
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

// A box deployed before the marker existed has no file, and neither does a dev
// checkout — that is 'unknown', never a fault. Rendering a missing marker red
// would put a problem on the dashboard for a perfectly healthy system, which
// is the failure this repo has recorded more than any other.
function readReleaseMarker(root) {
  const base = root || process.env.OLMA_DEPLOY_ROOT || path.join(__dirname, '..', '..');
  let raw;
  try { raw = fs.readFileSync(path.join(base, MARKER_FILE), 'utf8'); }
  catch { return { known: false }; }

  const field = (name) => {
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(raw);
    return m ? m[1].trim() : null;
  };
  const sha = field('sha');
  // The sha is the answer to "what is running"; everything else is context, so
  // a marker without one is unknown rather than a guess. Half a marker is not
  // a release identifier.
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return { known: false };
  return {
    known: true,
    sha,
    short: sha.slice(0, 12),
    subject: field('subject') || null,
    origin: field('origin') || null,
    at: parseStampedAt(field('deployed_at')),
  };
}

module.exports = { readReleaseMarker, parseStampedAt, MARKER_FILE };
