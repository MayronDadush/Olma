'use strict';
// The dashboard's drag and drop, through the one door the page uses
// (write.perform) and read back through the function that builds the page
// (dash.load) — never a replica of either query.
//
// Two gestures: dragging a task to a new place in its group (setTaskOrder),
// and dropping it onto another task, which makes it an item on that task's
// list (nestTask / unnestTask). And the checklist items the page now saves.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const tasks = require('../src/domain/tasks');
const shares = require('../src/domain/shares');
const connections = require('../src/domain/connections');

let db, me, friend;
const tx = (fn) => withTx(db.pool, fn);
const actAs = (uid, action, payload) => tx((c) => write.perform(c, uid, action, payload));
const act = (action, payload) => actAs(me.id, action, payload);
const load = async (uid = me.id) => (await tx((c) => dash.load(c, uid))).data;
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d+Z$/, '+00:00');

let n = 0;
const mk = async (uid = me.id, extra = {}) => {
  const r = await tx((c) => tasks.addTask(c, uid, { title: `משימה ${++n}`, ...extra }));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.task;
};
const ids = (list) => list.map((x) => String(x.id));
const okRes = (r) => assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531940001', { firstName: 'Miron' });
  friend = await makeUser(db.pool, '+972531940002', { firstName: 'Gali' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  const req = await tx((c) => connections.requestConnection(c, me.id, friend.phone));
  await tx((c) => connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve'));
});
after(async () => { if (db) await db.teardown(); });

async function shareWithFriend(taskId, from = me, to = friend) {
  const offer = await tx((c) => shares.offerShare(c, from.id, taskId, to.id));
  okRes(offer);
  okRes(await tx((c) => shares.respondToShare(c, to.id, offer.data.share.id, 'accept')));
  return offer.data.share;
}

// ── order ───────────────────────────────────────────────────────────────────

test('an order they dragged is the order the page gets back, on every load', async () => {
  const soon = await mk(me.id, { dueAt: iso(3600e3) });
  const a = await mk(), b = await mk();
  // Nobody dragged anything yet: dated first, then by id — unchanged behaviour.
  const before = ids((await load()).tasks);
  assert.ok(before.indexOf(String(soon.id)) < before.indexOf(String(a.id)), 'the old date order is gone');

  okRes(await act('setTaskOrder', { taskIds: [b.id, a.id, soon.id] }));
  for (let i = 0; i < 2; i++) {
    const got = ids((await load()).tasks).filter((id) => [b.id, a.id, soon.id].map(String).includes(id));
    assert.deepEqual(got, [b.id, a.id, soon.id].map(String));
  }
  // Rows nobody positioned come after the positioned ones.
  const late = await mk();
  const all = ids((await load()).tasks);
  assert.ok(all.indexOf(String(late.id)) > all.indexOf(String(soon.id)));
});

test('one id that is not on their list refuses the whole order and writes nothing', async () => {
  const mine = await mk();
  const stranger = await makeUser(db.pool, '+972531940077', { firstName: 'Zed' });
  const theirs = await mk(stranger.id);
  const r = await act('setTaskOrder', { taskIds: [mine.id, theirs.id] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'not_found');
  const { rows } = await db.pool.query(`SELECT 1 FROM task_order WHERE task_id = $1`, [mine.id]);
  assert.equal(rows.length, 0, 'half an order was written');

  for (const bad of [[], 'x', [0], [-1], ['abc']]) {
    const res = await act('setTaskOrder', { taskIds: bad });
    assert.equal(res.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.equal(res.error.code, 'invalid');
  }
});

test('a task shared with them can be placed on their list, and the order is theirs alone', async () => {
  const shared = await mk();
  const other = await mk(friend.id);
  await shareWithFriend(shared.id);
  okRes(await actAs(friend.id, 'setTaskOrder', { taskIds: [shared.id, other.id] }));
  okRes(await actAs(friend.id, 'setTaskOrder', { taskIds: [other.id, shared.id] }));
  const { rows } = await db.pool.query(`SELECT user_id FROM task_order WHERE task_id = $1`, [shared.id]);
  assert.deepEqual(rows.map((r) => String(r.user_id)), [String(friend.id)], 'their drag moved it on MY list');
});

// ── nesting ─────────────────────────────────────────────────────────────────

test('dropping a task onto another makes it an item, and undo puts it back where it was', async () => {
  const list = await mk(me.id, { category: 'home' });
  const item = await mk();
  const other = await mk();
  okRes(await act('setTaskOrder', { taskIds: [other.id, item.id, list.id] }));

  const r = await act('nestTask', { taskId: item.id, parentId: list.id });
  okRes(r);
  let page = await load();
  assert.ok(!ids(page.tasks).includes(String(item.id)), 'the item is still a row of its own');
  const parent = page.tasks.find((x) => String(x.id) === String(list.id));
  assert.deepEqual(parent.items.map((i) => String(i.id)), [String(item.id)]);
  const { rows: [row] } = await db.pool.query(`SELECT category, category_auto FROM tasks WHERE id = $1`, [item.id]);
  assert.equal(row.category, 'home', 'an uncategorised item did not take the list’s category');

  okRes(await act('unnestTask', { taskId: item.id }));
  page = await load();
  const order = ids(page.tasks).filter((id) => [other.id, item.id, list.id].map(String).includes(id));
  assert.deepEqual(order, [other.id, item.id, list.id].map(String), 'undo lost its place');
  assert.equal(page.tasks.find((x) => String(x.id) === String(list.id)).items.length, 0);
});

test('an item keeps its own category when it had one', async () => {
  const list = await mk(me.id, { category: 'home' });
  const item = await mk(me.id, { category: 'work' });
  okRes(await act('nestTask', { taskId: item.id, parentId: list.id }));
  const { rows: [row] } = await db.pool.query(`SELECT category FROM tasks WHERE id = $1`, [item.id]);
  assert.equal(row.category, 'work');
});

test('dropping onto a list that already has items just adds one more', async () => {
  const list = await mk();
  const a = await mk(), b = await mk();
  okRes(await act('nestTask', { taskId: a.id, parentId: list.id }));
  okRes(await act('nestTask', { taskId: b.id, parentId: list.id }));
  const parent = (await load()).tasks.find((x) => String(x.id) === String(list.id));
  assert.equal(parent.items.length, 2);
});

test('every case the owner ruled out is refused by name', async () => {
  const reason = async (taskId, parentId) => {
    const r = await act('nestTask', { taskId, parentId });
    assert.equal(r.ok, false, `nested ${taskId} into ${parentId}`);
    return r.error.reason || r.error.message;
  };
  const target = await mk();

  const self = await mk();
  assert.equal(await reason(self.id, self.id), 'self');

  const dated = await mk(me.id, { dueAt: iso(86400e3) });
  assert.equal(await reason(dated.id, target.id), 'has_date');

  const list = await mk(), sub = await mk();
  okRes(await act('nestTask', { taskId: sub.id, parentId: list.id }));
  assert.equal(await reason(list.id, target.id), 'is_list', 'a list went into another list');
  assert.equal(await reason(sub.id, target.id), 'is_item');
  const loose = await mk();
  assert.match(await reason(loose.id, sub.id), /one level/, 'nested into an item');

  const shared = await mk();
  await shareWithFriend(shared.id);
  assert.equal(await reason(shared.id, target.id), 'shared');

  const imported = await mk();
  await db.pool.query(`UPDATE tasks SET source = 'slack' WHERE id = $1`, [imported.id]);
  assert.equal(await reason(imported.id, target.id), 'imported');
  assert.equal(await reason(loose.id, imported.id), 'imported');

  const stranger = await makeUser(db.pool, '+972531940088', { firstName: 'Yon' });
  const theirs = await mk(stranger.id);
  const r = await act('nestTask', { taskId: loose.id, parentId: theirs.id });
  assert.equal(r.error.code, 'not_found');
  const r2 = await act('nestTask', { taskId: theirs.id, parentId: target.id });
  assert.equal(r2.error.code, 'not_found');
});

test('the notice is stamped on the person once, at the first nesting', async () => {
  const who = await makeUser(db.pool, '+972531940099', { firstName: 'Noa' });
  assert.equal((await load(who.id)).user.nestTipSeen, false);
  const list = await mk(who.id), a = await mk(who.id), b = await mk(who.id);
  okRes(await actAs(who.id, 'nestTask', { taskId: a.id, parentId: list.id }));
  assert.equal((await load(who.id)).user.nestTipSeen, true);
  const { rows: [first] } = await db.pool.query(`SELECT nest_tip_seen_at FROM users WHERE id = $1`, [who.id]);
  okRes(await actAs(who.id, 'nestTask', { taskId: b.id, parentId: list.id }));
  const { rows: [second] } = await db.pool.query(`SELECT nest_tip_seen_at FROM users WHERE id = $1`, [who.id]);
  assert.equal(second.nest_tip_seen_at.getTime(), first.nest_tip_seen_at.getTime());
  // a refused nesting stamps nothing
  const other = await makeUser(db.pool, '+972531940098', { firstName: 'Tal' });
  const t = await mk(other.id);
  await actAs(other.id, 'nestTask', { taskId: t.id, parentId: t.id });
  assert.equal((await load(other.id)).user.nestTipSeen, false);
});

// ── the checklist items the page now saves ──────────────────────────────────

test('an item is added, ticked, un-ticked and removed through the existing actions', async () => {
  const list = await mk();
  const add = await act('addTask', { title: 'חלב', parentId: list.id });
  okRes(add);
  const itemId = add.data.task.id;
  const items = async () => (await load()).tasks.find((x) => String(x.id) === String(list.id)).items;
  assert.deepEqual((await items()).map((i) => i.done), [false]);

  okRes(await act('completeTask', { taskId: itemId }));
  // the last open item done completes the list itself, which is existing behaviour
  const reopened = await act('restoreTask', { taskId: list.id });
  okRes(reopened);
  assert.deepEqual((await items()).map((i) => i.done), [true]);

  okRes(await act('restoreTask', { taskId: itemId }));
  assert.deepEqual((await items()).map((i) => i.done), [false]);

  okRes(await act('archiveTask', { taskId: itemId }));
  assert.deepEqual(await items(), [], 'an archived item came back on reload');
});

// ── a task somebody shared with me ──────────────────────────────────────────
// Everyone on it is equal (2026-09-19): the same actions, through the same
// door, written as the person who opened it. Until then every one of these
// was refused for the friend, and the sheet was locked to say so.

test('the friend renames, dates, ticks and lists on a task I shared, as if it were theirs', async () => {
  const list = await mk();
  await shareWithFriend(list.id);
  const asFriend = (action, payload) => actAs(friend.id, action, payload);
  const row = async (uid = friend.id) => (await load(uid)).tasks.find((x) => String(x.id) === String(list.id));

  okRes(await asFriend('editTask', { taskId: list.id, title: 'סידורים לשבת', category: 'home' }));
  assert.equal((await row()).title, 'סידורים לשבת');
  assert.equal((await row(me.id)).title, 'סידורים לשבת', 'one row, two lists — the rename reached mine');
  assert.equal((await row()).mine, false, 'writing on it did not make it theirs');

  const add = await asFriend('addTask', { title: 'חלה', parentId: list.id });
  okRes(add);
  assert.equal(String(add.data.task.owner_id), String(me.id), 'an item on my list that I could not tick');
  okRes(await asFriend('completeTask', { taskId: add.data.task.id }));
  // the last open item done completes the list itself (existing behaviour),
  // and re-opening the list is the friend's to do as well
  okRes(await asFriend('restoreTask', { taskId: list.id }));
  okRes(await asFriend('restoreTask', { taskId: add.data.task.id }));
  okRes(await asFriend('archiveTask', { taskId: add.data.task.id }));
  assert.deepEqual((await row()).items, [], 'an item the friend removed is still on the list');

  const when = iso(2 * 86400e3);
  okRes(await asFriend('editTask', { taskId: list.id, dueAt: when }));
  okRes(await asFriend('snoozeTask', { taskId: list.id, dueAt: iso(3 * 86400e3) }));
  okRes(await asFriend('completeTask', { taskId: list.id }));
  const { rows: [after] } = await db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [list.id]);
  assert.equal(after.status, 'done', 'the friend ticked it and the row is still open');
  okRes(await asFriend('restoreTask', { taskId: list.id }));
  assert.equal((await row(me.id)).done, false, 'and re-opened it, and my list still shows it done');

  // What stays the owner's: the reminder (until each participant has their
  // own) and the guest list.
  const stranger = await makeUser(db.pool, '+972531940066', { firstName: 'Zed' });
  const r = await asFriend('setTaskReminder', { taskId: list.id, on: true, remindAt: iso(86400e3) });
  assert.equal(r.ok, false, 'the friend set a reminder that would have reached ME');
  assert.equal((await asFriend('shareTask', { taskId: list.id, viewerId: stranger.id })).ok, false);
  // And a stranger to the task is still shown nothing, not "forbidden".
  assert.equal((await actAs(stranger.id, 'editTask', { taskId: list.id, title: 'x' })).error.code, 'not_found');
  assert.equal((await actAs(stranger.id, 'completeTask', { taskId: list.id })).error.code, 'not_found');
});

test('"delete" on a task others are on is leaving; only the last one left can delete', async () => {
  const list = await mk();
  const item = await act('addTask', { title: 'אוהל', parentId: list.id });
  okRes(item);
  const share = await shareWithFriend(list.id);
  const on = async (uid) => (await load(uid)).tasks.some((x) => String(x.id) === String(list.id));

  const mine = await act('archiveTask', { taskId: list.id });
  assert.equal(mine.ok, false, 'the opener put away a task the friend was still on');
  assert.equal(mine.error.reason, 'shared');
  const theirs = await actAs(friend.id, 'archiveTask', { taskId: list.id });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.error.reason, 'shared');

  // The opener leaves first: the friend inherits the list and the item.
  const left = await act('leaveTask', { taskId: list.id });
  okRes(left);
  assert.equal(String(left.data.handedTo), String(friend.id));
  assert.equal(await on(me.id), false, 'left, and still on my list');
  const inherited = (await load(friend.id)).tasks.find((x) => String(x.id) === String(list.id));
  assert.equal(inherited.mine, true, 'the heir still sees it as somebody else\'s');
  assert.deepEqual(inherited.who, [], 'a face left on it for somebody who is gone');
  assert.equal(inherited.items.length, 1, 'the item did not follow the list');
  assert.equal((await db.pool.query(`SELECT status FROM shares WHERE id = $1`, [share.id])).rows[0].status, 'revoked');

  // Now alone on it, the friend cannot leave — only delete.
  assert.equal((await actAs(friend.id, 'leaveTask', { taskId: list.id })).error.reason, 'alone');
  okRes(await actAs(friend.id, 'archiveTask', { taskId: list.id }));
  assert.equal(await on(friend.id), false);

  // The other direction: a participant leaves and the task stays put.
  const second = await mk();
  await shareWithFriend(second.id);
  okRes(await actAs(friend.id, 'leaveTask', { taskId: second.id }));
  assert.equal(await on(friend.id), false);
  const still = (await load(me.id)).tasks.find((x) => String(x.id) === String(second.id));
  assert.equal(still.mine, true);
  assert.deepEqual(still.who, []);
  okRes(await act('archiveTask', { taskId: second.id }));
});

test('a task of mine dropped onto a list the friend shared with me becomes their item', async () => {
  const theirList = await mk(friend.id);
  await shareWithFriend(theirList.id, friend, me);
  const loose = await mk();
  const r = await act('nestTask', { taskId: loose.id, parentId: theirList.id });
  okRes(r);
  const { rows: [row] } = await db.pool.query(`SELECT owner_id, parent_id FROM tasks WHERE id = $1`, [loose.id]);
  assert.equal(String(row.owner_id), String(friend.id));
  assert.equal(String(row.parent_id), String(theirList.id));
  const onPage = (await load(me.id)).tasks.find((x) => String(x.id) === String(theirList.id));
  assert.equal(onPage.items.length, 1, 'the item is not on the list as I see it');
  okRes(await actAs(friend.id, 'completeTask', { taskId: loose.id }));
  // and the way back is theirs too — the item is on their list now
  okRes(await actAs(friend.id, 'restoreTask', { taskId: loose.id }));
  okRes(await act('unnestTask', { taskId: loose.id }));
  assert.equal(String((await db.pool.query(`SELECT owner_id FROM tasks WHERE id = $1`, [loose.id])).rows[0].owner_id),
    String(friend.id), 'un-nesting does not hand it back');

  const nudged = await mk();
  okRes(await act('setTaskReminder', { taskId: nudged.id, on: true, remindAt: iso(86400e3) }));
  const kept = await act('nestTask', { taskId: nudged.id, parentId: theirList.id });
  assert.equal(kept.ok, false, 'a task with a reminder pending changed hands');
  assert.equal(kept.error.reason, 'has_reminder');
});
