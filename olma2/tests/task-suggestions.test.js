'use strict';
// The hand triage as a feature, and the rows that decided its shape.
//
// Two things this file is for. The first is the ordinary one: every detector
// in `domain/task-suggestions.js` is asserted with a case it must fire on and
// a case it must stay quiet about, because a suggestion that fires on an
// ordinary task is worse than no suggestion at all (`rules/detectors.md`).
//
// The second is the REJECTED fourth detector. The owner asked for four kinds
// and three shipped; "several tasks that want to be one list" was measured
// against the live box on 2026-09-19 and thrown away, because grouping by a
// shared word found three groups across three people and all three were
// wrong. Those nine real titles are at the bottom, saved as real tasks, with
// an assertion that nothing proposes anything about them — so anybody who
// rebuilds that detector has to beat the rows that killed it first.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const shares = require('../src/domain/shares');
const similarity = require('../src/domain/task-similarity');
const suggestions = require('../src/domain/task-suggestions');

// Computed once, never from the clock this run happens to start at: several
// assertions below hold a stored date against this exact moment.
const NOW = new Date('2026-06-15T09:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400_000);
const iso = (d) => d.toISOString();

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const c = await db.pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

let seq = 0;
async function person(extra = {}) {
  seq += 1;
  return makeUser(db.pool, '+9725419' + String(100000 + seq).slice(1), { firstName: 'P' + seq, ...extra });
}

// A task as it would look after sitting there for `age` days. addTask stamps
// created_at from the clock, so the age is written on afterwards — the only
// honest way to build a fourteen-day-old row inside a test.
async function aged(client, userId, title, age, extra = {}) {
  const res = await tasks.addTask(client, userId, { title, now: NOW, ...extra });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const id = res.data.task.id;
  await client.query(`UPDATE tasks SET created_at = $2 WHERE id = $1`, [id, daysAgo(age)]);
  return id;
}

// The second half of the one true duplicate pair on the box: the packing list
// asked for as a reminder. It is quoted once and used in three places, because
// a title retyped is a title that drifts.
const REMINDER_WORDING = 'להזכיר לי מחר בבוקר ב-9 עם רשימת האריזה לתיק לבית חולים';

const idsOf = (list) => list.map((c) => c.taskIds[0]);

// ---- stuck -----------------------------------------------------------------

test('stuck: old, undated, unreminded — and the three things that make it not stuck', async () => {
  await withClient(async (c) => {
    const me = await person();
    const friend = await person();
    const stuck = await aged(c, me.id, 'לסדר את המוסך', 30);
    const young = await aged(c, me.id, 'לקנות מתנה', 3);
    const dated = await aged(c, me.id, 'להגיש את הטופס', 30, { dueAt: iso(daysAgo(-2)) });
    const chased = await aged(c, me.id, 'לדבר עם רואה החשבון', 30);
    const event = await aged(c, me.id, 'חתונה של דנה', 30, { kind: 'event' });
    const together = await aged(c, me.id, 'לצבוע את הסלון', 30);

    await reminders.setReminder(c, me.id, chased, iso(daysAgo(-1)), null);

    const conn = await connections.requestConnection(c, me.id, friend.phone, {});
    const approved = await connections.respondToConnection(c, friend.id, conn.data.connection.id, 'approve');
    await grants.grantFeature(c, me.id, approved.data.connection.id, 'sharing');
    await grants.grantFeature(c, friend.id, approved.data.connection.id, 'sharing');
    const offer = await shares.offerShare(c, me.id, together, friend.id);
    await shares.respondToShare(c, friend.id, offer.data.share.id, 'accept');

    const found = await suggestions.stuckTasks(c, me.id, NOW);
    assert.deepEqual(idsOf(found), [stuck]);
    assert.equal(found[0].detail.days, 30);
    // named so a failure says WHICH exemption broke
    for (const [why, id] of [['young', young], ['dated', dated], ['chased', chased],
      ['event', event], ['shared', together]]) {
      assert.equal(idsOf(found).includes(id), false, why + ' should not be stuck');
    }
  });
});

// ---- overdue ---------------------------------------------------------------

test('overdue: a week past its date, unless the date is a rhythm', async () => {
  await withClient(async (c) => {
    const me = await person();
    const late = await aged(c, me.id, 'להחזיר את הספר לספרייה', 20, { dueAt: iso(daysAgo(10)) });
    const barely = await aged(c, me.id, 'לשלוח את החשבונית', 20, { dueAt: iso(daysAgo(2)) });
    const rhythm = await aged(c, me.id, 'לשלם ועד בית', 60, { dueAt: iso(daysAgo(30)) });
    await reminders.setReminder(c, me.id, rhythm, iso(daysAgo(-1)), 'monthly');

    const found = await suggestions.overdueTasks(c, me.id, NOW);
    assert.deepEqual(idsOf(found), [late]);
    assert.equal(found[0].detail.days, 10);
    assert.equal(idsOf(found).includes(barely), false, 'two days past is not overdue');
    assert.equal(idsOf(found).includes(rhythm), false, 'a repeating reminder is a rhythm');
  });
});

// ---- duplicate -------------------------------------------------------------

test('duplicate: the live pair from the box, and the older row is the one that stays', async () => {
  await withClient(async (c) => {
    const me = await person();
    // The one real hit on 2026-09-19, both titles exactly as they are on the
    // box: a packing list saved as itself, and again as the sentence asking to
    // be reminded about it.
    const first = await aged(c, me.id, 'לארוז תיק לבית חולים', 9);
    const second = await aged(c, me.id, REMINDER_WORDING, 2);

    const found = await suggestions.duplicateTasks(c, me.id);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].taskIds, [second], 'the newer row is the accident');
    assert.equal(found[0].detail.keepId, first);
    assert.equal(found[0].detail.keepTitle, 'לארוז תיק לבית חולים');
  });
});

test('duplicate says nothing about two tasks that merely rhyme', async () => {
  await withClient(async (c) => {
    const me = await person();
    await aged(c, me.id, 'לקנות חלב', 5);
    await aged(c, me.id, 'לקנות מתנה לאמא', 5);
    assert.deepEqual(await suggestions.duplicateTasks(c, me.id), []);
  });
});

// ---- the pass --------------------------------------------------------------

test('once a week, and the stamp moves even on a week with nothing to say', async () => {
  await withClient(async (c) => {
    const me = await person();
    const quiet = await suggestions.refresh(c, me.id, { now: NOW });
    assert.equal(quiet.data.ran, true);
    assert.equal(quiet.data.added, 0);

    // something to say arrives the next day, and is not said
    await aged(c, me.id, 'לסדר את הארגז בממ״ד', 30);
    const soon = await suggestions.refresh(c, me.id, { now: new Date(NOW.getTime() + 86400_000) });
    assert.equal(soon.data.ran, false);
    assert.equal(soon.data.reason, 'too_soon');
    assert.equal(await suggestions.nextFor(c, me.id), null);

    const week = new Date(NOW.getTime() + suggestions.EVERY_MS + 1000);
    const later = await suggestions.refresh(c, me.id, { now: week });
    assert.equal(later.data.added, 1);
    assert.equal((await suggestions.nextFor(c, me.id)).kind, 'stuck');
  });
});

test('three ready at most, one of each kind before a second of any', async () => {
  await withClient(async (c) => {
    const me = await person();
    // Four unrelated stale tasks. Unrelated on purpose: four titles differing
    // by a digit are a duplicate PAIR to the scorer, and the fixture would
    // then be testing itself rather than the interleave.
    const STALE = ['לסדר את המוסך', 'להחליף נורה במטבח', 'לבטל מנוי לחדר כושר', 'לצלם תעודת זהות'];
    for (let i = 0; i < STALE.length; i++) await aged(c, me.id, STALE[i], 30 + i);
    await aged(c, me.id, 'להחזיר ציוד', 20, { dueAt: iso(daysAgo(12)) });
    await aged(c, me.id, 'לארוז תיק לבית חולים', 9);
    await aged(c, me.id, REMINDER_WORDING, 2);

    const res = await suggestions.refresh(c, me.id, { now: NOW });
    assert.equal(res.data.added, suggestions.MAX_LIVE);
    const { rows } = await c.query(
      `SELECT kind FROM task_suggestions WHERE user_id = $1 AND decided_at IS NULL ORDER BY id`, [me.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['duplicate', 'overdue', 'stuck']);
    // and the page still shows exactly one
    const one = await suggestions.nextFor(c, me.id);
    assert.equal(one.kind, 'duplicate');
    assert.equal(one.keepTitle, 'לארוז תיק לבית חולים');
  });
});

test('אשר archives, and the task can be restored afterwards', async () => {
  await withClient(async (c) => {
    const me = await person();
    const id = await aged(c, me.id, 'לפרק את הקרטונים', 40);
    await suggestions.refresh(c, me.id, { now: NOW });
    const s = await suggestions.nextFor(c, me.id);

    const done = await suggestions.decide(c, me.id, s.id, 'accept', { now: NOW });
    assert.equal(done.ok, true);
    assert.deepEqual(done.data.archived, [id]);
    const { rows } = await c.query(`SELECT archived_at FROM tasks WHERE id = $1`, [id]);
    assert.notEqual(rows[0].archived_at, null);
    assert.equal(await suggestions.nextFor(c, me.id), null);

    // the way back is the one they already have (`user-dashboard-write.restoreTask`)
    assert.equal((await tasks.unarchiveTask(c, me.id, id)).ok, true);
  });
});

test('דלג decides it, and the same condition is never put to them twice', async () => {
  await withClient(async (c) => {
    const me = await person();
    const id = await aged(c, me.id, 'לבדוק את הביטוח', 40);
    await suggestions.refresh(c, me.id, { now: NOW });
    const s = await suggestions.nextFor(c, me.id);
    assert.equal((await suggestions.decide(c, me.id, s.id, 'skip', { now: NOW })).ok, true);
    assert.equal(await suggestions.nextFor(c, me.id), null);

    // the task is untouched, and a later pass does not raise it again
    const { rows } = await c.query(`SELECT status, archived_at FROM tasks WHERE id = $1`, [id]);
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0].archived_at, null);
    const again = await suggestions.refresh(c, me.id, {
      now: new Date(NOW.getTime() + suggestions.EVERY_MS + 1000),
    });
    assert.equal(again.data.added, 0);
    assert.equal(await suggestions.nextFor(c, me.id), null);
  });
});

test('a suggestion whose task they dealt with themselves goes stale, unasked', async () => {
  await withClient(async (c) => {
    const me = await person();
    const id = await aged(c, me.id, 'להחליף את הצמיג', 40);
    await suggestions.refresh(c, me.id, { now: NOW });
    assert.notEqual(await suggestions.nextFor(c, me.id), null);

    assert.equal((await tasks.completeTask(c, me.id, id)).ok, true);
    assert.equal(await suggestions.nextFor(c, me.id), null, 'the page stops showing it at once');

    await suggestions.refresh(c, me.id, { now: new Date(NOW.getTime() + suggestions.EVERY_MS + 1000) });
    const { rows } = await c.query(
      `SELECT decision FROM task_suggestions WHERE user_id = $1`, [me.id]);
    assert.deepEqual(rows.map((r) => r.decision), ['stale']);
  });
});

test('a decision belongs to its own person', async () => {
  await withClient(async (c) => {
    const me = await person();
    const other = await person();
    await aged(c, me.id, 'לסדר את המחסן', 40);
    await suggestions.refresh(c, me.id, { now: NOW });
    const s = await suggestions.nextFor(c, me.id);
    const stolen = await suggestions.decide(c, other.id, s.id, 'accept', { now: NOW });
    assert.equal(stolen.ok, false);
    assert.equal(stolen.error.code, 'not_found');
    assert.equal((await suggestions.decide(c, me.id, s.id, 'maybe', { now: NOW })).error.code, 'invalid');
  });
});

test('the sweep skips a paused person and the eval user', async () => {
  await withClient(async (c) => {
    const me = await person();
    const paused = await person();
    const evalUser = await person();
    for (const u of [me, paused, evalUser]) await aged(c, u.id, 'לסדר את הגינה', 40);
    await c.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [paused.id]);
    await c.query(`UPDATE users SET is_eval = true WHERE id = $1`, [evalUser.id]);

    await suggestions.sweepSuggestions(c, { now: NOW });
    assert.notEqual(await suggestions.nextFor(c, me.id), null);
    assert.equal(await suggestions.nextFor(c, paused.id), null);
    assert.equal(await suggestions.nextFor(c, evalUser.id), null);
  });
});

// ---- the detector that was REJECTED ----------------------------------------
//
// "רשימה שמתבקשת" — several tasks that want to be one list with items. The
// owner asked for it; the box refused it. Grouping open tasks by a shared word
// produced exactly three groups across three real people on 2026-09-19, and
// all three are below, verbatim. Each shares a word and nothing else: two
// share a VERB that half of every task list starts with, and the third shares
// a noun that means a different building in each row.
//
// One pair INSIDE the third group is genuinely the same thing — the packing
// list, which is the duplicate detector's one live hit — and that is the whole
// argument in one place: a pairwise scorer calibrated on 86 labelled pairs
// finds it, and the grouping reading buries it under "סדר בבית", which is a
// different house. A detector built on shared words has to get past these
// rows first.
const REJECTED_GROUPS = [
  ['לעשות למאיה תיאום מס', 'דברים שצריך לעשות ביחד עם מאיה', 'לעשות פתיח ספק בעיריית כפר סבא'],
  ['לבדוק על שחיינים ששחו בעבר', 'לבדוק משימות למרוץ', 'לבדוק משימות נוספות שיש לי'],
  ['סדר בבית', 'לארוז תיק לבית חולים', REMINDER_WORDING],
];
// The one pair in all nine titles that IS the same thing.
const REAL_PAIR = ['לארוז תיק לבית חולים', REMINDER_WORDING];

test('the rejected fourth detector: nine real tasks, and the one honest thing to say about them', async () => {
  await withClient(async (c) => {
    const me = await person();
    for (const group of REJECTED_GROUPS) {
      for (const title of group) await aged(c, me.id, title, 2);
    }
    // Two days old, undated, unreminded — ordinary input, which is what a
    // suggestion may never fire on.
    assert.deepEqual(await suggestions.stuckTasks(c, me.id, NOW), []);
    assert.deepEqual(await suggestions.overdueTasks(c, me.id, NOW), []);

    // Not one group among the nine. The only proposal is the real pair, and
    // "סדר בבית" — the row the shared-word reading would have dragged in with
    // it — is not in it.
    const dup = await suggestions.duplicateTasks(c, me.id);
    assert.equal(dup.length, 1);
    assert.equal(dup[0].detail.title, REMINDER_WORDING);
    assert.equal(dup[0].detail.keepTitle, 'לארוז תיק לבית חולים');

    const res = await suggestions.refresh(c, me.id, { now: NOW });
    assert.equal(res.data.added, 1, 'nine tasks, one proposal, and it is a pair');
    const shown = await suggestions.nextFor(c, me.id);
    assert.equal(shown.kind, 'duplicate');
    assert.equal(shown.taskIds.length, 1, 'a suggestion names one task, never a group');
  });
});

test('every pair in the rejected groups is refused, except the one that is real', () => {
  const same = [];
  for (const group of REJECTED_GROUPS) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (similarity.compare(group[i], group[j]).same === true) same.push([group[i], group[j]]);
      }
    }
  }
  assert.deepEqual(same, [REAL_PAIR]);
});

test('the kinds the module offers are the three that were kept', () => {
  assert.deepEqual(suggestions.KINDS, ['stuck', 'overdue', 'duplicate']);
});

// A list is not a stalled task. Found by running these queries against the box
// before they shipped: Miron's stuck query returned seven rows and two of them
// were lists — "רעיונות לשיפור אולמה" with eleven open items under it and
// "קניות לבית" with two. Both are old, dateless and unreminded, because that is
// exactly what a list somebody keeps looks like, and archiving one takes its
// items with it.
test('a list with open items under it is never proposed, by any detector', async () => {
  await withClient(async (c) => {
    const me = await person();
    const list = await aged(c, me.id, 'רעיונות לשיפור אולמה', 40);
    const dated = await aged(c, me.id, 'קניות לבית', 40, { dueAt: iso(daysAgo(20)) });
    const plain = await aged(c, me.id, 'לפרק את המדף', 40);
    for (const parent of [list, dated]) {
      const item = await tasks.addTask(c, me.id, { title: 'פריט ' + parent, parentId: parent, now: NOW });
      assert.equal(item.ok, true, item.ok ? '' : JSON.stringify(item.error));
    }

    assert.deepEqual(idsOf(await suggestions.stuckTasks(c, me.id, NOW)), [plain]);
    assert.deepEqual(await suggestions.overdueTasks(c, me.id, NOW), []);

    // What makes it a list is having something in it, not what it is called —
    // so an emptied one is an ordinary row again. Emptied by ARCHIVING the
    // item: ticking the last one off closes the list itself, which is the
    // page's own behaviour and takes it out of every detector anyway.
    const { rows } = await c.query(`SELECT id FROM tasks WHERE parent_id = $1`, [list]);
    assert.equal((await tasks.archiveTask(c, me.id, Number(rows[0].id))).ok, true);
    assert.deepEqual(idsOf(await suggestions.stuckTasks(c, me.id, NOW)).sort((a, b) => a - b),
      [list, plain].sort((a, b) => a - b));
  });
});
