#!/usr/bin/env node
'use strict';
// Can GitHub still READ each workflow file.
//
// Written after 2026-09-19, when `.github/workflows/olma2-clock-drift.yml`
// spent a day unparseable and nobody could see it (`olma2/docs/incidents.md`,
// "Four em-dashes stopped the clock-drift suite"). An edit re-encoded four
// em-dashes — `E2 80 94` read back as latin-1 and written out again — leaving
// `â` plus U+0080 and U+0094 in the COMMENTS. YAML forbids those characters
// anywhere in a document, so GitHub could no longer read the file's `on:`,
// the four-a-day schedule stopped, and the only outward sign was a red,
// job-less run on a trigger the file does not have.
//
// **This is not a YAML linter and deliberately not actionlint.** It checks the
// classes of fault a human review cannot see and a normal CI run cannot
// report — bytes that are invisible in every editor, in a file that is only
// read by the service it configures. A structural mistake in a workflow that
// DOES trigger announces itself the next time it runs; one in a scheduled file
// announces itself by going quiet, which is the whole reason this exists.
//
// The authority is GitHub's own parser, and the only proof is a run: after
// repairing such a file, `gh workflow run <file> --ref main` and watch it
// produce real jobs. This script is what stops the next one from merging.
//
//   node .claude/scripts/check-workflows.js              # check the repo
//   node .claude/scripts/check-workflows.js --self-test  # prove it still fails
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', '.github', 'workflows');

// What YAML will not accept, and what no editor shows you. C0 minus the three
// whitespace characters a document may hold, DEL, and the whole C1 block —
// which is where a double-encoded em-dash, en-dash or curly quote lands.
function badChar(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return null;
  if (code < 0x20) return 'C0 control character';
  if (code === 0x7f) return 'DEL';
  if (code >= 0x80 && code <= 0x9f) return 'C1 control character (a re-encoded punctuation mark looks like this)';
  return null;
}

function faultsIn(name, buf) {
  const out = [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    out.push({ file: name, line: 0, col: 0, what: 'not valid UTF-8' });
    return out;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (let c = 0; c < line.length; c++) {
      const code = line.codePointAt(c);
      const what = badChar(code);
      if (what) {
        out.push({
          file: name, line: i + 1, col: c + 1,
          what: `U+${code.toString(16).toUpperCase().padStart(4, '0')} — ${what}`,
        });
      }
      // A BOM is legal only as the very first character of the document.
      if (code === 0xfeff && !(i === 0 && c === 0)) {
        out.push({ file: name, line: i + 1, col: c + 1, what: 'U+FEFF — a byte-order mark in the middle of the file' });
      }
    }
    // YAML forbids a tab in indentation. It is the other fault that survives
    // a careful read, because a tab and four spaces are the same picture.
    if (/^[ ]*\t/.test(line)) {
      out.push({ file: name, line: i + 1, col: line.indexOf('\t') + 1, what: 'a tab in the indentation' });
    }
  });
  // Truncation, the one structural fault worth naming: a workflow with no
  // trigger or no jobs is a file GitHub keeps and never runs.
  const top = new Set();
  for (const line of lines) {
    const m = /^(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1\s*:/.exec(line);
    if (m) top.add(m[2]);
  }
  // `on` unquoted is YAML 1.1's boolean true, which is why it may be written
  // either way and why both spellings have to count here.
  if (!top.has('on') && !top.has('true')) out.push({ file: name, line: 0, col: 0, what: 'no top-level `on:` — nothing would ever trigger it' });
  if (!top.has('jobs')) out.push({ file: name, line: 0, col: 0, what: 'no top-level `jobs:`' });
  return out;
}

function checkDir(dir) {
  const names = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const faults = [];
  for (const name of names) faults.push(...faultsIn(name, fs.readFileSync(path.join(dir, name))));
  return { names, faults };
}

function report({ names, faults }) {
  if (!faults.length) {
    console.log(`workflows: ${names.length} files, every one readable`);
    return 0;
  }
  for (const f of faults) {
    const where = f.line ? `${f.file}:${f.line}:${f.col}` : f.file;
    console.error(`${where}  ${f.what}`);
  }
  console.error('');
  console.error('GitHub cannot parse a file like this, so it cannot read its triggers either:');
  console.error('a scheduled workflow simply stops, and says so only as a job-less red run on push.');
  return 1;
}

// --- self-test. A detector that can no longer fail is not a detector, and
// this one is checked in both directions: the real bytes that killed the
// clock-drift suite must go red, and ordinary content — em-dashes, Hebrew,
// emoji, all of which this repo's workflows genuinely contain — must not.
const CLEAN = [
  'name: ok',
  '# A comment with an em-dash — and Hebrew, "עולמה", and an emoji 👍.',
  'on:',
  "  schedule:",
  "    - cron: '0 2 * * *'",
  'jobs:',
  '  suite:',
  '    runs-on: ubuntu-latest',
  '',
].join('\n');

function selfTest() {
  const MANGLED = '\u00e2\u0080\u0094';       // an em-dash, written out and re-read as latin-1
  const cases = [
    ['a clean file', CLEAN, 0],
    ['the real mangled em-dash', CLEAN.replace('—', MANGLED), 1],
    ['a tab in the indentation', CLEAN.replace('  schedule:', '\tschedule:'), 1],
    ['no trigger at all', CLEAN.replace('on:\n', ''), 1],
    ['no jobs', CLEAN.replace('jobs:\n', ''), 1],
    ['a stray NUL', CLEAN.replace('name: ok', 'name: o' + String.fromCharCode(0) + 'k'), 1],
  ];
  let bad = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-selftest-'));
  try {
    for (const [what, body, wantFaults] of cases) {
      const faults = faultsIn('case.yml', Buffer.from(body, 'utf8'));
      const got = faults.length ? 1 : 0;
      const ok = got === wantFaults;
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}: ${faults.length} fault(s)${faults[0] ? ' — ' + faults[0].what : ''}`);
    }
    // And the same through the directory walk, so the walk is covered too.
    fs.writeFileSync(path.join(dir, 'good.yml'), CLEAN);
    fs.writeFileSync(path.join(dir, 'bad.yml'), CLEAN.replace('—', MANGLED));
    const walked = checkDir(dir);
    const ok = walked.names.length === 2 && walked.faults.length > 0
      && walked.faults.every((f) => f.file === 'bad.yml');
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  the walk reads both files and blames the right one`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad ? `self-test: ${bad} case(s) wrong` : 'self-test: both directions hold');
  return bad ? 1 : 0;
}

if (require.main === module) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : report(checkDir(DIR)));
}

module.exports = { faultsIn, checkDir };
