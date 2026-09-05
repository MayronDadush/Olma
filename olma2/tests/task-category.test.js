'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const taskCategory = require('../src/domain/task-category');
const dash = require('../src/domain/user-dashboard');
const { withTx } = require('../src/db/pool');

let db, alice;
before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972501000051');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

// ---------------------------------------------------------------- the guesser

test('the closed set is the six the page draws, and nothing else', () => {
  assert.deepEqual(taskCategory.CATEGORIES,
    ['home', 'work', 'family', 'health', 'money', 'errands']);
});

test('real production titles land where a person would put them', () => {
  // Every one of these is a title that existed on the box on 2026-09-04. The
  // point of pinning real ones is that a stem list is only ever as good as the
  // sentences it meets, and invented examples flatter it.
  const cases = [
    ['תור רופא', 'health'],
    ['שיחת טלפון עם רופא', 'health'],
    ['לקחת כדור ריבון בבוקר', null],
    ['משמרת - ראשון 12:00-19:00', 'work'],
    ['משמרת עבודה - יום שני 11:00-18:00', 'work'],
    ['סופר', 'errands'],
    ['לקנות חלב, קוטג׳ וגבינה צהובה', 'errands'],
    ['סדר בבית', 'home'],
    ['שקיות זבל', 'home'],
    ['לאסוף את הילדים', 'family'],
    ['לך להורים', 'family'],
    ['Go to parents at 4 PM', 'family'],
    ['לשלם שכר דירה', 'money'],
    ['Finish the client deck', 'work'],
    ['Book a dentist appointment', 'health'],
  ];
  for (const [title, want] of cases) {
    assert.equal(taskCategory.classifyText(title), want, title);
  }
});

test('a title it cannot place stays unplaced rather than guessing', () => {
  // A wrong category hides a task under a heading nobody opens, so silence is
  // the better failure. None of these is any of the six.
  for (const title of ['נוח', 'היפגש עם חברה', 'Lunch with Maor',
    'לתאם דייט עם מאיה', 'רכב 2 - השלמת בדיקה ומכירה']) {
    assert.equal(taskCategory.classifyText(title), null, title);
  }
});

test('a compound is judged before the general word inside it', () => {
  // Each of these contains the stem of a DIFFERENT category, and only rule
  // order keeps them apart.
  assert.equal(taskCategory.classifyText('לקחת את אמא לבית חולים'), 'health');
  assert.equal(taskCategory.classifyText('אסיפת הורים בבית ספר'), 'family');
  assert.equal(taskCategory.classifyText('לסדר את הבית'), 'home');
  assert.equal(taskCategory.classifyText('לשלוח חשבונית ללקוח'), 'work');
});

test('the vocabulary production actually accumulated folds onto keys', () => {
  const seen = {
    'בריאות': 'health', 'עבודה': 'work', 'משפחה': 'family',
    'קניות': 'errands', 'בית': 'home', 'מטבח': 'home',
    'personal': null, 'none': null, 'זוגי': null, 'דברים שצריך לעשות': null,
  };
  for (const [raw, want] of Object.entries(seen)) {
    assert.equal(taskCategory.normaliseCategory(raw), want, raw);
  }
});

// ---------------------------------------------------------------- write paths

test('a task added with no category gets one, marked as ours', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'לשלם ארנונה' });
    assert.equal(r.ok, true);
    assert.equal(r.data.task.category, 'money');
    assert.equal(r.data.task.category_auto, true);
  });
});

test('a category the caller gave on-vocabulary is theirs, not ours', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'סופר', category: 'family' });
    assert.equal(r.data.task.category, 'family');
    assert.equal(r.data.task.category_auto, false,
      'an explicit key must survive a title that says otherwise');
  });
});

test('an off-vocabulary category is folded onto a key and owned by us', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'משהו', category: 'בריאות' });
    assert.equal(r.data.task.category, 'health');
    assert.equal(r.data.task.category_auto, true);
  });
});

test('a subtask inherits its project when its own words say nothing', async () => {
  await withClient(async (c) => {
    const parent = await tasks.addTask(c, alice.id, { title: 'סופר' });
    assert.equal(parent.data.task.category, 'errands');
    const kid = await tasks.addTask(c, alice.id, { title: 'ירקות', parentId: parent.data.task.id });
    assert.equal(kid.data.task.category, 'errands');
    assert.equal(kid.data.task.category_auto, true);
  });
});

test('a subtask whose own words DO say something keeps them', async () => {
  await withClient(async (c) => {
    const parent = await tasks.addTask(c, alice.id, { title: 'סידורים לשבוע', category: 'errands' });
    const kid = await tasks.addTask(c, alice.id, { title: 'לקבוע תור לרופא שיניים', parentId: parent.data.task.id });
    assert.equal(kid.data.task.category, 'health');
  });
});

test('bulk add categorises every item and inherits the same way', async () => {
  await withClient(async (c) => {
    const parent = await tasks.addTask(c, alice.id, { title: 'קניות לשבת' });
    const r = await tasks.addTasksBulk(c, alice.id,
      [{ title: 'פירות' }, { title: 'יוגורט חלבון' }, { title: 'לשלם את החשמל' }],
      { parentId: parent.data.task.id });
    assert.equal(r.ok, true);
    const [fruit, yoghurt, power] = r.data.tasks;
    assert.equal(fruit.category, 'errands');
    assert.equal(yoghurt.category, 'errands');
    assert.equal(power.category, 'money', 'an item with its own answer keeps it');
  });
});

test('editing the category hands the field to the person', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'לשלם שכר דירה' });
    assert.equal(r.data.task.category_auto, true);
    const e = await tasks.editTask(c, alice.id, r.data.task.id, { category: 'home' });
    assert.equal(e.data.task.category, 'home');
    assert.equal(e.data.task.category_auto, false);
    // ...and it stays theirs when they say it in their own words.
    const e2 = await tasks.editTask(c, alice.id, r.data.task.id, { category: 'עבודה' });
    assert.equal(e2.data.task.category, 'work');
    assert.equal(e2.data.task.category_auto, false);
  });
});

test('clearing the category is allowed and is still the person\'s call', async () => {
  await withClient(async (c) => {
    const r = await tasks.addTask(c, alice.id, { title: 'לקנות חלב' });
    const e = await tasks.editTask(c, alice.id, r.data.task.id, { category: null });
    assert.equal(e.data.task.category, null);
    assert.equal(e.data.task.category_auto, false);
  });
});

// ---------------------------------------------------------------- the page

test('the dashboard tells the page which categories were guesses', async () => {
  const guessed = await withClient((c) => tasks.addTask(c, alice.id, { title: 'ניקיון כללי' }));
  const chosen = await withClient((c) => tasks.addTask(c, alice.id, { title: 'משהו אחר', category: 'work' }));
  const d = await withTx(db.pool, (c) => dash.load(c, alice.id));
  assert.equal(d.ok, true);
  const byId = new Map(d.data.tasks.map((t) => [t.id, t]));
  assert.equal(byId.get(guessed.data.task.id).category, 'home');
  assert.equal(byId.get(guessed.data.task.id).catAuto, true);
  assert.equal(byId.get(chosen.data.task.id).catAuto, false);
});
