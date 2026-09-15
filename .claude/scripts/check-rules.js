#!/usr/bin/env node
'use strict';
// Do the rules files actually load, and does the root file still describe them?
//
// A path-scoped rule fails SILENTLY. A glob with a typo in it, or pointing at
// a file that has since been renamed, matches nothing — so the rule never
// loads, nothing says so, and the first sign is somebody repeating an outage
// the rule exists to prevent. Seven of the first ninety-one globs written for
// this split pointed at files that do not exist, including four filenames
// that were simply guessed. That is why this runs in CI.
//
// It checks three things and nothing else:
//   1. every rules file has frontmatter with at least one `paths:` glob;
//   2. every glob matches at least one file in the repo;
//   3. the root CLAUDE.md's "Loads when you Read ... and N more" line agrees
//      with that file's frontmatter, so the index cannot drift from the rules.
//
//   node .claude/scripts/check-rules.js
//
// Exits non-zero and names every problem. No dependencies.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RULES_DIR = path.join(ROOT, '.claude', 'rules');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(ROOT, p));
  }
  return out;
}

// Glob -> RegExp. Supports ** (any depth, including none) and * (one segment).
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `a/**` and `a/**/b` both have to match `a/b`
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const files = walk(ROOT);
const problems = [];

if (!fs.existsSync(RULES_DIR)) {
  console.error(`no ${path.relative(ROOT, RULES_DIR)} directory`);
  process.exit(1);
}

const root = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const names = fs.readdirSync(RULES_DIR).filter((n) => n.endsWith('.md')).sort();
let globCount = 0;

for (const name of names) {
  const rel = path.join('.claude', 'rules', name);
  const body = fs.readFileSync(path.join(RULES_DIR, name), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(body);
  if (!fm) { problems.push(`${rel}: no frontmatter, so it loads unconditionally in every session`); continue; }
  const globs = [...fm[1].matchAll(/^\s*-\s*"(.+?)"\s*$/gm)].map((m) => m[1]);
  if (!globs.length) { problems.push(`${rel}: frontmatter has no paths:`); continue; }

  for (const g of globs) {
    globCount += 1;
    const re = globToRe(g);
    if (!files.some((f) => re.test(f))) {
      problems.push(`${rel}: glob "${g}" matches no file — this rule can never load`);
    }
  }

  // The root must point at this file, and its glob summary must be this file's.
  if (!root.includes(`\`.claude/rules/${name}\``)) {
    problems.push(`${rel}: the root CLAUDE.md never names it, so its rules are invisible from the index`);
    continue;
  }
  const short = globs.map((g) => g.replace('olma2/', ''));
  const want = short.length <= 3
    ? short.map((g) => `\`${g}\``).join(', ')
    : `${short.slice(0, 3).map((g) => `\`${g}\``).join(', ')} and ${short.length - 3} more`;
  if (!root.includes(want)) {
    problems.push(`${rel}: the root's "Loads when you Read" line is stale — it should read ${want}`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in .claude/rules:\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`.claude/rules: ${names.length} files, ${globCount} globs, all matching and all indexed in CLAUDE.md`);
