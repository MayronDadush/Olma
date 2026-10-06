'use strict';
// The digest card's layout is code's (domain/digest-card.js). The founding
// case is ברית's first card, 2026-10-06: sixteen open tasks all filed under
// work came out as two sections both headed "עבודה", and the one she marked
// "(בעדיפות עליונה)" was second from the bottom.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const digestCard = require('../src/domain/digest-card');
const { LIMITS, renderPng } = require('../src/domain/schedule-card');

const NOW = Date.parse('2026-10-06T06:00:00Z');
const opts = { locale: 'he', timezone: 'Asia/Jerusalem', now: NOW };
const task = (id, title, extra = {}) => ({ id, title, category: 'work', due_at: null, parent_id: null, ...extra });

function britsList() {
  const titles = [
    'לעדכן מצגת הפקת לקחים', 'לבדוק הזמנת עבודה קולטק', 'לבקש מנעם ובריאן הצעת תקציב',
    'לסיים תקציב ובקרה', 'לוודא קול קורא משרד התיירות', 'לוודא עד מתי קול קורא טניס',
    'להכין הסכם לטימור', 'לעדכן אצבע טימור ובריאן', 'לשלוח עדכון בשגרירי חוסן',
    'לסיים הגשה מצוינות', 'לדבר עם דניאלה', 'לוודא תשלום שחקני כדורגל',
    'מלגות סטודנטים - לבדוק', 'לתאם מפגש מנהלי ליגת נירים',
    'לשלוח קובץ סיכומון מצוינות (בעדיפות עליונה)', 'להשיב מייל לרון',
  ];
  return titles.map((t, i) => task(i + 1, t));
}

test('ברית: no heading twice, and what she marked as top priority comes first', () => {
  const card = digestCard.cardFor({ events: [], tasks: britsList() }, opts);
  const titles = card.sections.map((s) => s.title);
  assert.equal(new Set(titles).size, titles.length, `duplicate headings: ${titles.join(' | ')}`);
  assert.equal(card.sections[0].title, 'דחוף');
  assert.match(card.sections[0].items[0].text, /בעדיפות עליונה/);
  assert.equal(card.sections.reduce((n, s) => n + s.items.length, 0), 16, 'nothing dropped');
  assert.equal(renderPng(card).ok, true);
});

test('a category longer than a section continues under "(המשך)", never the same title twice', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => task(i + 1, `משימה ${i + 1}`));
  const card = digestCard.cardFor({ events: [], tasks }, opts);
  assert.deepEqual(card.sections.map((s) => s.title), ['עבודה', 'עבודה (המשך)']);
  assert.equal(renderPng(card).ok, true);
});

test('the calendar comes first, then urgent, then dated, then the undated by category', () => {
  const card = digestCard.cardFor({
    events: [{ id: 50, title: 'רופא', due_at: '2026-10-07T08:00:00Z', parent_id: null }],
    tasks: [
      task(1, 'לקנות חלב', { category: 'home' }),
      task(2, 'לשלם ארנונה', { category: 'money', due_at: '2026-10-09T09:00:00Z' }),
      task(3, 'לחדש דרכון', { category: 'other', due_at: '2026-10-01T09:00:00Z' }), // overdue
    ],
  }, opts);
  assert.deepEqual(card.sections.map((s) => s.title), ['ביומן', 'דחוף', 'עם תאריך', 'בית']);
});

test('"חשוב" inside "לחשוב" is not a priority mark', () => {
  assert.equal(digestCard.markedUrgent('לחשוב על מתנה'), false);
  assert.equal(digestCard.markedUrgent('דחוף - להתקשר לבנק'), true);
  assert.equal(digestCard.markedUrgent('Send the deck ASAP'), true);
});

test('up to the ceiling nothing is summarized', () => {
  const tasks = Array.from({ length: LIMITS.totalItems }, (_, i) => task(i + 1, `משימה ${i + 1}`));
  const s = digestCard.summarize({ events: [], tasks }, { now: NOW });
  assert.equal(s.summarized, false);
  assert.equal(s.omitted, 0);
});

test('past the ceiling: the overdue and the marked come first, and the rest is a count', () => {
  const tasks = Array.from({ length: 60 }, (_, i) => task(i + 1, `משימה ${i + 1}`));
  tasks.push(task(61, 'לחדש ביטוח', { due_at: '2026-10-02T09:00:00Z' }));
  tasks.push(task(62, 'דחוף: להחזיר טופס'));
  tasks.push(task(63, 'פגישה עם רואה חשבון', { due_at: '2026-10-07T09:00:00Z' }));
  const s = digestCard.summarize({ events: [], tasks }, { now: NOW });
  assert.equal(s.summarized, true);
  const ids = s.data.tasks.map((t) => t.id);
  assert.ok(ids.includes(61) && ids.includes(62) && ids.includes(63));
  assert.ok(ids.length >= digestCard.SUMMARY_MIN && ids.length <= digestCard.SUMMARY_MAX);
  assert.equal(s.omitted, 63 - ids.length);
  // with only three pressing items, it fills from the NEWEST undated
  assert.ok(ids.includes(60) && !ids.includes(1));
  const card = digestCard.cardFor(s.data, { ...opts, omitted: s.omitted, summarized: true });
  assert.equal(card.title, 'החשובות והדחופות');
  assert.equal(card.footer_note, `ועוד ${s.omitted} משימות פתוחות`);
  assert.equal(card.sections[0].title, 'דחוף');
  assert.equal(renderPng(card).ok, true);
});

test('a summary never runs longer than SUMMARY_MAX, however much is pressing', () => {
  const tasks = Array.from({ length: 50 }, (_, i) => task(i + 1, `דחוף ${i + 1}`));
  const s = digestCard.summarize({ events: [], tasks }, { now: NOW });
  assert.equal(s.data.tasks.length, digestCard.SUMMARY_MAX);
  assert.equal(s.omitted, 50 - digestCard.SUMMARY_MAX);
});
