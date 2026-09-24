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

// The corpus and its answer key live in tests/fixtures/task-similarity-corpus.js,
// shared with scripts/pilot-jev.js so a candidate model is measured against the
// same eighty labels this suite asserts on.
const { CORPUS, KNOWN_MISSES, KNOWN_OVER_MERGES } = require('./fixtures/task-similarity-corpus');

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

// ── The live path ───────────────────────────────────────────────────────────
// Same module, opposite answer to the one fact-extraction gives, and the
// asymmetry is deliberate: a background job refusing costs nothing — it has
// no channel to ask on, and the live tool has already captured the sentence —
// while a refusal in front of somebody who has just said a thing out loud
// loses it. An attempt to refuse here broke
// 57 tests on fixtures like "סופר" beside "סופר השבוע".
const { test: dbTest } = require('node:test');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');

let db;
require('node:test').before(async () => { db = await freshDb(); });
require('node:test').after(async () => { await db.teardown(); });

dbTest('a reworded task is SAVED, and the question travels with it', async () => {
  const u = await makeUser(db.pool, '+972501000091', { firstName: 'Gali' });
  const c = await db.pool.connect();
  try {
    await tasks.addTask(c, u.id, { title: 'לדבר עם מור חן — לבקש חומרי גלם' });
    const again = await tasks.addTask(c, u.id, { title: 'לדבר עם מור חן ולבקש חומרי גלם' });
    assert.equal(again.ok, true, 'never a refusal on the path with a person on it');
    assert.equal(again.data.similarTo.title, 'לדבר עם מור חן — לבקש חומרי גלם');
    assert.equal(again.data.similarTo.silent, false);

    const open = await tasks.listTasks(c, u.id, { status: 'open' });
    assert.equal(open.data.tasks.length, 2, 'both rows are there — nothing was merged behind them');

    // An identical title is still the old refusal, unchanged.
    const exact = await tasks.addTask(c, u.id, { title: 'לדבר עם מור חן ולבקש חומרי גלם' });
    assert.equal(exact.ok, false);
    assert.equal(exact.error.reason, 'duplicate');
  } finally { c.release(); }
});

dbTest('nothing close enough carries no question at all', async () => {
  const u = await makeUser(db.pool, '+972501000092', { firstName: 'Ron' });
  const c = await db.pool.connect();
  try {
    await tasks.addTask(c, u.id, { title: 'לקחת כדור ריבון' });
    const other = await tasks.addTask(c, u.id, { title: 'לקחת כדור לבלוטה' });
    assert.equal(other.ok, true);
    assert.equal(other.data.similarTo, undefined, 'two medicines are never asked about as one');
  } finally { c.release(); }
});

dbTest('a checklist item is never measured against a standalone task', async () => {
  const u = await makeUser(db.pool, '+972501000093', { firstName: 'Noa' });
  const c = await db.pool.connect();
  try {
    await tasks.addTask(c, u.id, { title: 'מטען לטלפון' });
    const bag = await tasks.addTask(c, u.id, { title: 'לארוז תיק' });
    // Close enough to be asked about at the top level, and asked about here
    // would cost a whole packing list its items.
    const item = await tasks.addTask(c, u.id, { title: 'מטען לטלפון שלי', parentId: bag.data.task.id });
    assert.equal(item.ok, true);
    assert.equal(item.data.similarTo, undefined);
  } finally { c.release(); }
});
