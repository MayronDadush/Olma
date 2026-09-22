'use strict';
// A standing nudge on a dateless task defaults to the hour that person already
// hears from Olma in the morning, and at that hour it arrives WITH the morning
// picture rather than as a second message behind it (owner, 2026-09-20:
// "שיקבל את זה ביחד איתם, לא הודעה נפרדת").
//
// The digest DRAWS it. That is not a detail of layout — it is the only way to
// honour the ask without breaking the boundary message-merge.js states in its
// own header: a reminder is never folded into a composed turn, because handing
// the one sentence somebody asked for to a model that may reword or drop it
// leaves the row stamped delivered all the same. Drawn text is relayed
// verbatim; woven text is not.
//
// The founding shape is Miron's own: digest at 09:35, four tasks with no date
// that should keep coming back — "לקבוע עם מיכאל", "ריצות בים", "להזכיר לאבא",
// "פתיח ספק בכפר סבא".
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { sweepReminders, sweepDigests } = require('../src/jobs/sweeps');
const reminders = require('../src/domain/reminders');
const preferences = require('../src/domain/preferences');
const digest = require('../src/domain/digest');
const digestBlock = require('../src/domain/digest-block');

// Pinned, never "now": 09:35 Asia/Jerusalem is 06:35Z through September, and a
// test that computes its own morning is a test that means something different
// at 23:00 (rules, "Never let a test depend on the hour it runs").
const MORNING = '2026-09-21T06:35:00Z';   // Mon 09:35 Asia/Jerusalem
const TZ = 'Asia/Jerusalem';

let db, user;

before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000940', { firstName: 'Miron' });
  await db.pool.query(
    `UPDATE users SET digest_times = '09:35', digest_scope = 'summary',
       timezone = $2, onboarded_at = now() WHERE id = $1`,
    [user.id, TZ]
  );
});
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.pool.query('DELETE FROM outbox WHERE user_id = $1', [user.id]);
  await db.pool.query(
    'DELETE FROM task_reminders WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = $1)', [user.id]);
  await db.pool.query('DELETE FROM tasks WHERE owner_id = $1', [user.id]);
});

// A dateless task with a weekly nudge at the digest hour — the exact row the
// page writes when somebody flips the switch and changes nothing else.
async function nudgedTask(title, { at = MORNING, repeat = 'weekly', dueAt = null } = {}) {
  const { rows } = await db.pool.query(
    `INSERT INTO tasks (owner_id, title, status, due_at) VALUES ($1, $2, 'open', $3) RETURNING id`,
    [user.id, title, dueAt]
  );
  await db.pool.query(
    `INSERT INTO task_reminders (task_id, remind_at, repeat_rule, auto, user_id)
     VALUES ($1, $2, $3, false, $4)`,
    [rows[0].id, at, repeat, user.id]
  );
  return Number(rows[0].id);
}

const tick = async (now = MORNING) => {
  // The real order, and it is load-bearing: the reminder sweep will only hand
  // a nudge over when it can SEE the digest row waiting (jobs/registry.js).
  const digests = await withTx(db.pool, (c) => sweepDigests(c, new Date(now)));
  const sent = await withTx(db.pool, (c) => sweepReminders(c, now));
  return { digests, sent };
};

// ---- the predicate, on its own ---------------------------------------------

test('only a dateless, repeating nudge at one of their digest hours rides', () => {
  const base = { dueAt: null, repeatRule: 'weekly', remindAt: MORNING, timezone: TZ, digestTimes: '09:35' };
  assert.equal(reminders.ridesDigest(base), true);
  // A dated task's reminder is ABOUT a moment, and arriving at it is the point.
  assert.equal(reminders.ridesDigest({ ...base, dueAt: '2026-09-22T09:00:00Z' }), false);
  // A one-off is a moment they named, exactly like a dated one.
  assert.equal(reminders.ridesDigest({ ...base, repeatRule: null }), false);
  // Somebody who moved their nudge to 18:00 asked for a message at 18:00, and
  // a digest at 09:35 is not it. Near is not the same hour.
  assert.equal(reminders.ridesDigest({ ...base, digestTimes: '09:30' }), false);
  assert.equal(reminders.ridesDigest({ ...base, digestTimes: '' }), false);
  assert.equal(reminders.ridesDigest({ ...base, digestTimes: null }), false);
  // The hour is THEIRS, so the zone decides it. 06:35Z is 09:35 in Jerusalem
  // and 02:35 in New York, and only one of those is a digest hour here.
  assert.equal(reminders.ridesDigest({ ...base, timezone: 'America/New_York' }), false);
  // Several digest times, one of them the nudge's.
  assert.equal(reminders.ridesDigest({ ...base, digestTimes: ['07:00', '09:35'] }), true);
});

// ---- end to end -------------------------------------------------------------

test('at the digest hour the nudge is carried, not sent as its own message', async () => {
  const taskId = await nudgedTask('לקבוע עם מיכאל');
  await tick();

  const { rows: rem } = await db.pool.query(
    `SELECT kind FROM outbox WHERE user_id = $1 AND kind = 'reminder'`, [user.id]);
  assert.equal(rem.length, 0, 'the nudge must not be a second message');
  const { rows: dig } = await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND kind = 'digest'`, [user.id]);
  assert.equal(dig.length, 1, 'the digest itself still goes out');

  // Stamped as carried, and retired the way a delivered occurrence is — a
  // repeating reminder never climbs a ladder, so there is nothing to follow.
  const { rows: r } = await db.pool.query(
    `SELECT carried_at, sent_at FROM task_reminders
      WHERE task_id = $1 ORDER BY id LIMIT 1`, [taskId]);
  assert.ok(r[0].carried_at, 'the occurrence says the digest has it');
  assert.ok(r[0].sent_at, 'and is retired, so the sweep does not visit it again');

  // The recurrence continues: next week, same hour. Without this the feature
  // would quietly be a one-off, which is the bug normalizeRepeatRule exists for.
  const { rows: next } = await db.pool.query(
    `SELECT remind_at FROM task_reminders
      WHERE task_id = $1 AND carried_at IS NULL AND sent_at IS NULL`, [taskId]);
  assert.equal(next.length, 1, 'the next occurrence is spawned');
  assert.equal(
    new Date(next[0].remind_at).getTime() - new Date(MORNING).getTime(),
    7 * 24 * 3600_000, 'a week on, at the same hour'
  );

  // And the durable record of why no reminder went out.
  const { rows: a } = await db.pool.query(
    `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = 'reminder.carried_by_digest'`,
    [user.id]);
  assert.equal(a.length, 1);
});

test('the digest draws it, on summary scope, where there is no list at all', async () => {
  await nudgedTask('ריצות בים פעמיים בשבוע');
  await tick();

  const res = await withTx(db.pool, (c) => digest.assemble(c, user.id, 'summary'));
  assert.ok(res.ok);
  assert.equal(res.data.nudges.length, 1, 'summary carries the nudge — it is not a count');
  assert.equal(res.data.nudges[0].title, 'ריצות בים פעמיים בשבוע');
  assert.equal(res.data.tasks, undefined, 'and still no list: the scope is unchanged');

  const block = digestBlock.renderDigestBlock(res.data, { locale: 'he', timezone: TZ });
  assert.ok(block, 'a morning with only a nudge is still a block');
  assert.match(block, /ממשיך לחכות/);
  assert.match(block, /ריצות בים פעמיים בשבוע/);

  const en = digestBlock.renderDigestBlock(res.data, { locale: 'en', timezone: TZ });
  assert.match(en, /Still waiting/);
});

// The row is the link, not a clock, and this is what that buys: once the
// digest has gone out the nudge stops being drawn. Otherwise somebody asking
// "מה יש לי היום" an hour later would be read the same standing job again, off
// an occurrence that was already carried — the "same thing twice" rule, from
// the one direction no repeat-guard watches.
test('once the digest has gone out, the nudge is no longer drawn', async () => {
  await nudgedTask('לקבוע עם מיכאל');
  await tick();
  const before = await withTx(db.pool, (c) => digest.assemble(c, user.id, 'summary'));
  assert.equal(before.data.nudges.length, 1);

  await db.pool.query(
    `UPDATE outbox SET sent_at = now() WHERE user_id = $1 AND kind = 'digest'`, [user.id]);

  const after = await withTx(db.pool, (c) => digest.assemble(c, user.id, 'summary'));
  assert.equal(after.data.nudges.length, 0, 'the message that carried it has landed');
});

// The card draws a DAY and has no row for a job with no date, so a morning
// carrying a nudge keeps the block whatever the threshold says. Otherwise the
// nudge disappears into a picture that was never asked to hold it, on a row
// already stamped as the message that carried it.
test('a card never replaces a block that is carrying a nudge', () => {
  assert.equal(digestBlock.drawInsteadOfBlock(5, 3), true);
  assert.equal(digestBlock.drawInsteadOfBlock(5, 3, { hasNudges: true }), false);
});

// The safety valve, and the reason the sweeps were reordered. A nudge handed to
// a digest that is not there reaches nobody, and it would do so in silence.
test('with no digest waiting, the nudge is an ordinary message', async () => {
  await nudgedTask('להזכיר לאבא');
  // The reminder sweep alone — no digest was enqueued this tick.
  const sent = await withTx(db.pool, (c) => sweepReminders(c, MORNING));
  assert.equal(sent.length, 1);
  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'reminder'`, [user.id]);
  assert.equal(rows.length, 1, 'it goes out on its own rather than vanishing');
  assert.equal(rows[0].payload.title, 'להזכיר לאבא');
});

// The hour is the discriminator and nothing else is. Somebody who moved the
// nudge off their digest hour asked for a message at the hour they picked.
test('a nudge at another hour is still its own message', async () => {
  await nudgedTask('פתיח ספק בכפר סבא', { at: '2026-09-21T15:00:00Z' }); // 18:00 local
  await tick('2026-09-21T15:00:00Z');
  const { rows } = await db.pool.query(
    `SELECT kind FROM outbox WHERE user_id = $1 AND kind = 'reminder'`, [user.id]);
  assert.equal(rows.length, 1);
});

// The two branches of this sweep each arm the next occurrence, and for one
// rebase they did it with two copies of the same INSERT — the carry path
// keeping the plain `nextOccurrence` while the ordinary path had learned the
// quiet-day rule. A nudge is dateless and repeating, which is exactly the
// shape that rule can move, so the copy that forgot it was the one that runs
// for the feature this file is about. Both go through
// `sweeps.armNextOccurrence` now, and this is what would notice if they
// stopped.
test('a nudge the digest carried arms its next occurrence off a quiet day too', async () => {
  await withTx(db.pool, (c) => preferences.remember(c, user.id, 'quiet_days', 'mon'));
  try {
    // MORNING is a Monday, and a bare weekly returns to Monday for ever.
    const taskId = await nudgedTask('לחדש את הדרכון', { repeat: 'weekly' });
    await tick();

    const { rows: next } = await db.pool.query(
      `SELECT remind_at FROM task_reminders
        WHERE task_id = $1 AND carried_at IS NULL AND sent_at IS NULL`, [taskId]);
    assert.equal(next.length, 1, 'the next occurrence is spawned');
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(new Date(next[0].remind_at));
    assert.equal(day, 'Tue 09:35', 'moved off their Monday, at the hour they asked for');

    const { rows: a } = await db.pool.query(
      `SELECT 1 FROM audit_log WHERE actor_id = $1 AND event = 'reminder.moved_off_quiet_day'`, [user.id]);
    assert.equal(a.length, 1);
  } finally {
    await withTx(db.pool, (c) => preferences.remember(c, user.id, 'quiet_days', 'none'));
  }
});
