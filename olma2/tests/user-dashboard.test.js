'use strict';
// The personal dashboard's read model. Every assertion here is really about a
// column name: the payload is assembled from eight tables, and the only thing
// that proves a query is right is running it against the real migrations.
//
// It is also where the projection rules are pinned. Two of them matter more
// than the shapes: no phone number ever reaches the payload (it is bound for a
// browser), and no credential column is ever selected.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const dash = require('../src/domain/user-dashboard');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const tasks = require('../src/domain/tasks');

let db, me, friend;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531900001', { firstName: 'Miron' });
  friend = await makeUser(db.pool, '+972531900002', { firstName: 'Gali' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
});
after(async () => { if (db) await db.teardown(); });

const load = (uid) => withTx(db.pool, (c) => dash.load(c, uid));

test('an unknown user is not_found, never an empty dashboard', async () => {
  const res = await load(999999);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_found');
});

test('the eval user is sealed off from this page', async () => {
  const ev = await makeUser(db.pool, '+972599999001', { firstName: 'Eval' });
  await db.pool.query(`UPDATE users SET is_eval = true WHERE id = $1`, [ev.id]);
  const res = await load(ev.id);
  assert.equal(res.ok, false, 'a page for the eval user could only ever show fixtures');
});

test('a blocked user gets no page', async () => {
  const b = await makeUser(db.pool, '+972531900009', { firstName: 'Blocked' });
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [b.id]);
  assert.equal((await load(b.id)).ok, false);
});

test('every column the payload names actually exists', async () => {
  const res = await load(me.id);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const d = res.data;
  assert.equal(d.user.id, me.id);
  assert.equal(d.user.firstName, 'Miron');
  assert.equal(d.user.timezone, 'Asia/Jerusalem');
  assert.equal(d.user.locale, 'he');
  assert.equal(d.user.paused, false);
  assert.deepEqual(d.tasks, []);
  assert.deepEqual(d.archived, []);
  assert.deepEqual(d.friends, []);
  assert.deepEqual(d.meetings, []);
});

test('a task carries the wall clock the person chose, in their own zone', async () => {
  // 21:00 Jerusalem is 18:00Z — the payload must say 21:00, or the page shows
  // a task three hours from where its owner put it (the "משמרת 15:00 stored as
  // Z" incident, one layer up).
  const res = await withTx(db.pool, (c) => tasks.addTask(c, me.id, {
    title: 'לשלם שכר דירה', dueAt: '2026-09-10T21:00:00+03:00', category: 'money',
  }));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const d = (await load(me.id)).data;
  const t = d.tasks.find((x) => x.title === 'לשלם שכר דירה');
  assert.ok(t, 'task missing from the payload');
  assert.equal(t.date, '2026-09-10');
  assert.equal(t.time, '21:00');
  assert.equal(t.allDay, false);
  assert.equal(t.category, 'money');
  assert.equal(t.source, null, "the person's own writing has no import source");
  assert.equal(t.caps, null);
});

test('an unknown category renders as none rather than vanishing', async () => {
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'odd' }));
  await db.pool.query(`UPDATE tasks SET category = 'a-category-from-the-future' WHERE id = $1`,
    [r.data.task.id]);
  const t = (await load(me.id)).data.tasks.find((x) => x.title === 'odd');
  assert.ok(t, 'a task with an unrecognised category disappeared from the list');
  assert.equal(t.category, 'none');
});

test('an imported task ships the capabilities its source can actually hold', async () => {
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'campaign creative' }));
  await db.pool.query(`UPDATE tasks SET source = 'monday' WHERE id = $1`, [r.data.task.id]);
  const t = (await load(me.id)).data.tasks.find((x) => x.title === 'campaign creative');
  assert.equal(t.source, 'monday');
  assert.deepEqual(t.caps, dash.SOURCE_CAPS.monday);
  assert.ok(!t.caps.includes('repeat'), 'monday cannot hold a repeat rule');
});

test("a source we do not know is the person's own writing, not a broken import", async () => {
  // `tasks.source` is free text with 'chat' as its default, and the extraction
  // job writes 'extracted'. Neither is an import, and treating an unrecognised
  // value as one would grey out fields on a task nobody imported.
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'from a chat' }));
  await db.pool.query(`UPDATE tasks SET source = 'extracted' WHERE id = $1`, [r.data.task.id]);
  const t = (await load(me.id)).data.tasks.find((x) => x.title === 'from a chat');
  assert.equal(t.source, null);
  assert.equal(t.caps, null);
});

test('a checklist arrives as items, not as separate tasks', async () => {
  const parent = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'קניות' }));
  const pid = parent.data.task.id;
  for (const title of ['חלה', 'יין']) {
    await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title, parentId: pid }));
  }
  const d = (await load(me.id)).data;
  const p = d.tasks.find((x) => x.id === pid);
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.items.map((i) => i.title), ['חלה', 'יין']);
  assert.equal(p.items.every((i) => i.done === false), true);
  assert.equal(d.tasks.some((x) => x.title === 'חלה'), false,
    'a checklist line must not also appear as a top-level task');
});

test('a friend arrives by name and features, never by phone', async () => {
  const req = await withTx(db.pool, (c) =>
    connections.requestConnection(c, me.id, friend.phone));
  assert.equal(req.ok, true, req.ok ? '' : JSON.stringify(req.error));
  const res = await withTx(db.pool, (c) =>
    connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));

  const d = (await load(me.id)).data;
  assert.equal(d.friends.length, 1);
  const f = d.friends[0];
  assert.equal(f.id, friend.id);
  assert.equal(f.name, 'Gali');
  // Approving a connection auto-grants every feature for both sides, so this
  // is what a real friend looks like the moment they accept.
  assert.ok(f.features.length > 0, 'an accepted connection grants features to both sides');

  const json = JSON.stringify(d);
  assert.equal(json.includes(friend.phone), false, 'a phone number reached the browser payload');
  assert.equal(json.includes(me.phone), false);
});

test("a feature revoked by ME disappears from MY view of that friend", async () => {
  const before = (await load(me.id)).data.friends[0].features;
  const feature = before[0];
  const cid = (await load(me.id)).data.friends[0].connectionId;
  const r = await withTx(db.pool, (c) => grants.revokeFeatureGrant(c, me.id, cid, feature));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const after = (await load(me.id)).data.friends[0].features;
  assert.equal(after.includes(feature), false);
  // The grant is per side. Revoking mine must not touch theirs — a page that
  // showed the other side's grants as my own would let one person appear to
  // turn something off for both.
  const theirs = (await load(friend.id)).data.friends[0].features;
  assert.equal(theirs.includes(feature), true, 'revoking one side changed the other');
});

test('no credential column can reach the payload', async () => {
  await db.pool.query(
    `INSERT INTO integrations (user_id, provider, status, access_level, account_label,
                               credential_enc, refresh_enc, scopes)
     VALUES ($1, 'google', 'connected', 'read_write', 'miron@gmail.com',
             'SECRET-ACCESS-TOKEN', 'SECRET-REFRESH-TOKEN', 'https://www.googleapis.com/auth/calendar.events')`,
    [me.id]
  );
  const d = (await load(me.id)).data;
  const g = d.integrations.find((i) => i.provider === 'google');
  assert.equal(g.connected, true);
  assert.equal(g.access, 'read_write');
  assert.equal(g.account, 'miron@gmail.com');
  const json = JSON.stringify(d);
  assert.equal(json.includes('SECRET-ACCESS-TOKEN'), false);
  assert.equal(json.includes('SECRET-REFRESH-TOKEN'), false);
  // `scopes` is the raw grant string Google returned; `access_level` is the
  // half that says what we may do, and it is the only half anyone needs.
  assert.equal(json.includes('googleapis.com'), false);
});

test('needs_reauth is its own state, not a disconnection', async () => {
  await db.pool.query(
    `UPDATE integrations SET status = 'needs_reauth' WHERE user_id = $1 AND provider = 'google'`,
    [me.id]
  );
  const g = (await load(me.id)).data.integrations.find((i) => i.provider === 'google');
  assert.equal(g.connected, false);
  assert.equal(g.needsReauth, true,
    'a rejected connection must be distinguishable from one never made');
});

test('a paused user is shown as paused', async () => {
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [me.id]);
  assert.equal((await load(me.id)).data.user.paused, true);
  await db.pool.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [me.id]);
});

test('an archived task is archived, and is not in the open list', async () => {
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'done and gone' }));
  await db.pool.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), archived_at = now() WHERE id = $1`,
    [r.data.task.id]
  );
  const d = (await load(me.id)).data;
  assert.equal(d.archived.some((x) => x.title === 'done and gone'), true);
  assert.equal(d.tasks.some((x) => x.title === 'done and gone'), false);
});

// ---------------------------------------------------------- finished vs open
//
// The live bug of 2026-09-05: Gali opened her dashboard and three tasks sat in
// "באיחור" that she could neither tick nor delete. They were tasks she had
// already finished — by talking to Olma, which is what `complete_task` is for,
// and which sets `status = 'done'` and nothing else. This payload split its two
// lists on `archived_at` alone, so all of them came back as OPEN and ticked,
// and every control on them was refused by a server that could see they were
// already done. Five users held twenty such rows.

test('a task finished from chat is in the archive, not sitting open and ticked', async () => {
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'לקחת תרופה' }));
  // Exactly what complete_task leaves behind: done, never archived.
  await withTx(db.pool, (c) => tasks.completeTask(c, me.id, r.data.task.id));
  const { rows } = await db.pool.query(
    'SELECT status, archived_at FROM tasks WHERE id = $1', [r.data.task.id]);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].archived_at, null, 'the premise: completing does not archive');

  const d = (await load(me.id)).data;
  assert.equal(d.tasks.some((x) => x.id === r.data.task.id), false,
    'a finished task must not be on the open list');
  assert.equal(d.archived.some((x) => x.id === r.data.task.id), true);
});

test('nothing on the open list is already done', async () => {
  // The property, not the instance — this is the assertion that would have
  // caught it, whatever route put a done row there.
  const d = (await load(me.id)).data;
  assert.deepEqual(d.tasks.filter((x) => x.done).map((x) => x.title), []);
});

test('the archive is ordered by when things were finished, newest first', async () => {
  const u = await makeUser(db.pool, '+972541000077', { firstName: 'Ordered' });
  const made = [];
  for (const title of ['first', 'second', 'third']) {
    const r = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title }));
    made.push(r.data.task.id);
  }
  // Finished out of the order they were created, and out of any due-date order.
  await db.pool.query(
    `UPDATE tasks SET status = 'done', completed_at = $2 WHERE id = $1`,
    [made[0], '2026-09-03T10:00:00Z']);
  await db.pool.query(
    `UPDATE tasks SET status = 'done', completed_at = $2 WHERE id = $1`,
    [made[1], '2026-09-01T10:00:00Z']);
  await db.pool.query(
    `UPDATE tasks SET status = 'done', completed_at = $2, archived_at = $2 WHERE id = $1`,
    [made[2], '2026-09-05T10:00:00Z']);

  const d = (await load(u.id)).data;
  assert.deepEqual(d.archived.map((x) => x.title), ['third', 'first', 'second'],
    'the page shows the last eight and says how many it hides — "last" has to mean finished-at');
});

test('a task finished from chat can still be put back on the list', async () => {
  // The archive draws a way back on every row in it. Offering one over a task
  // the server would refuse to restore is the same bug wearing the other shoe.
  const r = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'להחזיר מהצאט' }));
  await withTx(db.pool, (c) => tasks.completeTask(c, me.id, r.data.task.id));
  const back = await withTx(db.pool, (c) => tasks.unarchiveTask(c, me.id, r.data.task.id));
  assert.equal(back.ok, true, back.ok ? '' : JSON.stringify(back.error));

  const d = (await load(me.id)).data;
  const row = d.tasks.find((x) => x.id === r.data.task.id);
  assert.ok(row, 'back on the open list');
  assert.equal(row.done, false, 'and open, not back-and-already-ticked');
});

test('a task somebody shared with me is on my list too, and marked as theirs', async () => {
  const shares = require('../src/domain/shares');
  const t = await withTx(db.pool, (c) =>
    tasks.addTask(c, friend.id, { title: 'לסיים את המצגת' }));
  assert.equal(t.ok, true, t.ok ? '' : JSON.stringify(t.error));
  const offer = await withTx(db.pool, (c) =>
    shares.offerShare(c, friend.id, t.data.task.id, me.id, 'editor'));
  assert.equal(offer.ok, true, offer.ok ? '' : JSON.stringify(offer.error));
  await withTx(db.pool, (c) => shares.respondToShare(c, me.id, offer.data.share.id, 'accept'));

  const d = (await load(me.id)).data;
  const row = d.tasks.find((x) => String(x.id) === String(t.data.task.id));
  assert.ok(row, 'a task shared with me was missing from my own list entirely');
  assert.equal(row.mine, false, "somebody else's task was presented as mine");
  assert.equal(String(row.owner), String(friend.id));
  assert.equal(row.sharedRole, 'editor');

  // And it is still on THEIR list, as theirs — one row, two lists.
  const theirs = (await load(friend.id)).data.tasks
    .find((x) => String(x.id) === String(t.data.task.id));
  assert.equal(theirs.mine, true);
  assert.equal(theirs.sharedRole, null, 'owning something is not a role granted to you');
});

// The page keeps a seeded profile for the design copy and re-reads it on every
// render, so anything the payload omits stays as the fixture. The fixture is
// the owner's own name — which is exactly why this survived the first real
// phone: it read perfectly for one person, and would have greeted everybody
// else as him.
test('the payload carries the whole name, and Olma\'s own', async () => {
  const u = await makeUser(db.pool, '+972531920077',
    { firstName: 'שרה', lastName: 'בן־חיים' });
  await withTx(db.pool, (c) => c.query(
    `UPDATE users SET assistant_name = 'נועה' WHERE id = $1`, [u.id]));
  const res = await withTx(db.pool, (c) => dash.load(c, u.id));
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.user.firstName, 'שרה');
  assert.equal(res.data.user.lastName, 'בן־חיים',
    'the surname never reaches the page, so the seeded one stays on screen');
  assert.equal(res.data.user.assistantName, 'נועה',
    'a renamed Olma is still called עולמה on her own dashboard');
});
