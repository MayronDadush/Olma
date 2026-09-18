'use strict';
// Every threshold in domain/task-similarity.js was read off these rows: 86
// real pairs from the box on 2026-09-18, scored by word overlap and then
// labelled one at a time by the owner. The six he marked "a list inside one
// task" are NOT here — that is not a pairwise judgement and the module makes
// no claim about it (incidents.md, "התיק לבית חולים"); the other eighty are,
// including all twenty-four he rejected, because a scorer is only as good as
// the things it refuses and those are the rows that killed three earlier
// versions of it.
//
//   '3' merge silently · '2' merge and say so · '1' save it and ask · '0' leave it
//
// The module answers merge / leave, so '1' and '0' both mean "do not merge on
// your own". The three '1' rows it merges anyway are named below and are the
// known cost of not building a band for three pairs out of eighty-six.
const { test } = require('node:test');
const assert = require('node:assert');
const sim = require('../src/domain/task-similarity');

const CORPUS = [
  ['להתקשר לוילה בראון לקבוע מסאז׳', 'להתקשר לוילה בראון לקבוע מסאז\'', '3'],
  ['לבדוק שסיימנו את כל הסיבוס', 'לבדוק שסיימנו את כל הסיבוס', '3'],
  ['ללכת לשתות מים', 'ללכת לשתות מים', '3'],
  ['להוריד את כל השירים', 'להוריד את כל השירים', '3'],
  ['לנשק את מאיה', 'לנשק את מאיה', '3'],
  ['לנשק את מאיה', 'לנשק את מאיה', '3'],
  ['לסחוב לברכה ליום הולדת', 'לסחוב לברכה ליום הולדת', '3'],
  ['לנשק את מאיה', 'לנשק את מאיה', '3'],
  ['לבדוק אם אפשר לקחת תזכורות קוליות גם לאולמה', 'לבדוק אם אפשר לקחת תזכורות קוליות גם לאולמה', '3'],
  ['כל משימה עם שעה תתווסף אוטומטית ליומן', 'כל משימה עם שעה תתווסף אוטומטית ליומן', '3'],
  ['להוסיף סרטוני הסבר באולמה', 'להוסיף סרטוני הסבר באולמה', '3'],
  ['לשתות מים', 'לשתות מים', '3'],
  ['לאכול צהריים', 'לאכול צהריים ב12', '3'],
  ['לבדוק משהו במחשב', 'לבדוק משהו במחשב', '3'],
  ['לדבר עם תום על רכש ציוד', 'לדבר עם תום על רכש ציוד', '3'],
  ['קריינות לפרק דפאונדר', 'קריינות לפרק דפאונדר', '3'],
  ['לדבר עם אסתי על הלוקשין של הצילומים', 'לדבר עם אסתי על הלוקשין של הצילומים', '3'],
  ['לוודא שהכל סגור לצילומים', 'לוודא שהכל סגור לצילומים', '3'],
  ['להזכיר לאבא (חיים) לטפל ברכב', 'להזכיר לאבא (חיים) לטפל ברכב', '3'],
  ['להעיר את מאיה', 'להעיר את מאיה', '3'],
  ['לעבוד על הנהלת חשבונות', 'להזכיר למאיה לעבוד על הנהלת חשבונות', '3'],
  ['להתקשר לחיים לגבי השכרת רכב', 'להתקשר לחיים לגבי השכרת רכב', '3'],
  ['להתקשר לסבא', 'להתקשר לסבא', '3'],
  ['בדיקות דם', 'בדיקות דם', '3'],
  ['להתקשר למכבי פיזיותרפיה', 'להתקשר למכבי פיזיותרפיה', '3'],
  ['לסדר את הבית', 'לסדר את הבית', '2'],
  ['לסמס למאור בעניין סכום מחלה', 'לסמס למאור בעניין סכום מחלה', '3'],
  ['לבדוק איפה הצילומים והאם הדליבר בסדר שנצלם שם', 'לבדוק איפה הצילומים והאם הדליבר הזה בסדר שנצלם שם', '3'],
  ['ללכת לעשות קניות', 'ללכת לעשות קניות', '3'],
  ['ביטוח נסיעות', 'ביטוח נסיעות', '2'],
  ['לבקש מכולם פעילויות למצגת ושמעיין תבקש החזרים מהקופה', 'לבקש מכולם פעילויות למצגת ושמעיין תבקש החזרים מהקופה', '3'],
  ['לדבר עם אבי לגבי אילת', 'לדבר עם אבי לגבי אילת', '3'],
  ['למצוא פתרונות טבעיים לאמא לתרופות שלה', 'למצוא פתרונות טבעיים לאמא לתרופות', '3'],
  ['לעשות צ׳ק אין לטיסה', 'לעשות צ׳ק אין לטיסה (עם מאיה)', '3'],
  ['לארוז תיק לבית חולים', 'להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה לתיק לבית חולים', '3'],
  ['לדבר עם מור חן — לבקש חומרי גלם', 'לדבר עם מור חן ולבקש חומרי גלם', '3'],
  ['להוריד את כל השירים', 'להוריד את כל השירים שלי', '3'],
  ['להוריד את כל השירים שלי', 'להוריד את כל השירים', '3'],
  ['לבדוק משימות למרוץ', 'לבדוק משימות נוספות שיש לי', '0'],
  ['ללכת לשתות מים', 'לשתות מים', '3'],
  ['ללכת לשתות מים', 'לשתות מים', '3'],
  ['ללכת לשתות מים', 'לשתות מים', '3'],
  ['לעשות ביטוח נסיעות לשנינו', 'לעשות ביטוח נסיעות (עם מאיה)', '2'],
  ['לעשות צ׳ק אין לטיסה (עם מאיה)', 'לעשות ביטוח נסיעות (עם מאיה)', '0'],
  ['לשלוח את הפרומפט על OpenClaw + MCP', 'לשלוח את הפרומפט על OpenClaw בתור צינור + MCP בתור מוח', '2'],
  ['לדבר עם מור חן — לבקש חומרי גלם', 'להזכיר למור חן להעביר חומרי גלם', '3'],
  ['לדבר עם מור חן ולבקש חומרי גלם', 'להזכיר למור חן להעביר חומרי גלם', '3'],
  ['משמרת עבודה - יום שלישי 07:00-16:00', 'משמרת - שלישי 07:00-16:00', '0'],
  ['משחק פאדל עם יובל', 'משחק פאדל עם יובל מחר בשעה 18:00', '3'],
  ['לקחת כדור ריבון', 'לקחת כדור ריבה', '2'],
  ['מיכל מכיוונים — טופס', 'טופס טסט', '0'],
  ['טופס טסט', 'טופס פנסיה משיכה', '0'],
  ['ללכת לשתות מים', 'לשתות מים', '3'],
  ['שיחת טלפון עם רופא', 'שיחת טלפון', '1'],
  ['ללכת לשתות מים', 'ללכת לעשות קניות', '0'],
  ['מיכל מכיוונים — טופס', 'טופס פנסיה משיכה', '0'],
  ['טופס טסט', 'לעלות טופס של מתקן באשקלון', '0'],
  ['למצוא לסבתא אוזניות טובות יותר (מכשיר שמיעה)', 'למצוא לסבתא אוזניות שמתאימות למכשיר שמיעה', '2'],
  ['מיכל מכיוונים — טופס', 'לעלות טופס של מתקן באשקלון', '0'],
  ['טופס מעמית על הפנסיה והקרן השתלמות', 'טופס טסט', '0'],
  ['לעלות טופס של מתקן באשקלון', 'טופס פנסיה משיכה', '0'],
  ['לדבר עם גידיס', 'לדבר עם אביטל מהפועל באר שבע', '0'],
  ['לבדוק על שחיינים ששחו בעבר', 'לבדוק משימות למרוץ', '0'],
  ['משמרת עבודה - יום ראשון 16:00-22:00', 'משמרת עבודה - יום שלישי 07:00-16:00', '0'],
  ['משמרת עבודה - יום ראשון 16:00-22:00', 'משמרת עבודה - יום רביעי 15:00-22:00', '0'],
  ['משמרת עבודה - יום ראשון 16:00-22:00', 'משמרת עבודה - יום חמישי 08:00-16:00', '0'],
  ['משמרת עבודה - יום שלישי 07:00-16:00', 'משמרת עבודה - יום חמישי 08:00-16:00', '0'],
  ['משותף עם מאיה', 'לשנות את התאריך של הספר (משותף עם מאיה)', '0'],
  ['להשים למאיה במקום את המטען', 'להשאיר למאיה את המטען', '3'],
  ['מיכל מכיוונים — טופס', 'טופס מעמית על הפנסיה והקרן השתלמות', '0'],
  ['לבדוק על שחיינים ששחו בעבר', 'לבדוק משימות נוספות שיש לי', '0'],
  ['לשאול את חיים איפה עושים פסח', 'לתכנן את פסח — להחליט מה עושים ואיפה', '2'],
  ['טופס מעמית על הפנסיה והקרן השתלמות', 'לעלות טופס של מתקן באשקלון', '0'],
  ['שיחת טלפון עם מיכל והורה', 'שיחת טלפון', '1'],
  ['לסחוב לברכה ליום הולדת', 'לכתוב ברכה ליום הולדת', '2'],
  ['לסחוב לברכה ליום הולדת', 'לכתוב ברכה ליום הולדת', '2'],
  ['לקחת כדור מלוטטטריסט לפני האוכל בבוקר', 'לקחת כדור ריבון', '0'],
  ['לקחת כדור מלוטטטריסט לפני האוכל בבוקר', 'לקחת כדור ריבה', '0'],
  ['משמרת עבודה - יום רביעי 15:00-22:00', 'משמרת - שני 15:00-22:00', '0'],
  ['לבטל דמי מנוי באשראי', 'לבטל את האשראי', '1'],];

// Word overlap cannot see a rewording, and pushing the threshold down far
// enough to reach these starts merging the rows below. Named so that a change
// which fixes one of them is a change somebody made on purpose.
const KNOWN_MISSES = [
  'להשים למאיה במקום את המטען',
  'לשאול את חיים איפה עושים פסח',
  'לסחוב לברכה ליום הולדת',
  'למצוא לסבתא אוזניות טובות יותר (מכשיר שמיעה)',
  // Three more that `disagrees` costs, and the price of never merging two
  // different medicines into one row.
  'לעשות ביטוח נסיעות לשנינו',
  'להזכיר למור חן להעביר חומרי גלם',
];
// One title is a short generic phrase the other extends. Three pairs, and a
// rule for them cost six wrong questions to buy these three — "לשתות מים"
// against "ללכת לשתות מים" is the identical shape and he merged it — so they
// are merged with a sentence rather than asked about.
const KNOWN_OVER_MERGES = ['שיחת טלפון', 'לבטל את האשראי'];

test('it never merges a pair the owner said to leave alone', () => {
  for (const [a, b, label] of CORPUS) {
    if (label !== '0') continue;
    const v = sim.compare(a, b);
    assert.equal(v.same, false, `would have merged "${a}" with "${b}"`);
  }
});

test('it agrees with the owner on the corpus, and the disagreements are the named ones', () => {
  let agreed = 0;
  const over = [];
  const under = [];
  for (const [a, b, label] of CORPUS) {
    const want = label === '3' || label === '2';
    const v = sim.compare(a, b);
    if (v.same === want) agreed += 1;
    else if (v.same) over.push([a, b]);
    else under.push([a, b]);
  }
  assert.ok(agreed >= 69, `agreement fell to ${agreed} of ${CORPUS.length}`);
  assert.ok(over.every(([a, b]) => KNOWN_OVER_MERGES.includes(a) || KNOWN_OVER_MERGES.includes(b)),
    `a new wrong merge: ${JSON.stringify(over)}`);
  assert.ok(under.every(([a, b]) => KNOWN_MISSES.includes(a) || KNOWN_MISSES.includes(b)),
    `a new miss: ${JSON.stringify(under)}`);
});

test('two entries off one recurring template are never the same thing', () => {
  // 0.56 of the words shared, and the shared part is the part that does not
  // matter. Six such pairs on the box, every one rejected.
  const v = sim.compare('משמרת עבודה - יום ראשון 16:00-22:00', 'משמרת עבודה - יום שלישי 07:00-16:00');
  assert.equal(v.reason, 'recurring_slot');
  assert.equal(v.same, false);
  // Same shift, same hours, written down a fortnight apart — still two shifts.
  assert.equal(sim.compare('משמרת עבודה - יום שלישי 07:00-16:00', 'משמרת - שלישי 07:00-16:00').same, false);
  // But ONE of them naming an hour is ordinary, and he merged it.
  const game = sim.compare('משחק פאדל עם יובל', 'משחק פאדל עם יובל מחר בשעה 18:00');
  assert.equal(game.same, true);
});

test('a shared due moment is not evidence, because it is no longer read at all', () => {
  // The rows that made the point: both due at the same hour, both written in
  // one breath, and nothing about them is the same task.
  assert.equal(sim.compare('לעשות צ׳ק אין לטיסה (עם מאיה)', 'לעשות ביטוח נסיעות (עם מאיה)').same, false);
  assert.equal(sim.compare('מיכל מכיוונים — טופס', 'טופס טסט').same, false);
  assert.equal(sim.compare('ללכת לשתות מים', 'ללכת לעשות קניות').same, false);
  // The pair that decided the text condition: 0.65 on the old scorer, all of
  // it the same-moment bonus, and one pill is not the other.
  assert.equal(sim.compare('לבדוק משימות למרוץ', 'לבדוק משימות נוספות שיש לי').same, false);
});

test('two titles that disagree about a word are two things, not one', () => {
  // 0.50 of the words shared — לקחת, כדור — and the unshared word is the
  // entire point. He asked for these as a list inside one task, never a merge.
  const pill = sim.compare('לקחת כדור ריבון', 'לקחת כדור לבלוטה');
  assert.equal(pill.same, false);
  assert.equal(pill.reason, 'disagree');
  // …but the same word misspelt is still the same word.
  assert.equal(sim.compare('לקחת כדור ריבון', 'לקחת כדור ריבה').same, true);
  assert.equal(sim.disagrees('לקחת כדור ריבון', 'לקחת כדור ריבה'), false);
  // One side having a word the other lacks is a length difference, not a
  // disagreement — this is the commonest merge in the whole corpus.
  assert.equal(sim.disagrees('ללכת לשתות מים', 'לשתות מים'), false);
});

test('a title that is the request for a reminder is the task it asks about', () => {
  // מאיה asked for one reminder at 09:00; the extraction pass saved her
  // sentence as a second task 35 minutes later. This is that pair.
  const v = sim.compare('לארוז תיק לבית חולים',
    'להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה לתיק לבית חולים');
  assert.equal(v.same, true);
  assert.equal(v.silent, false, 'the words differ, so she says she joined them');
});

test('silence is for an identical title and a sentence for everything else', () => {
  assert.equal(sim.compare('בדיקות דם', 'בדיקות דם').silent, true);
  // Word order and a preposition are not a rewording.
  assert.equal(sim.compare('לקחת כדור ריבון', 'כדור ריבון לקחת').silent, true);
  // These are: one of them carries something the other does not.
  assert.equal(sim.compare('לעשות ביטוח נסיעות לשנינו', 'לעשות ביטוח נסיעות (עם מאיה)').silent, false);
  assert.equal(sim.compare('להוריד את כל השירים', 'להוריד את כל השירים שלי').silent, false);
});

test('normalising keeps the word that carries the task', () => {
  // Three letters have to survive a stripped prefix, or מים becomes ים.
  assert.deepEqual(sim.normalise('לשתות מים'), ['שתות', 'מים']);
  assert.deepEqual(sim.normalise('לתרופות'), ['תרופות']);
  assert.equal(sim.textScore('', 'לשתות מים'), 0);
});
