'use strict';
// The owner's rule, 2026-09-22: "אם זה לא תזכורת ספציפית ליום שבת - אז היא לא
// צריכה להגיע כמו שהמשימות של הדיגסט בוקר לא מגיעות."
//
// Three sentences, and all three are asserted below:
//
//   * "תזכיר לי כל יום ב7"     → arrives, Saturday included: "כי זה יכול
//     להיות תרופה או משהו חשוב", and his own two daily rows are a thyroid
//     pill and a refund run.
//   * "תזכיר לי כל ה16 בחודש"  → arrives on the 16th wherever it lands:
//     "אם זה נופל על שבת שיהיה על שבת". His monthly:16 is also a pill.
//   * "תזכיר לי כל שבוע בשבת"  → every Saturday. The rule pins the weekday.
//   * "תזכיר לי כל שבוע", said on a Saturday → the ONE shape that moves, and
//     the only one whose quiet day nobody chose. It goes to Sunday, and the
//     series carries on from there — the migration he was shown and picked
//     over pinning the day (an exemption nobody asked for) and over skipping
//     (a reminder that never arrives).
//   * A quiet day is a property of the PERSON. Somebody whose Saturday is an
//     ordinary day is untouched, and somebody whose Friday is quiet gets the
//     same treatment on a Friday.
//
// The shift is a SCHEDULING decision, made at spawn, and the reason it cannot
// be the gate's is in `domain/quiet-facts.keptMomentFor`: a repeating reminder
// is always rung 1, and rung 1 expires at `remind_at + 2h`, so a hold over
// Shabbat deletes the message instead of delaying it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const preferences = require('../src/domain/preferences');
const quietFacts = require('../src/domain/quiet-facts');
const sweeps = require('../src/jobs/sweeps');

// London rather than Jerusalem wherever the Shabbat WINDOW is not the point:
// outside Israel a quiet Saturday is the plain calendar day, so these
// assertions do not move with candle-lighting. The window has its own test at
// the bottom, on the zone the live users are actually in.
const TZ = 'Europe/London';
// 2026: Fri 25 Sep, Sat 26 Sep, Sun 27 Sep, Mon 28 Sep. Every moment below is
// a literal, computed once, never off the clock this run starts at.
const SAT_10 = '2026-09-26T09:00:00.000Z';     // Saturday 10:00 London
const SUN_10 = '2026-09-27T09:00:00.000Z';
const WED_10 = '2026-09-23T09:00:00.000Z';
const FRI_10 = '2026-09-25T09:00:00.000Z';

const local = (tz, iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

let seq = 0;
async function person(pool, { quiet = 'sat', timezone = TZ } = {}) {
  seq += 1;
  const u = await makeUser(pool, '+4477000' + String(10000 + seq).slice(1), { timezone, locale: 'en' });
  await withTx(pool, (c) => preferences.remember(c, u.id, 'quiet_days', quiet));
  return u;
}

const who = (u) => ({ id: u.id, timezone: u.timezone, locale: u.locale });

// ---- the predicate itself ---------------------------------------------------

test('a moment on a day they keep moves to the next one they do not, same local hour', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const kept = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), SAT_10));
    assert.equal(local(TZ, kept.at), local(TZ, SUN_10));
    assert.equal(kept.movedFrom.toISOString(), SAT_10);
    assert.equal(kept.reason, 'quiet_day');
    // The HOUR is the promise, and it survives.
    assert.match(local(TZ, kept.at), /10:00$/);
  } finally { await teardown(); }
});

test('only a rule that pins NOTHING is moved at all', () => {
  // The carve-outs the owner made after reading the rule against his own
  // list. A routine set for every day, or for a date, is a commitment — and a
  // quiet day is not a reason to break it.
  assert.equal(reminders.movesOffQuietDay('daily'), false, 'a pill at seven is a pill on Saturday too');
  assert.equal(reminders.movesOffQuietDay('monthly:16'), false, 'the 16th is the 16th');
  assert.equal(reminders.movesOffQuietDay('monthly:last'), false);
  assert.equal(reminders.movesOffQuietDay('weekly:SA'), false, 'they named Saturday; Saturday is what they get');
  assert.equal(reminders.movesOffQuietDay('weekly:MO,TH'), false);
  assert.equal(reminders.movesOffQuietDay(null), false, 'a one-off is never moved');
  assert.equal(reminders.movesOffQuietDay('gibberish'), false, 'an unrecognised rule stores a one-off');
  // …and the one that does.
  assert.equal(reminders.movesOffQuietDay('weekly'), true);
  assert.equal(reminders.movesOffQuietDay('שבועי'), true, 'the Hebrew word normalises to the same bare rule');
  assert.equal(reminders.movesOffQuietDay('FREQ=WEEKLY'), true);
});

test('a day they keep is a property of the PERSON, not of the weekday', async () => {
  const { pool, teardown } = await freshDb();
  try {
    // Saturday is an ordinary day for this one — nothing to do.
    const none = await person(pool, { quiet: 'none' });
    const kept = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(none), SAT_10));
    assert.equal(kept.at.toISOString(), SAT_10);
    assert.equal(kept.movedFrom, null);

    // …and somebody who keeps Friday AND Saturday is carried across both,
    // which is the reason this walks day by day instead of adding 24 hours.
    const both = await person(pool, { quiet: 'fri,sat' });
    const across = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(both), FRI_10));
    assert.equal(local(TZ, across.at), local(TZ, SUN_10), 'Friday → Sunday, over the whole run');
  } finally { await teardown(); }
});

test('a moment already on a kept day is returned untouched', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const kept = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), WED_10));
    assert.equal(kept.at.toISOString(), WED_10);
    assert.equal(kept.movedFrom, null);
    assert.equal(kept.reason, null);
  } finally { await teardown(); }
});

// ---- what the rule vocabulary can and cannot say ----------------------------

test('naming the weekday is what keeps it, so the model is told to do that', () => {
  // "כל שבוע בשבת" must reach the DB as weekly:SA and not as a bare weekly on
  // a Saturday, or the person who asked for Saturdays gets Sundays. The tool
  // schema says so in as many words; this pins the normaliser that has to
  // understand the answer.
  assert.equal(reminders.normalizeRepeatRule('FREQ=WEEKLY;BYDAY=SA'), 'weekly:SA');
  assert.equal(reminders.normalizeRepeatRule('weekly:SA'), 'weekly:SA');
  assert.equal(reminders.normalizeRepeatRule('שבועי'), 'weekly', 'the bare Hebrew word pins no day, and must not pretend to');
});

// ---- the first occurrence ---------------------------------------------------

let title = 0;
async function armed(pool, user, at, rule) {
  // A distinct title every time: the same thing OPEN on one list twice is
  // refused by design (rules/reminders-and-tasks.md), and a fixture that
  // reuses one is testing that rule instead of this one.
  title += 1;
  const taskId = await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לעבור על המיילים ' + title });
    const r = await reminders.setReminder(c, user.id, t.data.task.id, at, rule);
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
    return t.data.task.id;
  });
  const { rows } = await pool.query(
    `SELECT remind_at, repeat_rule FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL`, [taskId]);
  assert.equal(rows.length, 1);
  return { taskId, at: rows[0].remind_at.toISOString(), rule: rows[0].repeat_rule };
}

test('everything that pins a slot is armed exactly where it landed', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    // They named Saturday.
    const named = await armed(pool, u, SAT_10, 'FREQ=WEEKLY;BYDAY=SA');
    assert.equal(named.rule, 'weekly:SA');
    assert.equal(named.at, SAT_10);

    // A pill at seven, every day. The owner's first carve-out, and the reason
    // for it in his own words: "כי זה יכול להיות תרופה או משהו חשוב".
    const pill = await armed(pool, u, SAT_10, 'daily');
    assert.equal(pill.at, SAT_10, 'a daily routine is not broken by a quiet day');

    // The 26th of the month, which in September 2026 is a Saturday. His
    // second carve-out: "אם זה נופל על שבת שיהיה על שבת".
    const monthly = await armed(pool, u, SAT_10, 'monthly:26');
    assert.equal(monthly.at, SAT_10);
  } finally { await teardown(); }
});

test('"כל שבוע", said on a Saturday, is armed for Sunday', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const r = await armed(pool, u, SAT_10, 'weekly');
    assert.equal(r.rule, 'weekly');
    assert.equal(local(TZ, r.at), local(TZ, SUN_10));
    // …and the series carries on from Sunday. This is the migration the owner
    // chose: a plain weekly whose every occurrence lands on a quiet day is
    // otherwise a reminder that never arrives.
    const after = reminders.nextOccurrence(r.at, r.rule, TZ);
    assert.match(local(TZ, after.toISOString()), /^Sun/);
  } finally { await teardown(); }
});

test('a ONE-OFF on a quiet day is never moved', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    // "תזכירי לי בשבת ב-10" is a single moment they chose with that day in
    // front of them. The gate has always let rung 1 of an asked-for reminder
    // through a quiet day (gate.askedForInWords); this rule narrows that
    // exemption to the kind that REPEATS, and not one step further.
    const r = await armed(pool, u, SAT_10, null);
    assert.equal(r.rule, null);
    assert.equal(r.at, SAT_10);
  } finally { await teardown(); }
});

// ---- every occurrence after the first ---------------------------------------

async function spawnedAfter(pool, taskId, tickIso) {
  await withTx(pool, (c) => sweeps.sweepReminders(c, tickIso));
  const { rows } = await pool.query(
    `SELECT remind_at FROM task_reminders
      WHERE task_id = $1 AND attempts = 0 AND cancelled_at IS NULL`, [taskId]);
  assert.equal(rows.length, 1, 'one live row, never two');
  return rows[0].remind_at.toISOString();
}

test('the sweep moves a bare weekly when the quiet day arrived after it was set', async () => {
  const { pool, teardown } = await freshDb();
  try {
    // Why the SWEEP needs this at all, when setReminder already moved the
    // first occurrence: a bare weekly returns to the same weekday for ever,
    // so its successor is quiet only when the world changed under it. Two
    // ways that happens — they add a quiet day, or a yom tov lands on their
    // weekday. This is the first, because it is the one a test can pin
    // without a calendar.
    const u = await person(pool, { quiet: 'none' });
    const r = await armed(pool, u, SAT_10, 'weekly');
    assert.equal(r.at, SAT_10, 'Saturday was an ordinary day when they asked');

    await withTx(pool, (c) => preferences.remember(c, u.id, 'quiet_days', 'sat'));
    const spawned = await spawnedAfter(pool, r.taskId, '2026-09-26T09:01:00Z');
    assert.match(local(TZ, spawned), /^Sun 04 Oct/, 'the next one lands on the Sunday, not the Saturday');

    const { rows: log } = await pool.query(
      `SELECT detail FROM audit_log WHERE event = 'reminder.moved_off_quiet_day'`);
    assert.equal(log.length, 1, 'the move is on the record — it is the one thing somebody could notice and not explain');
    assert.equal(log[0].detail.reason, 'quiet_day');
  } finally { await teardown(); }
});

test('the sweep arms a daily successor on the quiet day itself', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const first = await armed(pool, u, FRI_10, 'daily');
    assert.equal(first.at, FRI_10);
    const spawned = await spawnedAfter(pool, first.taskId, '2026-09-25T09:01:00Z');
    assert.equal(local(TZ, spawned), local(TZ, SAT_10), 'Saturday, because the pill is on Saturday too');
    const { rows: log } = await pool.query(
      `SELECT 1 FROM audit_log WHERE event = 'reminder.moved_off_quiet_day'`);
    assert.equal(log.length, 0, 'nothing moved, so nothing is claimed');
  } finally { await teardown(); }
});

test('a bare weekly keeps its hour when it moves, and its series from then on', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const r = await armed(pool, u, SAT_10, 'weekly');
    assert.match(local(TZ, r.at), /10:00$/, 'the hour is the promise and it survives the move');
    // The migration the owner chose, stated as an assertion: from here the
    // series is every Sunday, because a weekly successor is seven days after
    // the STORED moment. It is the reason this is the only shape that moves —
    // daily reads the stored moment too but lands on a kept day either way,
    // and monthly reads its day from the rule and cannot drift at all.
    const after = reminders.nextOccurrence(r.at, 'weekly', TZ);
    assert.match(local(TZ, after.toISOString()), /^Sun 04 Oct/);
    assert.match(local(TZ, after.toISOString()), /10:00$/);
  } finally { await teardown(); }
});

// ---- the zone the live users are actually in --------------------------------

test('in Israel the edge is candle-lighting and havdalah, not midnight', async () => {
  const { pool, teardown } = await freshDb();
  try {
    // Stated, not inferred. Every live user in this zone reaches a quiet
    // Saturday through the unstated default instead (preferences.quietDays:
    // Saturday for a Jewish calendar), but `makeUser` stamps 'none' on purpose
    // so no test can depend on geography it did not ask for.
    const IL = 'Asia/Jerusalem';
    const u = await makeUser(pool, '+972541999001', { timezone: IL, locale: 'he' });
    await withTx(pool, (c) => preferences.remember(c, u.id, 'quiet_days', 'sat'));
    // Shabbat 25–26 Sep 2026: candle-lighting 18:13 Friday, havdalah 19:08
    // Saturday (hebcal, via holidays.shabbatWindow).
    const fridayEvening = '2026-09-25T16:30:00.000Z';   // 19:30 local — inside
    const saturdayMorning = '2026-09-26T07:00:00.000Z'; // 10:00 local — inside
    const saturdayNight = '2026-09-26T17:30:00.000Z';   // 20:30 local — out

    // Friday 19:30 is inside Shabbat, which a calendar day would have missed
    // entirely — and the next moment at that same hour which is NOT is
    // Saturday 19:30, twenty minutes past havdalah. That is deliberately the
    // same answer `gate.quietDayReason` gives: one predicate, so what the
    // schedule believes and what the gate believes can never disagree.
    const held = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), fridayEvening));
    assert.notEqual(held.movedFrom, null, 'Friday evening is inside Shabbat');
    assert.equal(local(IL, held.at), 'Sat 26 Sept, 19:30');

    // A Saturday MORNING has the whole of Shabbat still in front of it, so the
    // same walk carries it to Sunday.
    const morning = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), saturdayMorning));
    assert.equal(local(IL, morning.at), 'Sun 27 Sept, 10:00');

    // And past havdalah there is nothing to move: a calendar-day rule would
    // have held this one until Sunday for no reason anybody could point at.
    const out = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), saturdayNight));
    assert.equal(out.movedFrom, null, 'past havdalah Saturday is an ordinary evening');
    assert.equal(out.at.toISOString(), saturdayNight);
  } finally { await teardown(); }
});
