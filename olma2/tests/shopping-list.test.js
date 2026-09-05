'use strict';
// "לקנות חלב, קוטג׳ וגבינה צהובה" sat in a real list as one line nobody could
// tick off halfway. Splitting it is done in code, never by the model — this
// fires on a large share of everything people dictate, and a token cost on
// every task is the wrong price for a formatting decision.
//
// Half these tests are about what must NOT be split. The rule rewrites what a
// person wrote, so a false positive is much worse than a miss.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const shopping = require('../src/domain/shopping-list');

let db;
// A user per test. The open list is deliberately long-lived state — that is
// the whole feature — so tests that shared one owner would pile into each
// other's list and pass or fail on their running order.
let seq = 0;
async function freshUser() {
  seq += 1;
  const u = await makeUser(db.pool, `+9725093000${String(seq).padStart(2, '0')}`,
    { firstName: 'מירון' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  return u;
}
before(async () => { db = await freshDb(); });
after(async () => { if (db) await db.teardown(); });

const addFor = (uid) => (title, extra = {}) =>
  withTx(db.pool, (c) => tasks.addTask(c, uid, { title, ...extra }));
const childrenOf = async (id) => (await db.pool.query(
  `SELECT title FROM tasks WHERE parent_id = $1 ORDER BY id`, [id])).rows.map((r) => r.title);

test('the parser splits a real list and refuses everything nearby', () => {
  assert.deepEqual(shopping.parseShoppingList('לקנות חלב, קוטג׳ וגבינה צהובה').items,
    ['חלב', 'קוטג׳', 'גבינה צהובה']);
  assert.deepEqual(shopping.parseShoppingList('buy milk, bread and eggs').items,
    ['milk', 'bread', 'eggs']);
  assert.deepEqual(shopping.parseShoppingList('צריך לקנות לחם, חלב').items, ['לחם', 'חלב']);

  // The comma requirement, which is the whole defence. Without it this becomes
  // ['מתנה לאמא', 'לאבא'] and one of the groceries is a person.
  assert.equal(shopping.parseShoppingList('לקנות מתנה לאמא ולאבא'), null);
  // A verb that is not at the start is a sentence containing a list.
  assert.equal(shopping.parseShoppingList('לשאול את דנה על החלב, הלחם והגבינה'), null);
  // One item is not a list.
  assert.equal(shopping.parseShoppingList('לקנות חלב'), null);
  // Real tasks from a live account that must survive untouched.
  assert.equal(shopping.parseShoppingList(
    'לתאם דייט עם מאיה ליום שני הקרוב בשעה 21, במסעדה בתל אביב'), null);
  assert.equal(shopping.parseShoppingList(
    'לסמס לעינת על זה שאני כנראה לא אצליח בתאריכים החדשים, ולעדכן את הסוכנת'), null);
  // A long piece condemns the whole title rather than being dropped: a list
  // silently missing the thing they needed is worse than no list.
  assert.equal(shopping.parseShoppingList(
    `לקנות חלב, ${'א'.repeat(shopping.ITEM_MAX_CHARS + 1)}`), null);
});

test('a dictated list becomes a titled list with items under it', async () => {
  const add = addFor((await freshUser()).id);
  const res = await add('לקנות חלב, קוטג׳ וגבינה צהובה');
  assert.equal(res.ok, true);
  assert.equal(res.data.shoppingList, true);
  assert.equal(res.data.merged, false);
  assert.equal(res.data.task.title, 'קניות');
  assert.equal(res.data.task.category, 'errands');
  assert.deepEqual(await childrenOf(res.data.task.id), ['חלב', 'קוטג׳', 'גבינה צהובה']);
});

test('a second run joins the open list instead of starting a rival one', async () => {
  const add = addFor((await freshUser()).id);
  const first = (await add('לקנות חלב, לחם')).data.task;
  const res = await add('לקנות ביצים, גבינה');
  assert.equal(res.data.merged, true);
  assert.equal(String(res.data.task.id), String(first.id), 'started a second shopping list');
  assert.deepEqual(await childrenOf(first.id), ['חלב', 'לחם', 'ביצים', 'גבינה']);
});

test('something already on the list is not written twice', async () => {
  const add = addFor((await freshUser()).id);
  const list = (await add('לקנות עגבניות, מלפפונים')).data.task;
  const res = await add('לקנות מלפפונים, בצל');
  assert.deepEqual(res.data.items.map((i) => i.title), ['בצל'], 'added a duplicate');
  assert.deepEqual(res.data.alreadyOnList, ['מלפפונים']);
  assert.deepEqual(await childrenOf(list.id), ['עגבניות', 'מלפפונים', 'בצל']);
});

test('ticking the list off ends the run, and the next request starts fresh', async () => {
  const add = addFor((await freshUser()).id);
  const done = (await add('לקנות סוכר, קמח')).data.task;
  await db.pool.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1`, [done.id]);
  const res = await add('לקנות אורז, שמן');
  assert.equal(res.data.merged, false, 'merged into a finished shopping run');
  assert.notEqual(String(res.data.task.id), String(done.id));
});

test('a date on a merge is reported, never applied to a list already there', async () => {
  const add = addFor((await freshUser()).id);
  const list = (await add('לקנות תה, קפה')).data.task;
  assert.equal(list.due_at, null);
  const when = new Date(Date.now() + 86400_000).toISOString().replace('Z', '+00:00');
  const res = await add('לקנות סוכר, חלב', { dueAt: when });
  assert.equal(res.data.merged, true);
  assert.equal(res.data.dueAtIgnored, when, 'silently dropped a date they gave');
  const { rows } = await db.pool.query(`SELECT due_at FROM tasks WHERE id = $1`, [list.id]);
  assert.equal(rows[0].due_at, null, 're-dated a plan they made earlier');
});

test('an ordinary task is untouched, and so is an item added into a project', async () => {
  const add = addFor((await freshUser()).id);
  const plain = await add('לתאם דייט עם מאיה ליום שני הקרוב בשעה 21, במסעדה בתל אביב');
  assert.equal(plain.data.shoppingList, undefined);
  assert.equal(plain.data.task.title, 'לתאם דייט עם מאיה ליום שני הקרוב בשעה 21, במסעדה בתל אביב');

  // Inside a project the split must not run: whoever chose the parent already
  // did the splitting, and re-splitting would nest a second level.
  const project = (await add('טיול')).data.task;
  const sub = await add('לקנות מפה, פנס', { parentId: project.id });
  assert.equal(sub.data.shoppingList, undefined);
  assert.equal(sub.data.task.title, 'לקנות מפה, פנס');
  assert.equal(String(sub.data.task.parent_id), String(project.id));
});
