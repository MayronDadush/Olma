'use strict';
// Is the box running what `main` says it should be?
//
// "Merged" does not mean "deployed" here, and the gap is completely silent.
// Twice on 2026-09-03/04 a merge's own CI run was cancelled or wedged, its
// `deploy` job was skipped, and the code sat in main for hours with nothing
// anywhere saying so. The worst instance was #140 — the fix for deploys that
// die mid-run — which itself never deployed for exactly that reason, so the
// cure sat in main while the disease kept happening.
//
// Two causes, both outside our control and both quiet:
//   * a wedged or failed `test` job SKIPS `deploy`
//   * GitHub's concurrency group keeps ONE pending run per ref, so when
//     merges arrive faster than deploys finish, the middle ones are cancelled
//
// So this does not try to prevent either. It just makes the gap visible, and
// keeps it visible — "show the gap always, not only when it breaks"
// (CLAUDE.md, on the cost figures that drifted for a month while every page
// looked healthy).
//
// ---- deliberately NOT an alert ----
//
// `BREAKS_USERS` means "their tool calls fail right now" and nothing else.
// Production being three commits behind main breaks nobody: it is the
// previous release, and the previous release worked. This is a dashboard row.
// Widening the alarm set is how an alert list stops being read.
//
// ---- and deliberately not a judgement when it cannot judge ----
//
// A GitHub that cannot be reached is not a drifted deploy — it is an unknown,
// reported as one, carrying forward WHEN the last real answer was so nobody
// reads a stale verdict as a fresh one. `null` (could not check) and
// "in sync" must never collapse into the same row.
//
// The check going quiet is covered for free: this is a job_heartbeats row, so
// jobs/expectations.js already calls it stale if it stops running, and
// /health already reports that. No second detector needed for the detector.
const { readReleaseMarker } = require('../adapters/release-marker');

// job_heartbeats.note is a 200-char column and this note is READ BACK next
// tick (that is where `since` comes from). A note that overflows is
// truncated into invalid JSON, the parse fails, and the drift silently
// re-dates itself to now every hour — a gap that never appears to age.
// Measured: the longest state ('unchecked', every field populated) is 185
// chars with `why` at 40 and 225 at 80. So `why` is capped here rather than
// at the column, and a test holds the whole envelope under the cap.
const NOTE_MAX = 200;
const WHY_MAX = 40;

const REPO = process.env.OLMA_REPO || 'MayronDadush/Olma';
const BRANCH = process.env.OLMA_DEPLOY_BRANCH || 'main';
// The box is a 1-vCPU droplet and this is pure curiosity, so it gets a short
// leash. GitHub unreachable is a fine answer; a hung fetch is not.
const FETCH_TIMEOUT_MS = 8000;

// One call answers both questions — identical or not, and by how many. The
// compare endpoint's `ahead_by` counts what HEAD (main) has that BASE (what
// we deployed) does not, which is exactly "how far behind production is".
async function compareToBranch(deployedSha, { fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `https://api.github.com/repos/${REPO}/compare/${deployedSha}...${BRANCH}`;
  const res = await doFetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'olma2-deploy-drift' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A 404 here is its own answer and worth saying out loud: the deployed
    // sha is not a commit GitHub knows, which means the box is running
    // something that never reached main (a hand-deploy, a force-push that
    // orphaned it). That is a stranger state than being behind.
    const e = new Error(res.status === 404 ? 'the deployed commit is not on GitHub' : `GitHub returned ${res.status}`);
    e.notFound = res.status === 404;
    throw e;
  }
  const body = await res.json();
  return { status: body.status, aheadBy: Number(body.ahead_by) || 0, head: body.commits && body.commits.length ? body.commits[body.commits.length - 1].sha : null };
}

async function previousNote(client) {
  const { rows } = await client.query(
    `SELECT note FROM job_heartbeats WHERE job_name = 'deploy_drift'`);
  if (!rows[0] || !rows[0].note) return null;
  try { return JSON.parse(rows[0].note); } catch { return null; }
}

async function sweepDeployDrift(client, deps = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const marker = deps.marker || readReleaseMarker();
  const prev = await previousNote(client);

  // No marker at all: a deploy older than the marker itself, or a tree that
  // was never deployed by the script. Nothing is wrong; we simply cannot say.
  if (!marker.known) return { state: 'unknown', why: 'no RELEASE marker', at: now.toISOString() };

  let cmp;
  try {
    cmp = await compareToBranch(marker.sha, deps);
  } catch (e) {
    // Could not read is never in trouble. Carry the last real verdict and the
    // time it was taken, so the row says how old the answer is instead of
    // quietly presenting it as current.
    return {
      state: 'unchecked',
      why: String(e.message).slice(0, WHY_MAX),
      local: marker.short,
      // The last REAL verdict, and when it was taken — which is not the
      // previous row when the previous row was itself an 'unchecked'. Reading
      // `prev.at` unconditionally makes the second hour of an outage erase
      // what the first hour still knew, and a three-day outage end with a row
      // that has never known anything.
      lastKnown: prev ? (prev.state === 'unchecked' ? prev.lastKnown || null : prev.state || null) : null,
      lastCheckedAt: prev ? (prev.state === 'unchecked' ? prev.lastCheckedAt || null : prev.at || null) : null,
      at: now.toISOString(),
    };
  }

  if (cmp.status === 'identical') {
    return { state: 'in_sync', local: marker.short, at: now.toISOString() };
  }

  // `since` is the point this particular drift started, not the point we
  // noticed it again — so an hour-old gap reads as an hour, not as one tick.
  const sameDrift = prev && prev.state === 'behind' && prev.local === marker.short;
  return {
    state: 'behind',
    local: marker.short,
    by: cmp.aheadBy,
    since: sameDrift && prev.since ? prev.since : now.toISOString(),
    at: now.toISOString(),
  };
}

module.exports = { sweepDeployDrift, compareToBranch, REPO, BRANCH, FETCH_TIMEOUT_MS, NOTE_MAX, WHY_MAX };
