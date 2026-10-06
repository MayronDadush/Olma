'use strict';
// The digest's card, composed in CODE (owner, 2026-10-06).
//
// Until now `get_my_digest` handed the model the list and an order to draw it,
// and the model chose the sections. ברית's first card (16 open tasks, all
// filed under work) came out as two sections both headed "עבודה" — a section
// holds at most 15 lines, so the model split one category in two and named
// both halves the same — and her task marked "(בעדיפות עליונה)" sat second
// from the bottom. Both are layout, and layout is the same every morning, so it
// is drawn here (rules, "What is the same every time is DRAWN") and the model
// passes `cardArgs` to render_schedule_card untouched.
//
// And past what one card can hold (LIMITS.totalItems), the morning is a
// SUMMARY of what is most urgent and most important, with how many more are
// open — never a wall of 60 lines of text (owner, same day; u-3 had 63).
const digestBlock = require('./digest-block');
const { LIMITS } = require('./schedule-card');

const DAY_MS = 24 * 60 * 60 * 1000;

// What a person writes INTO a title to say it comes first. Matched as
// substrings, so each entry is a phrase that cannot occur inside another word:
// bare "חשוב" is deliberately absent, because it is inside "לחשוב".
const URGENT_PHRASES = [
  'דחוף', 'בדחיפות', 'עדיפות עליונה', 'עדיפות גבוהה', 'הכי חשוב', 'חשוב מאוד', 'קריטי',
  'urgent', 'asap', 'high priority', 'top priority', 'important',
];
function markedUrgent(title) {
  const t = String(title || '').toLowerCase();
  return URGENT_PHRASES.some((p) => t.includes(p));
}

// A summary is short enough to take in at a glance, and never shorter than a
// morning worth opening.
const SUMMARY_MAX = 15;
const SUMMARY_MIN = 8;
const SOON_DAYS = 2;
const WEEK_DAYS = 7;

const SECTION_WORDS = {
  he: { urgent: 'דחוף', dated: 'עם תאריך', title: 'המשימות הפתוחות שלך', summaryTitle: 'החשובות והדחופות',
    more: (n) => `ועוד ${n} משימות פתוחות`, cont: (t) => `${t} (המשך)` },
  en: { urgent: 'Urgent', dated: 'With a date', title: 'Your open tasks', summaryTitle: 'Most urgent and important',
    more: (n) => `and ${n} more open tasks`, cont: (t) => `${t} (cont.)` },
};

const CATEGORY_ICONS = {
  home: 'home', work: 'work', family: 'family', health: 'health',
  money: 'money', errands: 'shopping', lists: 'shopping', other: 'task',
};

const topLevel = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && !r.parent_id);
const at = (r) => (r && r.due_at ? new Date(r.due_at).getTime() : null);

// Lower is more pressing. Overdue first, then what they marked urgent, then
// what is coming soonest; an undated task with no mark is last.
function tier(row, now) {
  const due = at(row);
  if (due !== null && due < now) return 0;
  if (markedUrgent(row.title)) return 1;
  if (due !== null && due - now <= SOON_DAYS * DAY_MS) return 2;
  if (due !== null && due - now <= WEEK_DAYS * DAY_MS) return 3;
  if (due !== null) return 4;
  return 5;
}

function byPressure(now) {
  return (a, b) => (tier(a, now) - tier(b, now))
    || ((at(a) ?? Infinity) - (at(b) ?? Infinity))
    || (Number(a.id) - Number(b.id));
}

// Over the card's ceiling: keep what is pressing (tiers 0-3, events inside a
// week), at most SUMMARY_MAX, and if that is thin, fill up to SUMMARY_MIN from
// the rest — dated before undated, and among the undated the NEWEST first,
// because what was said last is what is on their mind. Returns the reduced
// data plus how many open items were left out, so the morning can say so.
function summarize(data, { now = Date.now() } = {}) {
  const events = topLevel(data && data.events);
  const tasks = topLevel(data && data.tasks);
  const total = events.length + tasks.length;
  if (total <= LIMITS.totalItems) return { data, omitted: 0, summarized: false };

  const soonEvents = events
    .filter((e) => { const d = at(e); return d !== null && d - now <= WEEK_DAYS * DAY_MS; })
    .sort((a, b) => at(a) - at(b));
  const ranked = [...tasks].sort(byPressure(now));
  const pressing = ranked.filter((t) => tier(t, now) <= 3);
  const room = Math.max(0, SUMMARY_MAX - Math.min(soonEvents.length, SUMMARY_MAX));
  let picked = pressing.slice(0, room);
  if (soonEvents.length + picked.length < SUMMARY_MIN) {
    const rest = ranked.filter((t) => !picked.includes(t));
    const dated = rest.filter((t) => at(t) !== null);
    const undated = rest.filter((t) => at(t) === null).sort((a, b) => Number(b.id) - Number(a.id));
    const need = SUMMARY_MIN - soonEvents.length - picked.length;
    picked = [...picked, ...[...dated, ...undated].slice(0, need)];
  }
  const keptEvents = soonEvents.slice(0, SUMMARY_MAX);
  const kept = keptEvents.length + picked.length;
  return {
    data: { ...data, events: keptEvents, tasks: picked },
    omitted: total - kept,
    summarized: true,
  };
}

// The arguments for render_schedule_card. One section per kind of thing, in
// this order: the calendar, what is urgent, what has a date, then the undated
// by category — each category ONE heading, and a category longer than a
// section can hold continues under "(המשך)" rather than a second identical
// title.
function cardFor(data, { locale, timezone, now = Date.now(), omitted = 0, summarized = false } = {}) {
  const lk = digestBlock.localeKey(locale);
  const w = SECTION_WORDS[lk];
  const labels = digestBlock.CATEGORY_LABELS[lk];
  const ctx = digestBlock.contextFor({ locale, timezone, now });
  const item = (r, icon) => ({
    date: r.due_at ? digestBlock.whenLabel(r.due_at, ctx) || '' : '',
    text: String(r.title || '').replace(/\s+/g, ' ').trim(),
    icon,
  });

  const sections = [];
  const pushChunked = (title, items) => {
    for (let i = 0; i < items.length; i += LIMITS.itemsPerSection) {
      sections.push({ title: i ? w.cont(title) : title, items: items.slice(i, i + LIMITS.itemsPerSection) });
    }
  };

  const events = topLevel(data && data.events).sort((a, b) => (at(a) ?? Infinity) - (at(b) ?? Infinity));
  if (events.length) pushChunked(ctx.w.calendar, events.map((e) => item(e, 'calendar')));

  const tasks = topLevel(data && data.tasks).sort(byPressure(now));
  const urgent = tasks.filter((t) => tier(t, now) <= 1);
  const dated = tasks.filter((t) => tier(t, now) > 1 && at(t) !== null);
  const undated = tasks.filter((t) => tier(t, now) > 1 && at(t) === null);
  const iconOf = (t) => CATEGORY_ICONS[t.category] || 'task';
  if (urgent.length) pushChunked(w.urgent, urgent.map((t) => item(t, iconOf(t))));
  if (dated.length) pushChunked(w.dated, dated.map((t) => item(t, iconOf(t))));

  const cats = digestBlock.CATEGORY_ORDER
    .map((cat) => ({ cat, rows: undated.filter((t) => (t.category || 'other') === cat) }))
    .filter((g) => g.rows.length);
  // A list of a few lines under one heading is easier to read than a heading
  // per line; the block draws the same line (CATEGORY_GROUP_MIN).
  if (cats.length > 1 && undated.length > digestBlock.CATEGORY_GROUP_MIN) {
    for (const g of cats) pushChunked(labels[g.cat], g.rows.map((t) => item(t, iconOf(t))));
  } else if (undated.length) {
    pushChunked(cats.length === 1 ? labels[cats[0].cat] : ctx.w.todo, undated.map((t) => item(t, iconOf(t))));
  }

  // More headings than the card can draw: fold the smallest trailing ones into
  // one, rather than refuse a morning over a layout detail.
  while (sections.length > LIMITS.sections) {
    const last = sections.pop();
    const prev = sections[sections.length - 1];
    if (prev.items.length + last.items.length <= LIMITS.itemsPerSection) {
      sections[sections.length - 1] = { title: labels.other, items: [...prev.items, ...last.items] };
    } else {
      sections.push(last);
      break;
    }
  }

  return {
    title: summarized ? w.summaryTitle : w.title,
    sections,
    ...(omitted > 0 ? { footer_note: w.more(omitted) } : {}),
  };
}

module.exports = {
  cardFor, summarize, markedUrgent, tier,
  URGENT_PHRASES, SUMMARY_MAX, SUMMARY_MIN, SECTION_WORDS,
};
