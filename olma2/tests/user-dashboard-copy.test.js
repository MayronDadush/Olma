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
  ];
  // `tools.h` left this list on 2026-09-26: the first tab became the home
  // page, and "החיבורים שלך" is the heading over the connections under it.
  // `toast.needTitle` left this list on 2026-09-17: a list item typed into a
  // task that has no name is now told what is missing, instead of being shown
  // "saved ✓" and then thrown away when the task was never created.
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

// Switching the page to English left parts of it in Hebrew (owner,
// 2026-09-26), and the table checks above could not see it: the leaks were
// all OUTSIDE the tables — a tab title, a seed title with no English, a date
// formatted once at load. So this reads everything that is not a table and
// not a comment, and every Hebrew string literal left must be the `he` half
// of a `{he, en}` pair, where L() picks the reader's. The few Hebrew that is
// not interface text is named below, by its text, so a new one fails here
// with its line number instead of on somebody's English screen.
test('no Hebrew reaches the page outside the string tables, unless it has an English twin', () => {
  const heStart = PAGE.indexOf('\n    he:{ dir:');
  const enEnd = PAGE.indexOf('\n  };', PAGE.indexOf('\n    en:{ dir:'));
  assert.ok(heStart > 0 && enEnd > heStart, 'the tables have moved — this test is reading the wrong thing');
  // Blanked rather than cut, so a finding keeps its real line number.
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const rest = (PAGE.slice(0, heStart) + blank(PAGE.slice(heStart, enEnd)) + PAGE.slice(enEnd))
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);
  const HEB = /[֐-׿]/;
  // Not interface text, each for a stated reason.
  const ALLOWED = [
    // what shows in the tab for the instant before the script sets it from
    // the table ("page.title", paintStatic)
    '<title>עולמה שלי</title>',
    // these READ what the person types, in either language
    'if(/(^|\\s)(היום|today)(\\s|$)/.test(s)) push(0);',
    'if(/(^|\\s)(מחר|tomorrow)(\\s|$)/.test(s)) push(1);',
    'if(/(^|\\s)(מחרתיים|day after tomorrow)(\\s|$)/.test(s)) push(2);',
    'if(/(השבוע הבא|שבוע הבא|next week)/.test(s)){',
    'if(/(סוף השבוע|סופ״ש|weekend)/.test(s)){',
    // each language is named in its own script
    'var LANGS = [{v:"he", n:"עברית"}, {v:"en", n:"English"}];',
    // the design preview's language key on a Hebrew keyboard; off when served
    'if(e.key !== "l" && e.key !== "L" && e.key !== "ל") return;',
  ];
  const lines = rest.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (!HEB.test(line)) return;
    if (ALLOWED.includes(line.trim())) return;
    // A `he:"…"` value is fine when its object also says `en:` — on this line
    // or the next, which is as far as any seed object in the file wraps.
    const withNext = line + (lines[i + 1] || '');
    const stray = [...line.matchAll(/(he\s*:\s*)?"([^"\\\n]*)"/g)]
      .filter((m) => HEB.test(m[2]) && !(m[1] && /\ben\s*:/.test(withNext)));
    const bare = line.replace(/"[^"\\\n]*"/g, '""');
    if (stray.length || HEB.test(bare)) found.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  assert.deepEqual(found, [], 'Hebrew an English page would show — put it in the tables, or give it an en');
});
