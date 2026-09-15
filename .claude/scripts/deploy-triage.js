#!/usr/bin/env node
'use strict';
// "I merged. Did it ship?" — the five checks, in the order the rules require,
// ending in ONE named verdict.
//
// Merging is deploying here, and a deploy fails in shapes that look alike from
// the outside and take OPPOSITE actions. `.claude/rules/deploying.md` holds all
// of them, and every session works them out again from first principles, in a
// different order, usually stopping at the first green thing it finds. The
// expensive mistakes are all "read a reassuring answer to a question nobody
// asked":
//
//   - a conclusion string tells you NOTHING: a dead run arrives as `cancelled`
//     (job timeout), as `failure` (run-suite.sh out of retries), and a queued
//     run on main is cancelled outright when a later merge displaces it, which
//     is benign.
//   - a merge can produce NO run at all, and that is the only failure with
//     nothing to re-run.
//   - a red `deploy` is EITHER a wedge or a real failure. Re-run one, never
//     the other. run-suite.sh's banner is the only thing that separates them.
//   - timestamps lie in BOTH directions. The marker is written ~14 minutes
//     before the restart on a HEALTHY deploy, which is the identical signature
//     to a deploy that died before restarting.
//   - the sha in /opt/olma2/RELEASE is the only unambiguous answer, and even
//     it does not say the running process picked the code up.
//
// So this asks in a fixed order and never stops early:
//
//   1. is the commit on main at all?
//   2. does it touch anything CI watches — i.e. can it deploy at all?
//   3. did a workflow run get created for it?
//   4. what did that run actually do — and if red, was it a wedge?
//   5. what sha does the box say it is serving?
//   6. did the services restart after that, and is /ready 200?
//
//   node .claude/scripts/deploy-triage.js              # HEAD
//   node .claude/scripts/deploy-triage.js <sha|PR#>
//   node .claude/scripts/deploy-triage.js --no-box     # skip SSH
//   node .claude/scripts/deploy-triage.js --json
//
// Read-only. It runs git, gh and one ssh, and changes nothing anywhere. It
// prints the recovery command for the shape it found and does NOT run it:
// three of the shapes take opposite actions and one of them redeploys
// production.
//
// A thing it could not READ is never a thing in trouble — an unreachable box,
// a gh that is not logged in and a missing remote are all reported as UNKNOWN
// and never as a failure.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = 'root@157.230.210.233';
const REPO = 'MayronDadush/Olma';

// Every verdict this can end on. One list, because the skill's table has to
// document all of them and a table that quietly omits one is worse than no
// table — `--self-test` asserts the two agree.
const VERDICTS = [
  'SHIPPED AND RUNNING',
  'SHIPPED, BUT /ready IS NOT 200',
  'STILL RUNNING',
  'NOT A DEPLOYING CHANGE',
  'NOT ON MAIN',
  'NOT MERGED',
  'THE MERGE THAT NEVER RAN',
  'A WEDGE, NOT A FAILURE',
  'A REAL FAILURE',
  'DISPLACED, AND CARRIED ANYWAY',
  'CANCELLED, AND NOT SHIPPED',
  'A MIXED BOX',
  'MERGED BUT NOT ON THE BOX',
  'GREEN IN CI, BOX NOT CHECKED',
  'GREEN IN CI, BOX UNREADABLE',
  'UNDETERMINED, BOX NOT CHECKED',
  'UNKNOWN',
];

// A doc that can drift from the code is a doc nobody can trust. This asserts
// the skill's table names every verdict, and that adding one without
// documenting it fails loudly rather than shipping an undocumented outcome.
if (process.argv.includes('--self-test')) {
  const fs = require('node:fs');
  const skill = path.join(ROOT, '.claude', 'skills', 'deploy-triage', 'SKILL.md');
  let text = '';
  try { text = fs.readFileSync(skill, 'utf8'); } catch {
    console.error(`  self-test FAILED: cannot read ${path.relative(ROOT, skill)}`);
    process.exit(1);
  }
  // Backtick-delimited and exact. A plain substring test passes on a PREFIX,
  // so renaming `A MIXED BOX` to `A MIXED BOXX` in the table went undetected
  // the first time this guard was tried.
  const documented = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()));
  const missing = VERDICTS.filter((v) => !documented.has(v));
  if (missing.length) {
    console.error(`  self-test FAILED: SKILL.md documents no row for: ${missing.join(' | ')}`);
    process.exit(1);
  }
  // And that the script RUNS. The doc check above passes before argv is even
  // read, so it once went green while a bad edit had deleted argv and every
  // real invocation crashed on load. A check that goes quiet is
  // indistinguishable from one that passes: this executes the thing.
  const { execFileSync } = require('node:child_process');
  let smoke = null;
  try {
    smoke = JSON.parse(execFileSync(process.execPath,
      [__filename, 'no-such-revision-at-all', '--json', '--no-box'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    // the UNKNOWN path exits non-zero by design, so a verdict on stdout is a pass
    try { smoke = JSON.parse(e.stdout || ''); } catch { smoke = null; }
    if (!smoke) {
      console.error(`  self-test FAILED: the script does not run — ${(e.stderr || e.message || '').split('\n').slice(0, 3).join(' / ')}`);
      process.exit(1);
    }
  }
  if (!smoke || smoke.verdict !== 'UNKNOWN') {
    console.error(`  self-test FAILED: a bogus revision should end on UNKNOWN, got ${smoke && smoke.verdict}`);
    process.exit(1);
  }

  console.log(`self-test: all ${VERDICTS.length} verdicts are documented in the skill, and the script runs`);
  process.exit(0);
}

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const NO_BOX = argv.includes('--no-box');
const target = argv.find((a) => !a.startsWith('--')) || 'HEAD';

// ── running things, where "could not" is a value and never a throw ─────────
function tryRun(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
      }).trim(),
    };
  } catch (e) {
    return { ok: false, out: (e.stdout || '').trim(), err: (e.stderr || e.message || '').trim() };
  }
}
const git = (...args) => tryRun('git', args);
const gh = (...args) => tryRun('gh', args);

// ── the report ─────────────────────────────────────────────────────────────
const steps = [];
function step(n, question, value, note) {
  steps.push({ n, question, value, note });
}

// ── 1. is the commit on main? ──────────────────────────────────────────────
git('fetch', 'origin', '--quiet');

let sha = null;
// Declared before any `finish()` can run: the PR-number and bad-revision paths
// both report before a subject can be read, and a temporal-dead-zone crash
// there would make a clean "not merged" answer look like a broken tool.
let subject = '(unknown)';
const prMatch = /^#?(\d+)$/.exec(target);
if (prMatch) {
  // Parsed in JS, not with --jq: a jq expression has to survive two levels of
  // escaping here, and when it does not, gh fails with a message about jq that
  // reads exactly like "gh is not logged in". Name the cause, not a guess.
  const pr = gh('pr', 'view', prMatch[1], '--repo', REPO, '--json', 'mergeCommit,state');
  if (!pr.ok) {
    finish('UNKNOWN', `could not read PR #${prMatch[1]}: ${(pr.err || '').split('\n')[0]}`);
  }
  let info = null;
  try { info = JSON.parse(pr.out); } catch { /* handled below */ }
  if (!info) finish('UNKNOWN', `PR #${prMatch[1]} did not come back as JSON.`);
  sha = (info.mergeCommit && info.mergeCommit.oid) || null;
  step(0, `PR #${prMatch[1]}`, `${info.state}, merge commit ${sha ? sha.slice(0, 8) : 'none'}`);
  if (!sha) {
    finish('NOT MERGED', `PR #${prMatch[1]} is ${info.state} and has no merge commit. Nothing to triage yet.`);
  }
} else {
  const r = git('rev-parse', target);
  if (!r.ok) finish('UNKNOWN', `${target} is not a revision this repo knows.`);
  sha = r.out;
}

subject = git('log', '-1', '--format=%s', sha).out || '(unknown)';
const mainSha = git('rev-parse', 'origin/main').out;
const onMain = git('merge-base', '--is-ancestor', sha, 'origin/main').ok;
const behind = onMain ? git('rev-list', '--count', `${sha}..origin/main`).out : null;

step(1, 'is the commit on main?',
  onMain ? `yes — origin/main is ${mainSha.slice(0, 8)}, ${behind} commit(s) ahead`
    : `NO — origin/main is ${mainSha.slice(0, 8)} and does not contain it`,
  onMain ? null : 'a concurrent session can merge at a head that predates your commit');

if (!onMain) {
  finish('NOT ON MAIN', [
    `${sha.slice(0, 8)} is not an ancestor of origin/main, so nothing has shipped it.`,
    'Another session very likely merged at a head that predates your commit.',
    'Re-open or re-merge the PR; there is no CI failure to chase here.',
  ].join('\n'));
}

// ── 1b. does this change deploy AT ALL? ────────────────────────────────────
// `olma2-tests.yml` watches ['olma2/**', '.github/workflows/olma2-tests.yml'],
// and that filter is the whole blast radius. A change outside it merges with
// NO checks, never reaches the box, and would otherwise read here as "merged
// but not deployed" for ever — a permanent false alarm on every CLAUDE.md and
// .claude/** merge. Which side of `olma2/` a file sits on decides this, and
// nothing in the filename says so.
const DEPLOYS = (f) => f.startsWith('olma2/') || f === '.github/workflows/olma2-tests.yml';
const parents = git('rev-list', '--parents', '-n', '1', sha).out.split(' ').slice(1);
const touched = (parents.length
  ? git('diff', '--name-only', `${sha}^1`, sha)
  : git('show', '--name-only', '--format=', sha)).out.split('\n').filter(Boolean);
const deploying = touched.filter(DEPLOYS);

step(2, 'does this change deploy at all?',
  `${touched.length} file(s) changed, ${deploying.length} of them under CI's filter`,
  deploying.length ? null : "outside ['olma2/**', the workflow file] — no suite, no deploy, by design");

if (!deploying.length) {
  finish('NOT A DEPLOYING CHANGE', [
    `${sha.slice(0, 8)} touches nothing CI watches, so it never ran the suite and never`,
    'reached the box. That is correct and not a fault — but note what it means: no',
    'checks at all looks exactly like green. Whatever light job covers those paths',
    '(claude-rules.yml, voice-bridge.yml) is the only thing that saw this change.',
    '',
    touched.length <= 8 ? `  ${touched.join('\n  ')}` : `  ${touched.slice(0, 8).join('\n  ')}\n  …and ${touched.length - 8} more`,
  ].join('\n'));
}

// ── 3. did a run get created? ──────────────────────────────────────────────
// The full 40-char sha: `gh run list --commit` given a short one returns [],
// which is indistinguishable from "no run was ever created".
const suites = gh('api', `repos/${REPO}/commits/${sha}/check-suites`, '--jq', '.total_count');
const suiteCount = suites.ok ? Number(suites.out) : null;

const runsRaw = gh('run', 'list', '--repo', REPO, '--commit', sha, '--limit', '20',
  '--json', 'name,event,status,conclusion,databaseId');
let runs = [];
if (runsRaw.ok) { try { runs = JSON.parse(runsRaw.out); } catch { runs = []; } }
// Only the push run deploys; a pull_request run never does.
const pushRuns = runs.filter((r) => r.event === 'push');

step(3, 'did a workflow run get created?',
  suiteCount === null ? 'UNKNOWN — could not reach the checks API'
    : `check-suites: ${suiteCount}, workflow runs: ${runs.length} (${pushRuns.length} from the push)`,
  suiteCount === 0 ? 'zero is the tell for the merge that never ran' : null);

if (suiteCount === 0 && runs.length === 0) {
  finish('THE MERGE THAT NEVER RAN', [
    `No check suite and no workflow run exists for ${sha.slice(0, 8)}.`,
    'main holds code the box has never seen, and everything looks finished.',
    'This is the one failure with nothing to re-run. Recover with:',
    '',
    `  gh workflow run olma2-tests.yml --ref main --repo ${REPO}`,
    '',
    'The workflow_dispatch trigger exists for exactly this and deploys as a push does.',
    'Do NOT deploy from a Mac: Apple rsync has no --chown, so deploy.sh aborts after',
    'archiving the outgoing release and before touching anything.',
  ].join('\n'));
}

// ── 3. what did the run do, and if red, was it a wedge? ────────────────────
const deployRun = pushRuns.find((r) => r.name === 'olma2 tests') || pushRuns[0] || runs[0];
let jobs = [];
let jobsReadable = false;
let wedged = null;

if (deployRun) {
  const jr = gh('run', 'view', String(deployRun.databaseId), '--repo', REPO,
    '--json', 'jobs', '--jq', '[.jobs[] | {name, conclusion, status}]');
  if (jr.ok) { jobsReadable = true; try { jobs = JSON.parse(jr.out); } catch { jobs = []; } }
}

const jobLine = jobs.length
  ? jobs.map((j) => `${j.name}=${j.conclusion || j.status}`).join(' ')
  : (deployRun ? `${deployRun.status}/${deployRun.conclusion}` : 'no run to read');

const red = jobs.filter((j) => j.conclusion && !['success', 'skipped'].includes(j.conclusion));
const inFlight = deployRun && deployRun.status !== 'completed';

if (red.length && deployRun) {
  // The banner is the ONLY thing that separates a wedge from a real failure,
  // and they take opposite actions.
  const log = gh('run', 'view', String(deployRun.databaseId), '--repo', REPO, '--log-failed');
  const text = (log.out || '') + (log.err || '');
  wedged = /THE WEDGE: no exit after|suite wedged on all/.test(text);
}

step(4, 'what did the run do?', jobLine,
  wedged === null ? null : (wedged ? 'run-suite.sh printed its wedge banner' : 'no wedge banner — this is a real failure'));

if (inFlight) {
  finish('STILL RUNNING', [
    `Run ${deployRun.databaseId} is ${deployRun.status}. Nothing has shipped yet and nothing is wrong.`,
    `Watch it: gh run watch ${deployRun.databaseId} --repo ${REPO}`,
  ].join('\n'));
}

// A run whose conclusion is not success but which has NO jobs to read is the
// displaced-queue case: on main a QUEUED run is cancelled outright when a
// later merge takes the concurrency slot, before any job starts. That is
// benign — the displacing sha is a descendant and deploy.sh rsyncs the whole
// tree — but it is benign only if the box confirms it, so this does NOT decide
// here. `[]` (no job ever ran) and "every job passed" are different answers and
// collapsing them is how a cancelled run reads as green.
const inconclusive = !red.length
  && deployRun
  && deployRun.conclusion
  && deployRun.conclusion !== 'success'
  && jobs.filter((j) => j.conclusion && j.conclusion !== 'skipped').length === 0;

if (inconclusive) {
  steps[steps.length - 1].note =
    `run conclusion is ${deployRun.conclusion} and no job ever ran — probably displaced `
    + 'by a later merge; only the box settles it';
}

if (red.length) {
  const names = red.map((j) => j.name).join(', ');
  const deploySkipped = jobs.some((j) => j.name === 'deploy' && j.conclusion === 'skipped');
  if (wedged) {
    finish('A WEDGE, NOT A FAILURE', [
      `${names} died on run-suite.sh's wedge, not on a test that means anything.`,
      deploySkipped
        ? 'deploy is `needs: test`, so it was SKIPPED and main shipped nothing. On main there'
          + '\nis no pull_request run to fall back on.'
        : '',
      '',
      'Re-run it:',
      `  gh run rerun ${deployRun.databaseId} --repo ${REPO}`,
      '',
      'If it wedges a second time, that is a NEW hang — diagnose it rather than banking',
      'the retry. The fallback is to deploy the merged sha on the box itself, where the',
      'same suite runs at --test-concurrency=2 and does not wedge:',
      `  ssh ${SERVER} 'cd /opt/olma2 && bash scripts/deploy.sh --restart'`,
    ].filter(Boolean).join('\n'));
  }
  finish('A REAL FAILURE', [
    `${names} failed and run-suite.sh printed no wedge banner, so a re-run will fail again.`,
    'Read it and fix the cause:',
    `  gh run view ${deployRun.databaseId} --repo ${REPO} --log-failed`,
    '',
    'If `deploy` is the red one, the box is very likely MIXED: deploy.sh rsyncs and',
    'applies migrations BEFORE the suite, and aborts before the restart — so new code',
    'and applied migrations sit on disk while the old code serves from memory. Check',
    'step 5 below before assuming nothing happened.',
  ].join('\n'));
}

// ── 4 & 5. what does the box say, and did it restart? ──────────────────────
if (NO_BOX) {
  step(5, 'what is the box serving?', 'skipped (--no-box)');
  finish(inconclusive ? 'UNDETERMINED, BOX NOT CHECKED' : 'GREEN IN CI, BOX NOT CHECKED', [
    inconclusive
      ? `The run ended as ${deployRun.conclusion} with no job having run, which the box alone`
        + '\ncan resolve — it is either a displaced queue entry that a later deploy carried'
        + '\nanyway, or a deploy that simply never happened.'
      : 'Every job passed.',
    'The sha in /opt/olma2/RELEASE is the only unambiguous answer to "is production',
    'running what I merged", and it was not read. Re-run without --no-box.',
  ].join('\n'));
}

const probe = tryRun('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', SERVER,
  'cat /opt/olma2/RELEASE; echo "--"; systemctl show -p ActiveEnterTimestamp --value olma2-brokerd; '
  + 'systemctl show -p ActiveEnterTimestamp --value olma2-dashboard; echo "--"; '
  + 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8788/ready']);

if (!probe.ok) {
  step(5, 'what is the box serving?', `UNKNOWN — ${(probe.err || '').split('\n')[0]}`);
  finish('GREEN IN CI, BOX UNREADABLE', [
    'Every job passed, and the box could not be read — which is not evidence of trouble',
    'and not evidence of health either. Nothing here says whether it shipped.',
  ].join('\n'));
}

const [markerText, unitsText, readyText] = probe.out.split('\n--\n');
const marker = Object.fromEntries((markerText || '').split('\n')
  .map((l) => l.split('=')).filter((p) => p.length >= 2)
  .map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
const units = (unitsText || '').split('\n').map((s) => s.trim()).filter(Boolean);
const ready = (readyText || '').trim();

const deployedSha = marker.sha || '';
const shipped = deployedSha && git('merge-base', '--is-ancestor', sha, deployedSha).ok;
const drift = deployedSha ? git('rev-list', '--count', `${deployedSha}..origin/main`).out : null;

step(5, 'what is the box serving?',
  `RELEASE sha=${deployedSha.slice(0, 8)} origin=${marker.origin || '?'} deployed_at=${marker.deployed_at || '?'}`,
  shipped ? `your commit IS in it${drift && drift !== '0' ? `; main is ${drift} commit(s) further ahead` : ''}`
    : 'your commit is NOT in what the box is serving');

const markerAt = Date.parse((marker.deployed_at || '').replace(
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z',
));
const restarts = units.map((u) => Date.parse(u)).filter((n) => Number.isFinite(n));
const restartedAfter = Number.isFinite(markerAt) && restarts.length
  ? restarts.every((r) => r >= markerAt) : null;

step(6, 'did the services restart, and is /ready 200?',
  `${units.join(' | ') || 'unknown'} — /ready ${ready || '?'}`,
  restartedAfter === null ? 'could not compare against the marker'
    : (restartedAfter ? 'both units came up after the marker was written'
      : 'the marker is NEWER than the restart'));

if (!shipped && inconclusive) {
  finish('CANCELLED, AND NOT SHIPPED', [
    `Run ${deployRun.databaseId} ended as ${deployRun.conclusion} before any job started, and the box`,
    `is serving ${deployedSha.slice(0, 8) || 'something else'}, which does not contain your commit.`,
    'So this was not the benign displaced-queue case. Re-run the workflow on main:',
    '',
    `  gh workflow run olma2-tests.yml --ref main --repo ${REPO}`,
  ].join('\n'));
}

if (shipped && inconclusive) {
  finish('DISPLACED, AND CARRIED ANYWAY', [
    `Run ${deployRun.databaseId} ended as ${deployRun.conclusion} before any job started — a later merge`,
    'took the concurrency slot, which on main cancels the queued run outright.',
    '',
    `That is benign here, and the box is what proves it: it serves ${deployedSha.slice(0, 8)}, which`,
    'contains your commit. deploy.sh rsyncs the whole tree, so the displacing deploy',
    'carried your change with it. Nothing to re-run.',
  ].join('\n'));
}

if (!shipped) {
  finish('MERGED BUT NOT ON THE BOX', [
    `main has ${sha.slice(0, 8)} and the box is serving ${deployedSha.slice(0, 8) || 'something else'}.`,
    'CI went green, so the deploy job either never ran for this sha or ran for an older',
    'one. This is what the hourly deploy_drift dashboard row reports. Deploy the merged',
    'sha on the box, or re-run the workflow on main:',
    '',
    `  gh workflow run olma2-tests.yml --ref main --repo ${REPO}`,
  ].join('\n'));
}

if (restartedAfter === false) {
  finish('A MIXED BOX', [
    'RELEASE names your sha but the services came up BEFORE the marker was written.',
    'deploy.sh rsyncs, writes the marker, installs, migrates, runs the suite, and only',
    'then restarts — so a suite failure leaves new code and APPLIED MIGRATIONS on disk',
    'with the old code still serving from memory. /ready is 200 and users are served as',
    'before, which is why this hides.',
    '',
    'Whether it is harmless depends on which files moved: bin/olma-brokerd.js is',
    'long-lived and holds the old ones, while the MCP shim re-execs per tool call.',
    'Check, do not assume. A rollback will not un-apply the migrations.',
  ].join('\n'));
}

if (ready !== '200') {
  finish('SHIPPED, BUT /ready IS NOT 200', [
    `The box is serving your sha and /ready answered ${ready || 'nothing'}.`,
    '/ready is what deploy.sh itself gates on — tests passing in CI never proved the',
    'live process came up. Read the units and the journal before doing anything else.',
  ].join('\n'));
}

finish('SHIPPED AND RUNNING', [
  `The box is serving ${deployedSha.slice(0, 8)}, which contains ${sha.slice(0, 8)}.`,
  `Both units restarted after the marker, /ready is 200${drift && drift !== '0' ? `, and main is ${drift} commit(s) further ahead (other merges, not yours)` : ''}.`,
].join('\n'));

// ── output ─────────────────────────────────────────────────────────────────
function finish(verdict, detail) {
  if (!VERDICTS.includes(verdict)) {
    process.stderr.write(`deploy-triage: "${verdict}" is not in VERDICTS — add it there and to SKILL.md\n`);
    process.exit(3);
  }
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ sha, subject, verdict, detail, steps }, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${sha ? sha.slice(0, 8) : '?'}  ${subject}\n\n`);
    for (const s of steps) {
      if (!s.n) { process.stdout.write(`     ${s.question}: ${s.value}\n`); continue; }
      process.stdout.write(`  ${s.n}. ${s.question}\n     ${s.value}\n`);
      if (s.note) process.stdout.write(`     (${s.note})\n`);
    }
    process.stdout.write(`\n  ── ${verdict} ──\n\n`);
    process.stdout.write(`${detail.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')}\n\n`);
  }
  // Only a verdict that needs a human is non-zero.
  process.exit(['SHIPPED AND RUNNING', 'STILL RUNNING'].includes(verdict) ? 0 : 1);
}
