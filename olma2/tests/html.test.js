'use strict';
// adapters/http/html.js is the one escaper every server-rendered page shares.
// Its contract is small and load-bearing: the five HTML metacharacters, and
// nullish renders as nothing rather than as the word "null" in somebody's
// task title. Pinned here so a future "simplification" to four characters —
// or to String(s) — is a red test, not a stored-XSS report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { esc } = require('../src/adapters/http/html');

test('escapes exactly the five HTML metacharacters', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc('שלום, עולם'), 'שלום, עולם', 'nothing else is touched');
});

test('nullish is empty, everything else is stringified', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});

test('the three pages share this one definition', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['dashboard.js', 'user-dashboard.js', 'picker.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'http', f), 'utf8');
    assert.match(src, /require\('\.\/html'\)/, `${f} imports it`);
    assert.doesNotMatch(src, /const esc = |function esc\(/, `${f} no longer defines its own`);
  }
});
