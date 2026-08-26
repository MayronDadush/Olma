'use strict';
// One vocabulary for "a datetime that carries its own UTC offset", shared by
// every place that accepts a time from the model.
//
// Calendar events already refused a bare local time rather than guessing at
// it — an event three hours off is worse than no event. Meetings then grew
// the same need for the same reason, and a second copy of this rule living in
// meetings.js is exactly how the two drift apart. Same lesson as
// reminders.normalizeRepeatRule: one vocabulary, one file.
const { err } = require('./results');

// …Z or ±HH:MM. A bare "2026-08-21T20:00" is refused, never interpreted
// against whatever timezone the reader happens to assume.
const OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// A real Date is already an unambiguous instant — nothing to refuse. The
// refusal is only for STRINGS, which is the only shape the model (or any
// caller crossing the tool boundary) can hand in; internal callers computing
// their own next occurrence (e.g. domain/pause.js re-arming a reminder) pass
// a Date, never a naive string, and must not be forced through ISO-and-back.
function hasOffset(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  return typeof value === 'string' && OFFSET_RE.test(value.trim());
}

function badTime(label, value) {
  return err('invalid',
    `${label} must be a full ISO-8601 datetime WITH a UTC offset, e.g. 2026-08-20T09:00:00+03:00 (got ${String(value).slice(0, 40)})`,
    { reason: 'missing_offset' });
}

// ---- weekday cross-check ----------------------------------------------------
//
// A slot carries two halves: the words a person reads ("יום שני 20:00") and
// the moment everything else in the system acts on. Validating the FORMAT of
// the second says nothing about whether the two agree, so a well-formed date
// one day off sails straight through — meeting #4 ("פוקר") stored "יום שני"
// as a Tuesday and "יום שלישי" as a Wednesday while both men spent the
// afternoon talking about Monday and Tuesday.
//
// When the text names a weekday there is something to check, so it is checked
// and a disagreement is REFUSED — the same refuse-don't-guess rule the offset
// itself follows. Neither half is known to be the right one: silently trusting
// the timestamp stores a day nobody said, and silently trusting the text
// invents a date. Text that names no weekday is left exactly as it was.

// One Hebrew letter, used for the boundaries \b cannot express (\w is ASCII,
// so \b sits in the middle of Hebrew words rather than at their edges).
const HE_LETTER = '[\\u0590-\\u05FF]';
// Single-letter prefixes that glue onto a day word: בשני, ושבת, השני. Kept to
// ב/ה/ו deliberately — ל would make "לשבת בקפה" ("to sit at the cafe") read as
// Saturday, and a false refusal costs a real proposal, while a missed check
// only leaves things exactly as they were before this rule existed.
const HE_PREFIX = '[\\u05D1\\u05D4\\u05D5]';

const WEEKDAYS = [
  { index: 0, en: 'Sunday',    he: ['ראשון'], letter: 'א', abbr: ['sunday', 'sun'] },
  { index: 1, en: 'Monday',    he: ['שני'],   letter: 'ב', abbr: ['monday', 'mon'] },
  { index: 2, en: 'Tuesday',   he: ['שלישי'], letter: 'ג', abbr: ['tuesday', 'tues', 'tue'] },
  { index: 3, en: 'Wednesday', he: ['רביעי'], letter: 'ד', abbr: ['wednesday', 'weds', 'wed'] },
  { index: 4, en: 'Thursday',  he: ['חמישי'], letter: 'ה', abbr: ['thursday', 'thurs', 'thur', 'thu'] },
  { index: 5, en: 'Friday',    he: ['שישי', 'ששי'], letter: 'ו', abbr: ['friday', 'fri'] },
  { index: 6, en: 'Saturday',  he: ['שבת'],   letter: 'ש', abbr: ['saturday', 'sat'] },
];

// Hebrew day word, optionally prefixed (בשני), never mid-word: the trailing
// lookahead is what keeps שנייה / שניים / ראשונה / שישית out.
const HE_WORD_RES = WEEKDAYS.map((d) => ({
  index: d.index,
  re: new RegExp(`(?:^|[^\\u0590-\\u05FF])${HE_PREFIX}?(?:${d.he.join('|')})(?!${HE_LETTER})`, 'u'),
}));
// "יום א׳" / "יום ב'" — only ever after יום, so a lone letter is never a day.
const HE_LETTER_RES = WEEKDAYS.map((d) => ({
  index: d.index,
  re: new RegExp(`(?:^|[^\\u0590-\\u05FF])${HE_PREFIX}?יום\\s+${d.letter}['\\u05F3\\u2019]?(?!${HE_LETTER})`, 'u'),
}));
const EN_RES = WEEKDAYS.map((d) => ({
  index: d.index,
  re: new RegExp(`\\b(?:${d.abbr.join('|')})\\b`, 'i'),
}));

// Every weekday the text names, as sorted 0-6 indices. Empty = nothing to
// check. More than one ("Monday or Tuesday") is not itself an error here —
// only a timestamp landing on NONE of them is.
function weekdaysInText(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const found = new Set();
  for (const { index, re } of HE_WORD_RES) if (re.test(text)) found.add(index);
  for (const { index, re } of HE_LETTER_RES) if (re.test(text)) found.add(index);
  for (const { index, re } of EN_RES) if (re.test(text)) found.add(index);
  return [...found].sort((a, b) => a - b);
}

function offsetMinutes(value) {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  if (m[1] === 'Z') return 0;
  const [h, mm] = m[1].slice(1).split(':').map(Number);
  return (m[1][0] === '-' ? -1 : 1) * (h * 60 + mm);
}

// Which day of the week the moment falls on FOR THIS PERSON. Their timezone is
// the right frame: they read "יום שני" in their own local terms, not in
// whatever offset the model happened to write. An unknown or unusable
// timezone falls back to the offset carried by the string itself, which is the
// model's own claim about the local wall clock — never silently to UTC, which
// is how a NULL timezone became three hours of drift elsewhere.
function weekdayInZone(value, tz) {
  const t = new Date(String(value).trim()).getTime();
  if (Number.isNaN(t)) return null;
  if (tz) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' })
        .format(new Date(t));
      const hit = WEEKDAYS.find((d) => d.en === name);
      if (hit) return hit.index;
    } catch { /* unknown timezone — fall through to the string's own offset */ }
  }
  const off = offsetMinutes(value);
  if (off === null) return null;
  return new Date(t + off * 60_000).getUTCDay();
}

function dayName(index) {
  const d = WEEKDAYS.find((x) => x.index === index);
  return d ? `${d.en} (${d.he[0]})` : String(index);
}

// null = consistent, or nothing to check. Otherwise an err() to return as-is.
function weekdayClash(label, text, startsAt, tz) {
  const named = weekdaysInText(text);
  if (named.length === 0) return null;
  const actual = weekdayInZone(startsAt, tz);
  if (actual === null) return null;
  if (named.includes(actual)) return null;
  return err('invalid',
    `${label} names ${named.map(dayName).join(' / ')} but the time you gave (${String(startsAt).slice(0, 40)}) `
    + `falls on ${dayName(actual)} in ${tz ? `the user's timezone (${tz})` : 'the offset you gave'}. `
    + 'Do not pick one and go: ask which day they mean, then send the words and the time agreeing.',
    { reason: 'weekday_mismatch', namedWeekdays: named, actualWeekday: actual });
}

module.exports = {
  OFFSET_RE, hasOffset, badTime,
  weekdaysInText, weekdayInZone, weekdayClash,
};
