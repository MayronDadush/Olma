'use strict';
// The page's small movements, and the one thing they all have in common: each
// of them died the same way, by something being REBUILT instead of changed.
// A transition needs a node that survives the change, so every assertion here
// is really "this render still does the cheap thing" — which is exactly what
// the next refactor will undo without noticing, because nothing breaks. The
// page looks identical; it just stops moving.
//
// Text assertions against the served file, like the rest of this page's suite
// (docs/design/user-dashboard.html is shipped verbatim by
// adapters/http/user-dashboard.js, so there is no build step to read instead).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

test('a day is SELECTED, not redrawn — and a week is', () => {
  // `.day` has carried a background transition since it was written and it had
  // never once played: every tap threw the seven buttons away and drew seven
  // new ones, one of them already selected.
  assert.match(page, /if\(stripWeek !== weekOff \|\| cells\.length !== 7\)\{/,
    'the strip is rebuilt only when the WEEK changes');
  assert.match(page, /b\.setAttribute\("aria-selected", i === sel \? "true" : "false"\)/,
    'and the selection is an attribute on a button that stays');
  assert.match(page, /renderStrip\(weekOff === 0 \? 0 : weekOff \* 7, weekOff === was \? 0 : weekOff > was \? 1 : -1\)/,
    'paging tells the strip which way it went, so the new week can arrive from that side');
});

test('ticking an item off a list does not rebuild the list', () => {
  // `.litem.on` scales a check in and draws a strike across the words over
  // .42s. Both were unreachable: the tick called renderSheetList().
  assert.match(page, /tg\.closest\("\.litem"\)\.classList\.toggle\("on", it\.done\);\n\s*tg\.setAttribute\("aria-pressed"[^\n]*\);\n\s*paintListMeta\(\);/,
    'the row is toggled in place and only the counters are repainted');
  assert.doesNotMatch(page.slice(page.indexOf('var tg = e.target.closest("[data-titem]")'), page.indexOf('var rm = e.target.closest("[data-ritem]")')),
    /renderSheetList\(\)/, 'nothing in the tick path may redraw the rows');
});

test('a row leaving a list folds, and is spliced only once it has gone', () => {
  assert.match(page, /function foldAway\(el, done\)\{/);
  assert.match(page, /el\.style\.maxHeight = el\.scrollHeight \+ "px";/,
    'measured: max-height only animates between two real numbers');
  // The indexes every other row is addressed by shift the moment the array
  // does, so the splice waits for the fold rather than racing it.
  assert.match(page, /foldAway\(rm\.closest\("\.litem"\), function\(\)\{/);
  assert.match(page, /var at = editing\.items\.indexOf\(gone\);/,
    'and the item is found again, not remembered by index');
});

test('a finished list and an empty one say different things', () => {
  // These were one sentence — "nothing open, clear day" — said equally to
  // somebody who had just closed eleven things and to somebody who had none.
  assert.match(page, /html = '<div class="group">' \+ \(archived\.length/,
    'which sentence is chosen by whether anything was archived today');
  assert.match(page, /"tasks\.allDone":"סיימת הכול"/);
  assert.match(page, /"tasks\.allDone":"All done"/);
  assert.match(page, /pl\("tasks\.allDoneSub", archived\.length\)/,
    'and the count under it is plural-aware, like every other count on this page');
});

test('completing or deleting a task offers the way back, in the toast', () => {
  // The way back has always existed — the undo button inside the archive fold,
  // which is a fold most people never open.
  assert.match(page, /toast\(t\("toast\.done"\), i > -1 \? function\(\)\{ restoreTask\(id\); \} : null\);/,
    'a tick can be undone for as long as the toast is up');
  // Delete is gone for good on the server (owner, 2026-09-23), so the undo
  // cannot be a restore: the page holds the delete back until the toast and
  // its button are gone, and the undo simply never sends it.
  assert.match(page, /toast\(t\("toast\.deleted"\), function\(\)\{ undoTaskDelete\(k\); \}\);/);
  assert.match(page, /DELETING\[k\] = \{row:row, at:at, timer:setTimeout\(function\(\)\{ commitDelete\(k\); \}, DELETE_AFTER_MS\)\};/);
  assert.match(page, /DELETE_AFTER_MS = 4600;/, 'held past the toast, so the undo is never a lie');
  assert.match(page, /function undoTaskDelete\(k\)\{[\s\S]{0,120}clearTimeout\(d\.timer\);/);
  assert.match(page, /window\.addEventListener\("pagehide", flushDeletes\);/, 'and leaving the page sends what is waiting');
  assert.match(page, /\.filter\(function\(x\)\{ return !DELETING\[String\(x\.id\)\]; \}\)/,
    'a reload during the wait does not draw the row back');
  assert.match(page, /undo \? 4200 :/, 'and a toast carrying a button stays long enough to reach it');
});

test('less motion means less motion, including the animations that loop', () => {
  // The rule shortened durations and said nothing about iteration count, so an
  // infinite animation became a one-millisecond frame repeated for ever —
  // a flicker, which is worse than the movement it was replacing.
  assert.match(page, /animation-iteration-count:1 !important/);
  // CSS cannot see a scroll JS decides to make smooth.
  assert.match(page, /behavior:REDUCED \? "auto" : "smooth"/);
  assert.equal(page.match(/behavior:REDUCED \? "auto" : "smooth"/g).length, 2,
    'both of them: the jump to a day in the calendar, and the tab switch');
  assert.doesNotMatch(page, /behavior:"smooth"/, 'and neither one is left unguarded');
});
