'use strict';
// The owner's rule, 2026-09-22: "אם זה לא תזכורת ספציפית ליום שבת - אז היא לא
// צריכה להגיע כמו שהמשימות של הדיגסט בוקר לא מגיעות."
//
// Three sentences, and all three are asserted below:
//
//   * "תזכיר לי כל שבוע בשבת"  → every Saturday. The rule NAMES the day.
//   * "תזכיר לי כל שבוע", said on a Saturday → moves to Sunday, and the
//     series carries on from there. He was shown the migration and chose it
//     over the two alternatives: pinning 'weekly' to the day it was set on
//     hands somebody an exemption they never asked for, and SKIPPING the
//     occurrence makes a monthly reminder vanish for a month.
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

test('…but not when the rule NAMES that day', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const named = reminders.daysNamedBy('weekly:SA');
    assert.deepEqual(named, [6], 'SA is Saturday, 0 = Sunday');
    const kept = await withTx(pool, (c) => quietFacts.keptMomentFor(c, who(u), SAT_10, { namedDays: named }));
    assert.equal(kept.at.toISOString(), SAT_10);
    assert.equal(kept.movedFrom, null);
  } finally { await teardown(); }
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

test('only a rule that spells the day out names it', () => {
  assert.deepEqual(reminders.daysNamedBy('weekly:SA'), [6]);
  assert.deepEqual(reminders.daysNamedBy('FREQ=WEEKLY;BYDAY=SA'), [6]);
  assert.deepEqual(reminders.daysNamedBy('weekly:MO,TH'), [1, 4]);
  // The ones that name nothing, and each for its own reason: every day is
  // equally incidental to 'daily'; "כל שבוע" said on a Saturday is a
  // coincidence of when they said it; and the 16th is a DATE, which never
  // named a weekday.
  for (const rule of ['daily', 'weekly', 'שבועי', 'monthly:16', 'monthly:last', null]) {
    assert.deepEqual(reminders.daysNamedBy(rule), [], `${rule} names no day`);
  }
});

// ---- the first occurrence ---------------------------------------------------

async function armed(pool, user, at, rule) {
  const taskId = await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title: 'לעבור על המיילים' });
    const r = await reminders.setReminder(c, user.id, t.data.task.id, at, rule);
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
    return t.data.task.id;
  });
  const { rows } = await pool.query(
    `SELECT remind_at, repeat_rule FROM task_reminders WHERE task_id = $1 AND cancelled_at IS NULL`, [taskId]);
  assert.equal(rows.length, 1);
  return { taskId, at: rows[0].remind_at.toISOString(), rule: rows[0].repeat_rule };
}

test('"כל שבוע בשבת" is armed for Saturday', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    const r = await armed(pool, u, SAT_10, 'FREQ=WEEKLY;BYDAY=SA');
    assert.equal(r.rule, 'weekly:SA');
    assert.equal(r.at, SAT_10, 'they named the day; the day is what they get');
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

test('the sweep arms the next occurrence off a quiet day, and the chain survives it', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    // Friday 10:00, daily. Firing it spawns Saturday — which moves to Sunday.
    const first = await armed(pool, u, FRI_10, 'daily');
    assert.equal(first.at, FRI_10, 'Friday is a day they keep');

    await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-09-25T09:01:00Z'));
    const { rows } = await pool.query(
      `SELECT remind_at FROM task_reminders
        WHERE task_id = $1 AND attempts = 0 AND cancelled_at IS NULL`, [first.taskId]);
    assert.equal(rows.length, 1, 'one live row, never two');
    const spawned = rows[0].remind_at.toISOString();
    assert.equal(local(TZ, spawned), local(TZ, SUN_10), 'Saturday moved to Sunday');

    // The day after Sunday is Monday — the chain is intact and nobody gets two
    // messages in one morning. (A 'daily' successor is computed from the
    // stored moment, so a shift costs the series nothing.)
    assert.match(local(TZ, reminders.nextOccurrence(spawned, 'daily', TZ).toISOString()), /^Mon/);

    // …and the move is on the record, because it is the one thing about a
    // repeating reminder somebody could notice and not be able to explain.
    const { rows: log } = await pool.query(
      `SELECT event, detail FROM audit_log WHERE actor_id = $1 AND event = 'reminder.moved_off_quiet_day'`,
      [u.id]);
    assert.equal(log.length, 1);
    assert.equal(log[0].detail.reason, 'quiet_day');
  } finally { await teardown(); }
});

test('a monthly date that lands on a quiet day shifts, and the NEXT one does not drift', async () => {
  const { pool, teardown } = await freshDb();
  try {
    const u = await person(pool);
    // 2026: the 26th of September is a Saturday. 'monthly:26' names a DATE, so
    // it moves — to the 27th.
    const kept = await withTx(pool, (c) => quietFacts.keptMomentFor(
      c, who(u), SAT_10, { namedDays: reminders.daysNamedBy('monthly:26') }));
    assert.match(local(TZ, kept.at), /^Sun 27 Sep/);
    // The month after is still the 26th: 'monthly:N' reads its day from the
    // RULE, never from the previous occurrence, so a shift can never compound
    // into a walk down the calendar.
    const after = reminders.nextOccurrence(kept.at.toISOString(), 'monthly:26', TZ);
    assert.match(local(TZ, after.toISOString()), /26 Oct/);
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
