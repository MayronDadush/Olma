'use strict';
// The morning picture, drawn by CODE.
//
// The digest is the one message a person reads every day, and until now every
// line of it was retyped by a model: the same six tasks came back as a
// paragraph one morning and a list the next, in whatever order the model felt
// like. What actually varies between two mornings is not the layout — it is
// the one sentence that says which of these matters first, and a model is the
// only thing that can write that.
//
// So the two halves part company (owner, 2026-09-09). This renders the part
// that is the same every time, deterministically: what is on their calendar,
// then what is on their plate, laid out once and identically for ever. The
// model receives it finished, sends it as it stands, and adds its one
// sentence. Same shape as `render_schedule_card`, which has drawn the long
// version as an image since long before this — what is new is that the short
// version is now made of characters, so it can be read in the chat.
//
// What being code buys, beyond the layout: the block costs nothing, cannot
// drop a task, and is checked by the suite rather than by an eval. What it
// costs is what every deterministic sentence here costs — no grammatical
// gender (so nothing below is a verb addressed to anybody), and one set of
// words per language rather than a model that speaks all of them.
const format = require('./message-format');
const dt = require('./datetime');

const DAY_MS = 24 * 60 * 60 * 1000;
// How far ahead a weekday name still means something. Past it, "יום שלישי" is
// ambiguous between this week and next, and a date is the honest answer.
const NAMED_DAY_HORIZON = 7;

const WORDS = {
  he: {
    calendar: 'ביומן',
    todo: 'על הרשימה',
    today: 'היום',
    tomorrow: 'מחר',
    day: (name) => `יום ${name}`,
    weekdays: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
    date: ({ d, m }) => `${d}.${m}`,
  },
  en: {
    calendar: 'On your calendar',
    todo: 'On your list',
    today: 'Today',
    tomorrow: 'Tomorrow',
    day: (name) => name,
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    date: ({ d, m }) => `${d}/${m}`,
  },
};

// The same two-way rule `proactive-text.localizedKey` applies to a reminder
// rung: `en` (any variant) gets English, everything else gets the Hebrew that
// almost everybody here reads. Read at render off the users row.
function wordsFor(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('en') ? WORDS.en : WORDS.he;
}

// Whole-day or timed. A task saved for a DAY lands on local midnight in their
// own zone — the same discriminator `domain/auto-reminder.js` uses to decide
// between "an hour before" and "08:00 that morning" — so the two must agree,
// and neither may ask UTC.
function isWholeDay(parts) {
  return parts.hh === 0 && parts.mi === 0;
}

function hhmm(parts) {
  return `${String(parts.hh).padStart(2, '0')}:${String(parts.mi).padStart(2, '0')}`;
}

// How many local days from today — not a subtraction of instants, which is
// wrong across a DST boundary and wrong again for anything inside 24 hours
// that has already crossed midnight.
function daysAway(parts, todayParts) {
  const a = Date.UTC(parts.y, parts.m - 1, parts.d);
  const b = Date.UTC(todayParts.y, todayParts.m - 1, todayParts.d);
  return Math.round((a - b) / DAY_MS);
}

// The moment, in the person's own terms, as short as it can honestly be:
// today says only the hour, tomorrow names itself, this week is a weekday, and
// anything further off is a date. Nothing here is a sentence, so nothing here
// has a gender.
function whenLabel(dueAt, { tz, w, todayParts }) {
  if (!dueAt) return '';
  const at = new Date(dueAt);
  if (Number.isNaN(at.getTime())) return '';
  const parts = dt.partsInZone(tz, at);
  const away = daysAway(parts, todayParts);
  const time = isWholeDay(parts) ? '' : hhmm(parts);

  let day = '';
  if (away === 0) day = time ? '' : w.today;
  else if (away === 1) day = w.tomorrow;
  else if (away > 1 && away <= NAMED_DAY_HORIZON) day = w.day(w.weekdays[dt.weekdayOfParts(parts)]);
  else day = w.date(parts);

  return [day, time].filter(Boolean).join(' ');
}

// A range only when the END is on the same day and later — a shift that runs
// past midnight would otherwise read as ending before it began.
function rangeLabel(row, ctx) {
  const start = whenLabel(row.due_at, ctx);
  if (!row.ends_at || !row.due_at) return start;
  const s = dt.partsInZone(ctx.tz, new Date(row.due_at));
  const e = dt.partsInZone(ctx.tz, new Date(row.ends_at));
  if (s.y !== e.y || s.m !== e.m || s.d !== e.d) return start;
  if (isWholeDay(s) || hhmm(e) <= hhmm(s)) return start;
  return `${start}-${hhmm(e)}`;
}

// One line. The title is the person's own words, so it goes through the same
// cleaning every verbatim path uses — nothing they typed becomes emphasis
// nobody chose (message-format.stripUserMarkup).
function line(row, ctx, withRange) {
  const title = format.stripUserMarkup(String(row.title || '').replace(/\s+/g, ' ').trim());
  if (!title) return null;
  const when = withRange ? rangeLabel(row, ctx) : whenLabel(row.due_at, ctx);
  const where = withRange && row.location
    ? format.stripUserMarkup(String(row.location).replace(/\s+/g, ' ').trim())
    : '';
  const head = [when, title].filter(Boolean).join(' — ');
  return where ? `${head}, ${where}` : head;
}

// `null` and an empty block are different answers and the caller must be able
// to tell them apart: nothing due at all is a real morning, and it is the
// model's to write from the counts rather than something to paper over with an
// empty heading (the same rule as everywhere else here — a thing that could
// not be read is never a thing in trouble).
//
// `now` is injectable so a test can pin the morning it is describing; every
// other caller passes nothing and gets the clock.
function renderDigestBlock(data, { locale, timezone, channelType, now } = {}) {
  const f = format.formatterFor(channelType);
  const w = wordsFor(locale);
  const tz = timezone || 'UTC';
  const ctx = { tz, w, todayParts: dt.partsInZone(tz, now ? new Date(now) : new Date()) };

  const events = (Array.isArray(data && data.events) ? data.events : [])
    .map((r) => line(r, ctx, true)).filter(Boolean);
  // A subtask reads as an orphan out of its parent's context ("להביא מטען"),
  // so the list stays at the top level, exactly as the card does.
  const tasks = (Array.isArray(data && data.tasks) ? data.tasks : [])
    .filter((r) => !r.parent_id)
    .map((r) => line(r, ctx, false)).filter(Boolean);

  if (!events.length && !tasks.length) return null;

  const sections = [];
  // The calendar first and never mixed in: a meeting read out as a task is
  // the fault `tasks.kind` exists to prevent, and a shared list would undo it.
  if (events.length) sections.push(`${f.bold(w.calendar)}\n${f.bullets(events)}`);
  if (tasks.length) sections.push(`${f.bold(w.todo)}\n${f.bullets(tasks)}`);
  return sections.join('\n\n');
}

module.exports = { renderDigestBlock, wordsFor, whenLabel, NAMED_DAY_HORIZON };
