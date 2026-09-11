#!/usr/bin/env node
// Stop hook: the two things this repo has shipped broken by calling a turn
// finished too early.
//
// Same argument as `shunt.js` and as `markPlaced` before it, and it is the one
// argument this codebase keeps rediscovering: a rule stated in a prompt is a
// REQUEST, and a rule enforced at the tool boundary is a rule. CLAUDE.md has
// said "merging is deploying" and "pick a migration number above the box's max"
// for weeks. The migration number still collided three times in two days.
//
// It blocks TWO things and reports nothing else:
//
//   1. olma2 source changed in THIS session and the suite was never run after
//      the last change. `deploy.sh --restart` runs that same suite on the box
//      on every merge to main, so an untested change is a change that finds
//      out in production.
//
//   2. this branch adds a migration and nothing in the session ever asked the
//      box for `max(version)`. Never `ls migrations/` — two branches in flight
//      cannot see each other's files.
//
// ── What it deliberately does NOT block ────────────────────────────────────
// The third candidate was "a rule changed in CLAUDE.md with no entry in
// incidents.md". Measured against the last 60 commits on main: 22 added a rule
// bullet and 8 of those touched no incident file — and about half of the 8 were
// right to (`shunt.js` is a new tool with no incident behind it; the provider
// pin cites an incident entry that already existed). A 36% block rate on a
// gate nobody can override is how an alarm gets spent, so it is not here. The
// rule stays prose, where it has always been.
//
// FAILS OPEN, always. A hook that cannot be satisfied is worse than no hook:
// every error path, every unreadable transcript and every git failure allows
// the stop. `stop_hook_active` allows immediately, so this can never loop.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Same rule as `placeMark`: a thing that claims nothing must SAY something.
// A hook that allows the stop and a hook that was never wired up are the same
// observation from the outside, and a hook that loads is not a hook that runs
// — this repo lost a night to exactly that with the turn-open gateway hook.
// One line per invocation, in the scratch dir, never in the repo.
const TRACE = path.join(require('node:os').tmpdir(), 'olma-finish-line.log');
function trace(verdict) {
  try {
    fs.appendFileSync(TRACE, `${new Date().toISOString()} ${verdict}\n`);
  } catch { /* a trace that cannot be written must never change the verdict */ }
}

const ALLOW = (why = 'allow') => { trace(why); process.exit(0); };

// Blocking a Stop: exit 2, reason on stderr, which is fed back to the model.
function block(reason) {
  trace(`block: ${reason.split('\n')[0]}`);
  process.stderr.write(reason);
  process.exit(2);
}

// Paths the suite actually covers. `olma2/docs/**` is prose — it redeploys
// production (it matches CI's olma2/** filter) but no test asserts on it.
const TESTED = /^olma2\/(src|bin|tests|migrations|scripts)\//;
const MIGRATION = /^olma2\/migrations\/.+\.sql$/;

// Anything that runs the suite counts, wherever it runs it.
const RAN_TESTS = /\bnpm\s+(?:run\s+)?test\b|\bnode\s+--test\b|run-suite\.sh|deploy\.sh/;
// The box is the only honest answer to "what is the highest migration number".
const ASKED_THE_BOX = /schema_migrations/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Files this branch changes, committed or not, against where it left main.
function changedFiles(root) {
  const out = new Set();
  for (const line of git(root, ['status', '--porcelain']).split('\n')) {
    if (!line.trim()) continue;
    const p = line.slice(3).trim();
    // a rename reads as "old -> new"; only the new path exists
    out.add(p.includes(' -> ') ? p.split(' -> ')[1] : p);
  }
  let base = null;
  try { base = git(root, ['merge-base', 'HEAD', 'origin/main']).trim(); } catch { /* no remote ref */ }
  if (base) {
    for (const p of git(root, ['diff', '--name-only', `${base}..HEAD`]).split('\n')) {
      if (p.trim()) out.add(p.trim());
    }
  }
  return [...out];
}

// What the session did, read off its own transcript. Subagent rows are skipped:
// their work is not this conversation's, and a subagent running tests is not
// evidence that this one did.
function readTranscript(file) {
  const seen = { sessionStart: null, lastTestAt: null, askedTheBox: false, lastEditAt: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.timestamp || '');
    if (Number.isFinite(at) && (seen.sessionStart === null || at < seen.sessionStart)) seen.sessionStart = at;
    if (row.isSidechain) continue;
    if (row.type !== 'assistant') continue;

    for (const c of (row.message && row.message.content) || []) {
      if (!c || c.type !== 'tool_use') continue;
      const input = c.input || {};
      if (c.name === 'Bash' && typeof input.command === 'string') {
        if (RAN_TESTS.test(input.command) && Number.isFinite(at)) {
          if (seen.lastTestAt === null || at > seen.lastTestAt) seen.lastTestAt = at;
        }
        if (ASKED_THE_BOX.test(input.command)) seen.askedTheBox = true;
      }
      if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'NotebookEdit')
          && typeof input.file_path === 'string' && Number.isFinite(at)) {
        if (seen.lastEditAt === null || at > seen.lastEditAt) seen.lastEditAt = at;
      }
    }
  }
  return seen;
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// The decision, with the world passed in: what the branch changed, when each
// of those files was last written, and what the session did. Pure, so the
// self-test can put it in states this repo has actually been in.
// Returns null to allow, or the reason to block with.
function decide({ changed, mtimeOf, seen }) {
  const touched = changed
    .filter((f) => TESTED.test(f))
    .map((f) => [f, mtimeOf(f)])
    .filter(([, m]) => m !== null && m !== undefined && m > seen.sessionStart);

  if (touched.length) {
    const newest = Math.max(...touched.map(([, m]) => m));
    if (seen.lastTestAt === null || seen.lastTestAt < newest) {
      const names = touched.map(([f]) => f).sort();
      const shown = names.slice(0, 6).join('\n  ');
      return [
        'Not finished: olma2 code changed in this session and the suite has not run since.',
        '',
        `  ${shown}${names.length > 6 ? `\n  …and ${names.length - 6} more` : ''}`,
        '',
        seen.lastTestAt === null
          ? 'No test run appears in this session at all.'
          : 'The last test run in this session predates the most recent change.',
        '',
        'Merging is deploying: CI runs `deploy.sh --restart` on every merge to main,',
        'and that runs this same suite on the box, against real Postgres. Run it here',
        'first, where it costs 30 seconds instead of a production deploy:',
        '',
        '  cd olma2 && npm run lint && npm test',
        '',
        'If the suite genuinely cannot run here, say so plainly in your reply and stop',
        'again — this hook allows the second stop rather than trapping you.',
      ].join('\n');
    }
  }

  const migrations = changed.filter((f) => MIGRATION.test(f));
  if (migrations.length && !seen.askedTheBox) {
    return [
      `Not finished: this branch adds a migration (${migrations.sort().join(', ')}) and nothing`,
      'in this session asked the box what the highest applied version is.',
      '',
      "Never `ls migrations/` — two branches in flight cannot see each other's files,",
      'and this has collided three times in two days. Ask the database that will',
      'actually run it:',
      '',
      '  ssh root@157.230.210.233 \'set -a; . /opt/olma2/.env; set +a;',
      '    psql "$OLMA_DB_URL" -Atc "select max(version) from schema_migrations"\'',
      '',
      'Then number the file above that. If you already know the answer from earlier,',
      'run the query anyway so the session carries its own evidence, or stop again to',
      'proceed without it.',
    ].join('\n');
  }

  return null;
}

function run(input) {
  // Already blocked once and the model came back — never loop.
  if (input.stop_hook_active) ALLOW('allow: stop_hook_active — this hook already blocked once');

  const root = path.resolve(__dirname, '..', '..');
  const seen = readTranscript(input.transcript_path);
  if (!seen || seen.sessionStart === null) ALLOW('allow: no readable transcript');

  let changed;
  try { changed = changedFiles(root); } catch { ALLOW('allow: git would not answer'); return; }

  // mtime, not the transcript, decides what was touched: a file written with
  // `sed -i` or a heredoc leaves no Edit tool call, and those are exactly the
  // writes that bypass every other guard in this repo.
  const reason = decide({ changed, mtimeOf: (f) => mtime(path.join(root, f)), seen });
  if (reason) block(reason);
  ALLOW('allow: checklist clear');
}

// ── self-test ──────────────────────────────────────────────────────────────
// A gate that can no longer fail is not a gate, and a gate that fires on
// ordinary work gets turned off. Both directions are asserted here, on the
// states this repo has actually been in.
function selfTest() {
  const os = require('node:os');
  let failures = 0;
  const check = (name, got, want) => {
    const ok = want === null ? got === null : (got !== null && got.includes(want));
    if (!ok) { console.error(`  FAILED: ${name}\n    got: ${got === null ? 'allow' : got.split('\n')[0]}`); failures += 1; }
  };
  const seenAt = (o) => Object.assign(
    { sessionStart: 1000, lastTestAt: null, askedTheBox: false, lastEditAt: null }, o,
  );
  const m = (map) => (f) => (f in map ? map[f] : null);

  // BLOCKS
  check('olma2 source edited, no test run at all',
    decide({ changed: ['olma2/src/domain/tasks.js'], mtimeOf: m({ 'olma2/src/domain/tasks.js': 2000 }), seen: seenAt({}) }),
    'the suite has not run since');
  check('test ran, then the code changed again',
    decide({ changed: ['olma2/src/domain/tasks.js'], mtimeOf: m({ 'olma2/src/domain/tasks.js': 3000 }), seen: seenAt({ lastTestAt: 2000 }) }),
    'predates the most recent change');
  check('a migration with nobody asking the box',
    decide({ changed: ['olma2/migrations/061-x.sql'], mtimeOf: m({ 'olma2/migrations/061-x.sql': 500 }), seen: seenAt({ lastTestAt: 4000 }) }),
    'asked the box');

  // ALLOWS — each of these is ordinary work that must not be interrupted
  check('nothing changed', decide({ changed: [], mtimeOf: m({}), seen: seenAt({}) }), null);
  check('only docs and rules changed',
    decide({ changed: ['CLAUDE.md', '.claude/rules/doctrine.md', 'olma2/docs/incidents.md'],
      mtimeOf: m({ 'CLAUDE.md': 9000, '.claude/rules/doctrine.md': 9000, 'olma2/docs/incidents.md': 9000 }),
      seen: seenAt({}) }), null);
  check('the change predates this session (an older commit on the branch)',
    decide({ changed: ['olma2/src/domain/tasks.js'], mtimeOf: m({ 'olma2/src/domain/tasks.js': 500 }), seen: seenAt({}) }), null);
  check('tests ran after the last change',
    decide({ changed: ['olma2/src/domain/tasks.js'], mtimeOf: m({ 'olma2/src/domain/tasks.js': 2000 }), seen: seenAt({ lastTestAt: 2500 }) }), null);
  check('a migration, and the box was asked',
    decide({ changed: ['olma2/migrations/061-x.sql'], mtimeOf: m({ 'olma2/migrations/061-x.sql': 500 }), seen: seenAt({ askedTheBox: true, lastTestAt: 4000 }) }), null);

  // the transcript reader, on the shapes this session really produces
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-line-'));
  const file = path.join(tmp, 't.jsonl');
  const row = (o) => JSON.stringify(o);
  const bash = (cmd, ts, extra = {}) => row(Object.assign({
    type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] },
  }, extra));
  fs.writeFileSync(file, [
    row({ type: 'user', timestamp: '2026-09-11T09:00:00.000Z' }),
    bash('cd olma2 && npm test', '2026-09-11T09:10:00.000Z'),
    bash('psql "$OLMA_DB_URL" -Atc "select max(version) from schema_migrations"', '2026-09-11T09:20:00.000Z'),
    bash('cd olma2 && npm test', '2026-09-11T09:40:00.000Z', { isSidechain: true }),
    '',
  ].join('\n'));
  const seen = readTranscript(file);
  if (!seen) { console.error('  FAILED: transcript unreadable'); failures += 1; } else {
    if (seen.sessionStart !== Date.parse('2026-09-11T09:00:00.000Z')) { console.error('  FAILED: session start'); failures += 1; }
    if (seen.lastTestAt !== Date.parse('2026-09-11T09:10:00.000Z')) { console.error("  FAILED: a subagent's test run was counted as this session's"); failures += 1; }
    if (!seen.askedTheBox) { console.error('  FAILED: the schema_migrations query was not seen'); failures += 1; }
  }
  if (readTranscript(path.join(tmp, 'nope.jsonl')) !== null) { console.error('  FAILED: a missing transcript must read as null'); failures += 1; }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) { console.error(`\nself-test: ${failures} failure(s)`); process.exit(1); }
  console.log('self-test: 3 blocking states still block, 5 ordinary states still pass, transcript reader ok');
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { run(JSON.parse(raw)); } catch { /* fall through */ }
  ALLOW('allow: hook input unreadable');
});
