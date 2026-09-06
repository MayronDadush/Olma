'use strict';
// The page's two string tables, checked against each other and against the
// page that renders them. Every finding these tests exist for was found by
// READING: a sentence that described a button nobody could press, an empty
// state that sent you to the chat while the control to fix it sat above the
// words, and a key defined twice in two languages and rendered nowhere. None
// of those breaks anything, which is exactly why nothing catches them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

// The tables are object literals inside the page's own script — `he:{ … },`
// then `en:{ … }`. Slicing on those two markers is enough and stays honest:
// if either marker moves, the slice comes back empty and the count assertions
// below fail loudly rather than passing on nothing.
function table(name, until) {
  const from = PAGE.indexOf(`\n    ${name}:{ dir:`);
  assert.ok(from > 0, `the ${name} table has moved — this test is reading the wrong thing`);
  const to = until ? PAGE.indexOf(`\n    ${until}:{ dir:`, from) : PAGE.indexOf('\n  };', from);
  assert.ok(to > from, `the end of the ${name} table has moved`);
  return PAGE.slice(from, to);
}
// A key is quoted, followed by a colon, and sits after `{`, a comma or a line
// start — which keeps a colon inside a sentence from reading as a key.
function keysOf(src) {
  const out = new Set();
  const re = /(^|[{,\s])"([a-zA-Z][\w.]*)"\s*:/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[2]);
  return out;
}

const HE = keysOf(table('he', 'en'));
const EN = keysOf(table('en', null));

test('both languages say the same things', () => {
  assert.ok(HE.size > 300, `only ${HE.size} Hebrew keys parsed — the table shape changed`);
  const missingEn = [...HE].filter((k) => !EN.has(k));
  const missingHe = [...EN].filter((k) => !HE.has(k));
  assert.deepEqual(missingEn, [], 'defined in Hebrew and not in English');
  assert.deepEqual(missingHe, [], 'defined in English and not in Hebrew');
});

test('every string the tables define is a string the page can reach', () => {
  // Everything outside the two tables: the markup, the handlers, the render
  // functions. A key is reachable if something there names it — `t("k")`,
  // `data-i18n="k"`, or, for a plural family, `pl("k", n)` naming the stem.
  const heStart = PAGE.indexOf('\n    he:{ dir:');
  const enEnd = PAGE.indexOf('\n  };', PAGE.indexOf('\n    en:{ dir:'));
  const rest = PAGE.slice(0, heStart) + PAGE.slice(enEnd);

  // …and a family built at run time — `t("tcat." + x.cat)`, `pl("fr.p", n)` —
  // is reached through its PREFIX, so collect those and count them as uses.
  const prefixes = [...rest.matchAll(/["'`]([a-zA-Z][\w.]*\.)["'`]\s*\+/g)].map((m) => m[1]);
  const named = (k) => rest.includes(`"${k}"`) || rest.includes(`'${k}'`);

  const dead = [...HE].filter((k) => {
    if (named(k)) return false;
    if (prefixes.some((p) => k.startsWith(p))) return false;
    const stem = k.replace(/\.(n0|n1|nN)$/, '');
    return stem === k || !named(stem);
  });
  // Sixteen the page already carried when this test was written. Each was
  // checked by hand: nothing outside the tables names it, and nothing builds
  // it from a prefix. They are left where they are on purpose — this PR is
  // about two sentences, not a sweep — and listed here so the guard is a
  // RATCHET: a new dead string fails, and the day these go the list goes with
  // them. Nothing may be added to it.
  const KNOWN_DEAD = [
    'a11y.edit', 'access', 'ch.hint', 'me.formHint', 'mt.stateReady',
    'perm.read', 'perm.write', 'sheet.date', 'sheet.edit', 'sheet.new',
    'sheet.save', 'sheet.time', 'tasks.doneAt', 'tasks.open',
    'toast.needTitle', 'tools.h',
  ];
  assert.deepEqual(dead.filter((k) => !KNOWN_DEAD.includes(k)).sort(), [],
    'defined in both languages and rendered by nothing — delete it or render it');
  assert.deepEqual(KNOWN_DEAD.filter((k) => !dead.includes(k)), [],
    'this one came back to life or was deleted — take it off the list');
});

test('the empty coordination list points at a button that is really there', () => {
  // The words are "open one above". They are true only while the ➕ lives in
  // the coordination mode and the sheet behind it actually starts a meeting.
  assert.match(PAGE, /"mt\.empty":"אין תיאום פעיל כרגע\. אפשר לפתוח אחד למעלה/);
  assert.match(PAGE, /\$\("#mtNew"\)\.hidden = mode === "cal";/,
    'the button has to be visible in the coordination mode for that sentence to be true');
  assert.match(PAGE, /API\.send\("startMeeting"/,
    'and pressing it has to reach the server, not just draw a card');
});

test('the note describes the settling the server actually does', () => {
  // It used to promise a separate "settle" tap. There is no such control on
  // this page, and there is no such step in the domain: one option answered
  // yes by everyone still in the meeting confirms itself.
  assert.doesNotMatch(PAGE, /הקביעה עצמה היא לחיצה נפרדת/);
  assert.doesNotMatch(PAGE, /Settling is a separate tap/);
  assert.match(PAGE, /"mt\.note":"תשובה אומרת אם אתה יכול — לא שקבעתם\. כשכולם מסמנים/);

  const options = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'domain', 'meeting-options.js'), 'utf8');
  assert.match(options, /status = 'confirmed'/,
    'the sentence is only true while the options module still confirms on its own');
});
