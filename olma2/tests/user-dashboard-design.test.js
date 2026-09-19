'use strict';
// The page's readability and its hit areas — the two classes of fault that
// never announce themselves. Nothing here renders differently when it breaks:
// a token quietly re-darkened, a ::after dropped by a "tidy up the CSS" pass,
// a sheet that loses `inert`. The page still looks right. It just stops being
// usable for somebody holding a phone, or reading it in the sun, or hearing it
// read aloud — and none of those people are in the room when the change lands.
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

// --- the contrast maths, so the numbers below are checked and not remembered
function ratio(a, b) {
  const lum = (hex) => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// The value a token holds inside one of the three palette blocks. `which` is
// 0 for the bare :root (light), 1 for the prefers-color-scheme block and 2 for
// [data-theme="dark"] — all three have to carry a new token or one of the
// three ways a person can land on this page gets the other theme's colour.
function token(name, which) {
  const hits = page.match(new RegExp('--' + name + ':(#[0-9A-Fa-f]{6})', 'g')) || [];
  assert.equal(hits.length, 3, '--' + name + ' is defined in all three palette blocks');
  return hits[which].split(':')[1];
}

test('nothing on a filled control is white-on-lavender any more', () => {
  // 13px white on --accent measured 2.71:1 in the dark theme, on every primary
  // button, every pressed chip, the selected day and the answer buttons. The
  // colour that sits ON a fill is now its own token, so the light theme can
  // say white and the dark one can say ink.
  assert.equal(token('on-accent', 0), '#FFFFFF');
  assert.equal(token('on-accent', 1), '#17112E');
  assert.equal(token('on-accent', 2), '#17112E');
  assert.ok(ratio(token('on-accent', 1), token('accent', 1)) >= 4.5,
    'ink on the dark theme accent clears 4.5:1');
  // And it is actually USED: a token nothing references is a comment.
  assert.ok((page.match(/color:var\(--on-accent\)/g) || []).length >= 30,
    'every filled control takes its text colour from it');
});

test('the quiet grey is dark enough to be text', () => {
  // --text-3 carries every section label, every field label, the hours down
  // the side of a row and every empty state. It measured 2.33:1 light and
  // 3.46:1 dark. Both are solved against --bg-tint, the darkest ground in the
  // light theme and the lightest in the dark one — the worst case each way,
  // not the white page nobody's eye is actually on.
  assert.ok(ratio(token('text-3', 0), token('bg-tint', 0)) >= 4.5);
  assert.ok(ratio(token('text-3', 1), token('bg-tint', 1)) >= 4.5);
  // A secondary that is not darker than the tertiary is not a hierarchy.
  assert.ok(ratio(token('text-2', 0), token('bg-tint', 0))
    > ratio(token('text-3', 0), token('bg-tint', 0)));
  // The three meaning colours are read as words as often as they are seen as
  // fills — "late", "saved", "muted" — so they clear the bar on the page bg.
  ['danger', 'ok', 'warn'].forEach(function (n) {
    assert.ok(ratio(token(n, 0), token('bg', 0)) >= 4.5, '--' + n + ' as light-theme text');
    assert.ok(ratio(token(n, 1), token('bg', 1)) >= 4.5, '--' + n + ' as dark-theme text');
  });
});

test('a finger gets more than the icon does', () => {
  // Eleven controls drawn between 19 and 31px. The drawing is right — a 44px
  // bin beside a 15px line of text is not a design — so the hit area grew and
  // the picture did not.
  assert.match(page, /\.tick,\.tpin,\.tjump,\.tundo,\.vclear,\.sclear,\.lrm,\.evdrop,\.calnav,\.fq \.fqskip,\.permact\{position:relative\}/,
    'all eleven are positioned, or an ::after has nothing to hang off');
  assert.match(page, /content:"";position:absolute;inset:-9px;border-radius:inherit;/);
  // Where they sit in a row of their own kind the growth is vertical only:
  // two overlapping targets hand the tap to whichever is later in the source.
  assert.match(page, /content:"";position:absolute;inset-block:-9px;inset-inline:-4px;border-radius:inherit;/);
  // Drawn at opacity 0 and returned on hover, which a phone never does.
  assert.match(page, /@media \(hover:none\)\{ \.lrm\{opacity:\.55\} \}/);
});

test('no field is small enough to zoom iOS in', () => {
  // Safari zooms the page when a field under 16px takes focus and does not
  // zoom back out. Search was 15.5px, the fact answer 15px.
  assert.doesNotMatch(page.slice(page.indexOf('.searchwrap input{'), page.indexOf('.searchwrap input::placeholder')),
    /font-size:1[0-5](\.|px)/);
  assert.match(page, /\.searchwrap input\{[\s\S]{0,400}font-size:16px;/);
  assert.match(page, /\.fq \.fqtext\{[\s\S]{0,320}font-size:16px;/);
});

test('a closed sheet is not in the page', () => {
  // A sheet is moved below the bottom of the screen and is otherwise entirely
  // present: its buttons keep their place in the tab order and a screen reader
  // reads straight through six dialogues nobody opened — the task editor's
  // fields arriving between the calendar and the friends list.
  assert.match(page, /el\.inert = !el\.classList\.contains\("show"\);/);
  assert.match(page, /new MutationObserver\(sync\)\.observe\(el, \{attributes:true, attributeFilter:\["class"\]\}\);/,
    'and it follows the class, because nothing central opens these');
});

test('the archive does not end at the eighth row', () => {
  // "Showing the last 8 of 23" was the whole feature: the other fifteen had no
  // route from this page at all. The sentence counting them is the thing you
  // would press, so it is the button.
  assert.match(page, /var shown = arcAll \? archived : archived\.slice\(0, ARCHIVE_MAX\);/);
  assert.match(page, /t\(arcAll \? "tasks\.arcShowLess" : "tasks\.arcShowAll"/);
});

test('leaving a coordination asks from the sheet too', () => {
  // The row in the list asked; the sheet — same action, two taps deeper —
  // went straight out. Leaving takes your answers off everybody's tally.
  assert.match(page, /mtLeaving = m\.id;\n\s*setCalMode\("meet"\);\n\s*renderMeets\(\);/);
});

test('an empty list points at the way out of being empty', () => {
  assert.match(page, /function emptyBig\(text, go, label, icon\)\{/);
  assert.match(page, /<button class="emptygo" data-emptygo="/);
  // The button re-uses a control that already exists further up the page
  // rather than inventing a second route to the same place.
  assert.match(page, /var b = e\.target\.closest\("\[data-emptygo\]"\);/);
});

test('a class that says what something IS may not also say how it looks', () => {
  // `live` meant two unrelated things in one namespace: the header's activity
  // pill, and "this section has real rooms behind it". The groups section wore
  // the pill — a 999px radius, a white ground, a shadow and white-space:nowrap
  // on a 339px-wide block — so a real person in a room got a screen-wide
  // lozenge with the first group's name running off the side of it. Only on a
  // SERVED page, and only past the first room, which is why every design pass
  // on the seeded page saw nothing. The page had already paid for this once:
  // .wordslot's classes are `wnow`/`wout` and its comment says why.
  assert.doesNotMatch(page, /classList\.(toggle|add)\("live"/,
    '`live` is a look on this page, so nothing may wear it to mean a state');
  assert.match(page, /block\.classList\.toggle\("hasrooms", GROUPS\.length > 0\);/);
  // The state class earns its keep only by being invisible: one rule, and that
  // rule decides whether the section is there at all, nothing about its look.
  const rules = page.match(/[^\n{}]*\.hasrooms[^\n{}]*\{[^}]*\}/g) || [];
  assert.equal(rules.length, 1, 'exactly one rule may mention it');
  assert.match(rules[0], /^html\[data-served\] \.groupsblock\.hasrooms\{display:block\}$/);
  // And the pill's own name now describes the pill.
  assert.match(page, /<div class="livepill">/);
  assert.match(page, /\.livepill\{/);
});

// A `var(--x)` naming a token nobody defines is the quietest failure this file
// has: the whole declaration is dropped at computed-value time, so the border
// is simply not there and the page still looks like a page. Three of them were
// written into the suggestion strip on 2026-09-19 and two survived a careful
// read (`--text-1` for `--text`, `--line` for `--sep`) — they were caught by
// looking at the rendered page, which is not a thing that happens on every
// change. A `var(--x, fallback)` is exempt: the fallback IS the definition,
// and that is how every runtime-set custom property on this page is written.
test('every var(--token) without a fallback names a token this file defines', () => {
  // A known-bad one, found by this very check and left alone on purpose: it
  // is somebody else's line to fix, in its own change, not a drive-by edit
  // inside an unrelated PR. `.mopt.best` draws no ring today because of it.
  const KNOWN_BAD = ['--accent-line'];
  const defined = new Set([...page.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...page.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)].map((m) => m[1]));
  const missing = [...used].filter((t) => !defined.has(t) && !KNOWN_BAD.includes(t));
  assert.deepEqual(missing, [], 'these tokens are used but never defined, so the rule is dropped');
  // and the exception list stays honest: an entry that has been fixed is one
  // nobody will remember to remove.
  for (const t of KNOWN_BAD) {
    assert.equal(defined.has(t), false, `${t} is defined now — take it off KNOWN_BAD`);
  }
});
