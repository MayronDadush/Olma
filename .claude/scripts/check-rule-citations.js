#!/usr/bin/env node
'use strict';
// Does every rule still cite something that exists?
//
// `check-rules.js` proves a rules file can LOAD. This proves its contents are
// still true about the code. A rule is a compression of an incident, and it
// names the file, function, migration or constant that carries it — so a
// rename moves the code and leaves the rule pointing at nothing. Nothing says
// so. The rule keeps loading, keeps costing tokens, and quietly sends the next
// session to a function that is not there. That is the same silent failure
// `check-rules.js` was written for, one level down.
//
// Report only. No model, no network, no dependencies, and it never edits a
// rule — what a stale citation should say is a judgement, and this only says
// that one exists.
//
//   node .claude/scripts/check-rule-citations.js
//   node .claude/scripts/check-rule-citations.js --self-test
//
// WHAT IT READS: CLAUDE.md and .claude/rules/*.md, and nothing else.
// `olma2/docs/incidents.md` is deliberately OUT of the corpus: it is the
// narrative of what happened, it describes code that was deleted on purpose,
// and a citation there going stale is the record working, not breaking.
//
// ── What it checks, and what was measured before shipping (2026-09-11) ──────
// The corpus was 12 files and 723 distinct code spans. Four readings survived
// the measurement and four categories were tried and thrown away. A checker
// with a known-benign row on every run is one nobody reads, so the bar was
// zero false positives on the corpus as it stood, not "mostly right".
//
//   KEPT  repo file paths           132 citations, all resolve
//   KEPT  module.fn (function-shaped) 27 citations, all resolve
//   KEPT  migration NNN                7 citations, all resolve
//   KEPT  OLMA_* and SCREAMING_CASE   42 citations, all present in source
//
// ── What it does NOT check, on purpose ─────────────────────────────────────
// A function cited by its BARE name — `normaliseTitle`, `openTitles`,
// `placeMark` — is not checked, and renaming one is not reported. That is the
// price of rejected reading 1 below: the same shape carries column names, job
// names, tool names and shell commands, and no test separated them. Cite a
// function as `module.fn` and it is checked; cite it bare and it is not.
//
// ── The readings that were REJECTED, and the real rows that killed them ─────
// Kept here rather than deleted, because the next person to widen this will
// reach for exactly these. `--self-test` proves they would still misfire.
//
//  1. BARE IDENTIFIERS in backticks, checked against definitions in src.
//     251 checkable, 147 of them "missing" — a 58% false-positive rate. The
//     corpus backticks column names (`due_at`, `sent_at`, `last_error`), job
//     names (`liveness_watch`, `promise_watch`), tool names (`list_my_tasks`,
//     `get_my_digest`), column values (`followup`, `whatsapp`, `chasing`),
//     shell commands (`grep`, `pg_dump`), Claude Code tools (`Read`, `Edit`)
//     and SQL keywords (`WHERE`). None of those is a function and all of them
//     are correct. A hint that fires on ordinary input is worse than no hint.
//
//  2. ANY dotted name as module.function. 31 checkable, 9 "missing", 29% —
//     and all nine were table.column, not module.function: `users.timezone`,
//     `users.is_eval`, `users.first_name`, `users.opening_sent_at`,
//     `users.timezone_asked_at`, `tasks.kind`, `turn.messageId`,
//     `turn.context_without_open`, `picker.TOKEN_RE`. Our tables and our
//     domain modules share their names, so the shape alone cannot separate
//     them. The fix is the narrower one below: only a right-hand side shaped
//     like a function name (lowercase first letter, an internal capital, no
//     underscore) is checked, which excludes every snake_case column and
//     every SCREAMING_CASE constant.
//
//  3. SCREAMING_CASE checked against a DECLARATION. 21 checkable, 5 "missing",
//     24% — `NO_REPLY` (a string literal, never a declared const), `WHERE`
//     (SQL), `RELEASE` (a file on the box), `SHUNT_MIN_LINES` and
//     `NODE_TEST_CONTEXT` (both read as `process.env.X`, never declared). All
//     five are real. Presence in the source is the honest question for this
//     shape, and it still catches the case that matters: a constant renamed
//     away entirely leaves the old name nowhere.
//
//  4. EVERY path-shaped span. 231 checkable, 103 "missing", 45% — server
//     paths (`/opt/olma2/`, `/root/.openclaw/`), HTTP routes (`/health`,
//     `/me`, `/privacy`), globs (`olma2/**`), commands with arguments
//     (`bash olma2/scripts/deploy.sh --restart`, `scripts/rollback.sh
//     --list`), and shorthands (`preferences.remember/forget`). A path is
//     checked only when its shape leaves no doubt it is a repo path.
//
// ── Two things the self-test did not catch and a live rename did ───────────
// Both were found by renaming a real function in a real file and watching this
// script stay green, which is the only proof that matters for a detector.
//
//  a. A citation wrapped across two lines was never extracted at all. See
//     `unwrapSpans`. `domain/hebrew-quality.flawsIn` is split after the dot,
//     and the script was pointed straight at it and reported nothing.
//  b. `\bname\s*\(` accepted a CALL as a definition, so a function deleted
//     from a module that still called it read as present. See `definedIn`.
//

// Exits non-zero and names every problem.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

// A citation this repo cannot resolve and should not be asked about again.
// Every entry needs a reason, so that a list nobody can justify cannot grow.
const ALLOWED = new Map([
  ['tools/email.js', 'deleted on purpose (gmail.readonly is a restricted scope); the rule that names it is about the deletion'],
]);

// ── reading the repo ───────────────────────────────────────────────────────
function tracked(...globs) {
  const out = execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const files = tracked();
const fileSet = new Set(files);
// A rule may cite `jobs/checkin.js` for `olma2/src/jobs/checkin.js`, so any
// path suffix that ends on a segment boundary resolves.
const byTail = new Set();
for (const f of files) {
  const seg = f.split('/');
  for (let i = 0; i < seg.length; i += 1) byTail.add(seg.slice(i).join('/'));
}

const SRC_GLOBS = ['olma2/src/*.js', 'olma2/bin/*.js', 'olma2/scripts/*.js'];
const srcFiles = tracked(...SRC_GLOBS);
const srcText = new Map(srcFiles.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

// module basename -> files. The corpus cites both `config-guard` and
// `config_guard`, so both spellings resolve to the same file.
const modules = new Map();
for (const f of srcFiles) {
  const base = path.basename(f, '.js');
  for (const key of new Set([base, base.replace(/-/g, '_')])) {
    if (!modules.has(key)) modules.set(key, []);
    modules.get(key).push(f);
  }
}

// Every name in every text file the repo tracks, for the presence check.
const ALL_SOURCE = tracked('*.js', '*.sh', '*.sql', '*.yml', '*.yaml')
  .filter((f) => !f.startsWith('olma2/docs/'))
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');

const MIGRATIONS = new Set(tracked('olma2/migrations/*.sql')
  .map((f) => /(\d{3})-/.exec(path.basename(f)))
  .filter(Boolean)
  .map((m) => String(Number(m[1]))));

// ── the four readings ──────────────────────────────────────────────────────
const SOURCE_EXT = /\.(js|sh|sql|ya?ml|html|md)$/;

// Reading 4, narrowed: a span is a repo path only when nothing else fits.
function isRepoPath(s) {
  return s.includes('/')
    && SOURCE_EXT.test(s)
    && !/[\s*?<>$"'()[\]|]/.test(s)   // globs, arguments, placeholders
    && !/YYYY|MM-DD/.test(s)          // `memory/YYYY-MM-DD.md` is a pattern
    && !s.startsWith('/')             // absolute paths live on the box
    && !s.startsWith('~')
    && !/^https?:/.test(s);
}

// Reading 2, narrowed: lowercase first letter, an internal capital, no
// underscore — which no column name and no constant can satisfy.
const isFunctionName = (n) => /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(n);

// A DEFINITION, not a call. `\bname\s*\(` alone would also match every call
// site, so a function deleted from a module that still calls it would read as
// present — the method-shorthand form therefore has to end in a brace.
function definedInText(name, text) {
  const re = new RegExp(
    `function\\s+${name}\\b`                        // function name(
    + `|(?:const|let|class)\\s+${name}\\b`           // const name =
    + `|\\b${name}\\s*:`                             // name: fn, or an exports map
    + `|(?:async\\s+)?\\b${name}\\s*\\([^)]*\\)\\s*\\{`   // async name(a, b) {
    + `|\\.${name}\\s*=`                             // exports.name =
    + `|\\bmodule\\.exports\\s*=\\s*\\{[^}]*\\b${name}\\b`, // module.exports = { name }
  );
  return re.test(text || '');
}

const definedIn = (name, file) => definedInText(name, srcText.get(file) || '');

// Reading 3: a constant or env var, asked only whether the name still exists.
const isConstantName = (n) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(n) || /^[A-Z]{4,}$/.test(n);
const presentInSource = (n) => new RegExp(`\\b${n}\\b`).test(ALL_SOURCE);

// ── the corpus ─────────────────────────────────────────────────────────────
function corpus() {
  const out = ['CLAUDE.md'];
  const dir = path.join(ROOT, '.claude', 'rules');
  if (fs.existsSync(dir)) {
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      out.push(path.join('.claude', 'rules', n));
    }
  }
  return out;
}

// These files are hard-wrapped at 79 columns, so a long citation is routinely
// split across two lines — `domain/hebrew-quality.` / `flawsIn`. Extracting
// spans line by line silently skips every one of those, which is how the first
// version of this script failed to notice a renamed function it was pointed
// straight at. A line holding an odd number of backticks has an open span, so
// it is joined to the next before anything is extracted, with no space added:
// the corpus wraps at a `.`, a `/` or a `-`, never mid-word.
function unwrapSpans(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const prev = out.length - 1;
    if (prev >= 0 && (out[prev].match(/`/g) || []).length % 2 === 1) {
      out[prev] += line.replace(/^\s+/, '');
    } else out.push(line);
  }
  return out.join('\n');
}

function check(corpusFiles) {
  const problems = [];
  const counts = { path: 0, fn: 0, migration: 0, name: 0 };

  for (const rel of corpusFiles) {
    const text = unwrapSpans(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1].trim();
      if (ALLOWED.has(span)) continue;

      if (isRepoPath(span)) {
        counts.path += 1;
        if (!fileSet.has(span) && !byTail.has(span)) {
          problems.push(`${rel}: cites \`${span}\`, which is not a file in this repo`);
        }
        continue;
      }

      // `reminders.retireForMovedTask` and `domain/voice.callAvailable` are
      // the same citation; only the last segment before the dot names a file.
      const dotted = /^(?:[\w.$-]+\/)*([A-Za-z_$][\w$-]*)\.([A-Za-z_$][\w$]*)$/.exec(span);
      if (dotted && modules.has(dotted[1]) && isFunctionName(dotted[2])) {
        counts.fn += 1;
        const where = modules.get(dotted[1]);
        if (!where.some((f) => definedIn(dotted[2], f))) {
          problems.push(`${rel}: cites \`${span}\`, but ${dotted[2]} is not defined in ${where.join(' or ')}`);
        }
        continue;
      }

      for (const name of new Set([...span.matchAll(/\b(OLMA_[A-Z0-9_]+)\b/g)].map((x) => x[1]))) {
        counts.name += 1;
        if (!presentInSource(name)) {
          problems.push(`${rel}: cites \`${name}\`, which appears nowhere in the source`);
        }
      }
      if (isConstantName(span) && !span.startsWith('OLMA_')) {
        counts.name += 1;
        if (!presentInSource(span)) {
          problems.push(`${rel}: cites \`${span}\`, which appears nowhere in the source`);
        }
      }
    }

    for (const m of text.matchAll(/\bmigration\s+(\d{1,3})\b/gi)) {
      counts.migration += 1;
      if (!MIGRATIONS.has(String(Number(m[1])))) {
        problems.push(`${rel}: cites migration ${m[1]}, which is not in olma2/migrations/`);
      }
    }
  }
  return { problems, counts };
}

// ── self-test: prove it can still go red ───────────────────────────────────
// A detector that can no longer fail is not a detector. This plants each of
// the four readings' failing case in a temporary corpus file and asserts the
// checker names it, then asserts the four rejected readings above still would
// have misfired on citations the corpus really contains.
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rule-cite-'));
  const rel = path.relative(ROOT, path.join(tmp, 'fixture.md'));
  const cases = [
    ['olma2/src/domain/no-such-module.js', 'a renamed file'],
    ['reminders.noSuchFunctionHere', 'a renamed function'],
    ['domain/voice.noSuchProbeHere', 'a renamed function cited with its directory'],
    ['OLMA_NO_SUCH_ENV_VAR_AT_ALL', 'a deleted env var'],
    ['NO_SUCH_CONSTANT_NAME', 'a deleted constant'],
  ];
  let failures = 0;
  for (const [citation, what] of cases) {
    fs.writeFileSync(path.join(tmp, 'fixture.md'), `- a rule citing \`${citation}\`\n`);
    const { problems } = check([rel]);
    if (!problems.some((p) => p.includes(citation))) {
      console.error(`  self-test FAILED: ${what} (\`${citation}\`) was not reported`);
      failures += 1;
    }
  }
  fs.writeFileSync(path.join(tmp, 'fixture.md'), '- a rule citing migration 999\n');
  if (!check([rel]).problems.some((p) => p.includes('migration 999'))) {
    console.error('  self-test FAILED: a missing migration was not reported');
    failures += 1;
  }

  // (a) the wrapped citation, which the first version skipped entirely.
  fs.writeFileSync(path.join(tmp, 'fixture.md'),
    'a rule citing `domain/voice.\n  noSuchWrappedFunction` across a line break\n');
  if (!check([rel]).problems.some((p) => p.includes('noSuchWrappedFunction'))) {
    console.error('  self-test FAILED: a citation wrapped across two lines was not reported');
    failures += 1;
  }

  // (b) a call site is not a definition.
  const callOnly = 'async function other() {\n  return await someFn(user);\n}\n';
  if (definedInText('someFn', callOnly)) {
    console.error('  self-test FAILED: a call site was accepted as a definition');
    failures += 1;
  }
  for (const [decl, what] of [
    ['function someFn(a) {}', 'function declaration'],
    ['const someFn = () => 1;', 'const arrow'],
    ['module.exports = { someFn };', 'exports map'],
    ['  async someFn(a, b) {\n  }', 'method shorthand'],
    ['exports.someFn = 1;', 'exports assignment'],
  ]) {
    if (!definedInText('someFn', decl)) {
      console.error(`  self-test FAILED: a ${what} was not recognised as a definition`);
      failures += 1;
    }
  }

  // The rejected readings, on real spans the corpus contains today.
  const mustNotFire = [
    ['due_at', 'a column name'],
    ['list_my_tasks', 'a tool name'],
    ['liveness_watch', 'a job name'],
    ['WHERE', 'a SQL keyword'],
    ['users.timezone', 'a table.column, not a module.function'],
    ['tasks.kind', 'a table.column, not a module.function'],
    ['NO_REPLY', 'a string literal, never a declared const'],
    ['/opt/olma2/RELEASE', 'a path on the box, not in the repo'],
    ['olma2/**', 'a glob'],
    ['bash olma2/scripts/deploy.sh --restart', 'a command with arguments'],
  ];
  for (const [citation, what] of mustNotFire) {
    fs.writeFileSync(path.join(tmp, 'fixture.md'), `- a rule citing \`${citation}\`\n`);
    const { problems } = check([rel]);
    if (problems.length) {
      console.error(`  self-test FAILED: \`${citation}\` is ${what} and must not be reported — got: ${problems[0]}`);
      failures += 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) { console.error(`\nself-test: ${failures} failure(s)`); process.exit(1); }
  console.log(`self-test: ${cases.length + 1} failing cases still reported, ${mustNotFire.length} rejected readings still silent`);
}

// ── run ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) { selfTest(); process.exit(0); }

const list = corpus();
const { problems, counts } = check(list);
const total = counts.path + counts.fn + counts.migration + counts.name;

if (problems.length) {
  console.error(`${problems.length} stale citation(s) in ${list.length} rule files:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nEach names something the code no longer has. Fix the rule, or add it to');
  console.error('ALLOWED in this script WITH a reason if the absence is the point.');
  process.exit(1);
}
console.log(`rule citations: ${total} checked across ${list.length} files — `
  + `${counts.path} paths, ${counts.fn} functions, ${counts.migration} migrations, `
  + `${counts.name} names; all resolve`);
