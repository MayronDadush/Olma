'use strict';
// The morning list, drawn by code.
//
// What is worth asserting here is not that a list renders — it is everything
// the deterministic path has to get right that a model used to get right by
// accident: the person's own timezone, their own language, a meeting never
// filed as a task, and a title that carries an asterisk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDigestBlock } = require('../src/domain/digest-block');

const TZ = 'Asia/Jerusalem';
// Pinned, because a block that describes "today" cannot be tested against a
// clock that moves — the same rule the suite applies to every other moment.
const NOW = new Date('2026-09-09T06:00:00+03:00');
const at = (s) => new Date(s).toISOString();

const DAY = {
  events: [
    { title: 'פגישה עם דנה', due_at: at('2026-09-09T10:00:00+03:00'), location: 'קפה ליד המשרד' },
    { title: 'משלוח מהמחסן', due_at: at('2026-09-09T14:00:00+03:00'), ends_at: at('2026-09-09T16:00:00+03:00') },
    { title: 'הורים־מורים', due_at: at('2026-09-10T18:30:00+03:00') },
  ],
  tasks: [
    { title: 'לשלם ארנונה', due_at: at('2026-09-09T00:00:00+03:00') },
    { title: 'להחזיר את הטופס לגן', due_at: at('2026-09-10T00:00:00+03:00') },
    { title: 'לתקן את הדוד', due_at: null },
  ],
};
const render = (data, opts) => renderDigestBlock(data, {
  locale: 'he', timezone: TZ, channelType: 'whatsapp', now: NOW, ...opts,
});

test('the calendar and the list are two sections, never one', () => {
  const out = render(DAY);
  // A meeting read out as a task is the fault tasks.kind exists to prevent,
  // and one merged list would undo it silently.
  assert.match(out, /^\*ביומן\*$/m);
  assert.match(out, /^\*על הרשימה\*$/m);
  assert.ok(out.indexOf('ביומן') < out.indexOf('על הרשימה'), 'the calendar comes first');
  assert.ok(out.indexOf('פגישה עם דנה') < out.indexOf('לשלם ארנונה'));
  // Every line is a real WhatsApp list line, and nothing is left as prose.
  const lines = out.split('\n').filter((l) => l.trim() && !l.startsWith('*'));
  for (const l of lines) assert.match(l, /^- /, l);
  assert.equal(lines.length, 6);
});

test('a moment is said in the shortest honest form, in THEIR zone', () => {
  const out = render(DAY);
  assert.match(out, /^- 10:00 — פגישה עם דנה, קפה ליד המשרד$/m, 'today says only the hour');
  assert.match(out, /^- 14:00-16:00 — משלוח מהמחסן$/m, 'an end time on the same day is a range');
  assert.match(out, /^- מחר 18:30 — הורים־מורים$/m);
  assert.match(out, /^- היום — לשלם ארנונה$/m, 'a whole-day task says the day, not 00:00');
  assert.match(out, /^- מחר — להחזיר את הטופס לגן$/m);
  assert.match(out, /^- לתקן את הדוד$/m, 'no date, no prefix');

  // The zone is the PERSON'S. The same instant is a different day in Sydney,
  // and a digest that says "today" about tomorrow is worse than no digest.
  const sydney = render(DAY, { timezone: 'Australia/Sydney' });
  assert.match(sydney, /^- 17:00 — פגישה עם דנה/m, sydney);
  // And the day itself flips: 18:30 on Thursday in Jerusalem is 01:30 on
  // FRIDAY in Sydney, which is the whole reason this is not a subtraction of
  // instants — "מחר" there would be a lie by one day.
  assert.match(sydney, /^- יום שישי 01:30 — הורים־מורים$/m, sydney);
});

test('a weekday is named only while it still means one day', () => {
  const soon = render({ events: [], tasks: [{ title: 'א', due_at: at('2026-09-15T00:00:00+03:00') }] });
  assert.match(soon, /^- יום שלישי — א$/m, 'inside a week, the weekday');
  const far = render({ events: [], tasks: [{ title: 'ב', due_at: at('2026-10-20T00:00:00+03:00') }] });
  assert.match(far, /^- 20\.10 — ב$/m, 'past a week a weekday is ambiguous, so it is a date');
});

test('the language and the styling are read off the person, not assumed', () => {
  const en = render(DAY, { locale: 'en' });
  assert.match(en, /^\*On your calendar\*$/m);
  assert.match(en, /^- Tomorrow 18:30 — הורים־מורים$/m, 'their own words stay their own words');
  assert.doesNotMatch(en.split('\n').filter((l) => l.startsWith('*')).join(' '), /[֐-׿]/);
  // A channel with no styling gets the same block, readable, with no markers.
  const plain = render(DAY, { channelType: 'sms' });
  assert.doesNotMatch(plain, /\*/);
  assert.match(plain, /^• היום — לשלם ארנונה$/m);
});

test('a title the person wrote is cleaned, and a subtask stays out', () => {
  const out = render({
    events: [],
    tasks: [
      { title: 'לסגור עם *רואה החשבון*', due_at: null },
      { title: 'להביא מטען', due_at: null, parent_id: 7 },
      { title: '   ', due_at: null },
    ],
  });
  assert.match(out, /^- לסגור עם רואה החשבון$/m, 'their asterisks are not emphasis anybody chose');
  assert.doesNotMatch(out, /מטען/, 'a subtask reads as an orphan out of its parent');
  assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 1, 'a blank title is not a line');
});

test('nothing to show is null, which is a different answer from an empty block', () => {
  // "could not read" and "read, found nothing" must never collapse: a morning
  // with nothing due is a real morning and the sentence about it is the
  // model's, not an empty heading.
  assert.equal(render({ events: [], tasks: [] }), null);
  assert.equal(render({}), null);
  assert.equal(render({ tasks: [{ title: '  ' }] }), null);
});

// Miron's real morning: a handful of dated items followed by dozens of
// undated chores, one flat wall of bullets. `tasks.category` is already
// computed for every task at write time — grouping the undated tail by it
// is the same declutter the schedule card does, without a model or a tool
// call, and without ever touching the dated items' own priority order.
test('a short undated tail stays one flat list — grouping four chores adds a label and nothing else', () => {
  const out = render({
    events: [],
    tasks: [
      { title: 'לנקות את הבית', due_at: null, category: 'home' },
      { title: 'לשלם את הארנונה', due_at: null, category: 'money' },
      { title: 'לקנות חלב', due_at: null, category: 'errands' },
    ],
  });
  assert.doesNotMatch(out, /\*בית\*/, 'below the floor there is no category heading at all');
  assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 3);
});

test('a long undated tail is grouped by category, dated items stay out front', () => {
  const out = render({
    events: [],
    tasks: [
      { title: 'לדבר עם הבנק', due_at: at('2026-09-09T09:00:00+03:00'), category: 'money' },
      { title: 'לנקות את הבית', due_at: null, category: 'home' },
      { title: 'לסדר את המטבח', due_at: null, category: 'home' },
      { title: 'לכבס בגדים', due_at: null, category: 'home' },
      { title: 'לסיים מצגת ללקוח', due_at: null, category: 'work' },
      { title: 'לתאם ראיון עבודה', due_at: null, category: 'work' },
      { title: 'ללכת לרופא שיניים', due_at: null, category: 'health' },
      { title: 'להזמין תור לבדיקת דם', due_at: null, category: 'health' },
      { title: 'לשלם את הארנונה', due_at: null, category: 'money' },
      { title: 'לחשוב על זה', due_at: null, category: null },
      { title: 'לבדוק משהו', due_at: null, category: null },
    ],
  });
  // The dated item leads, exactly as the flat list always put it first.
  assert.ok(out.indexOf('לדבר עם הבנק') < out.indexOf('*בית*'), 'a real moment still outranks a category');
  // One bold heading per category that actually has something in it, in a
  // fixed order, uncategorised last under the catch-all.
  const boldLines = out.split('\n').filter((l) => l.startsWith('*') && l.endsWith('*'));
  assert.deepEqual(boldLines, ['*על הרשימה*', '*בית*', '*עבודה*', '*בריאות*', '*כסף*', '*שונות*']);
  assert.ok(out.indexOf('*בית*') < out.indexOf('*עבודה*'));
  assert.ok(out.indexOf('*כסף*') < out.indexOf('*שונות*'));
  // Every task is still in there — grouping relabels, it never drops.
  for (const t of ['לנקות את הבית', 'לסדר את המטבח', 'לכבס בגדים', 'לסיים מצגת ללקוח',
    'לתאם ראיון עבודה', 'ללכת לרופא שיניים', 'להזמין תור לבדיקת דם', 'לשלם את הארנונה',
    'לחשוב על זה', 'לבדוק משהו']) {
    assert.ok(out.includes(t), `missing: ${t}`);
  }
  // The money group holds BOTH money items — the dated one is not duplicated
  // into it, and the undated one is not lost from it.
  const moneyBlock = out.slice(out.indexOf('*כסף*'), out.indexOf('*שונות*'));
  assert.match(moneyBlock, /לשלם את הארנונה/);
  assert.doesNotMatch(moneyBlock, /לדבר עם הבנק/, 'the dated task stays with the dated items, not the category');
});

test('grouping is still off when every undated item lands in the same category', () => {
  const many = Array.from({ length: 10 }, (_, i) => (
    { title: `לנקות ${i}`, due_at: null, category: 'home' }
  ));
  const out = render({ events: [], tasks: many });
  // Ten items, one category: a "*בית*" heading over everything says nothing
  // "על הרשימה" did not already say.
  assert.doesNotMatch(out, /\*בית\*/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('- ')).length, 10);
});

test('category labels are read off the locale, same as every other word here', () => {
  const undated = ['home', 'home', 'home', 'work', 'work', 'work', 'health', 'health', 'health'];
  const tasks = undated.map((category, i) => ({ title: `task ${i}`, due_at: null, category }));
  const en = render({ events: [], tasks }, { locale: 'en' });
  assert.match(en, /^\*Home\*$/m);
  assert.match(en, /^\*Work\*$/m);
  assert.match(en, /^\*Health\*$/m);
});
