'use strict';
// חיים, 2026-09-22 11:39 UTC — the founding case, and the whole file is it:
//
//   "אני אשמח שתזכיר לי מתי לקחת את המצלמה לתיקון כדי להתחיל לעבוד איתה אני
//    רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת תודה רבה"
//
// What he got: task 731, due 28.9, and ONE reminder at 27.9 18:30 — an hour
// nobody had named, so the result said "the hour they themselves named" and the
// turn answered with a 👍 and no words at all.
//
// What the owner said it should have been: "מאותו יום שהוא ביקש כולל — הוא
// יקבל תזכורת אחת ביום על המשימה הזו עד לדד ליין — אלא אם כן אמר שזה בוצע."
// His four decisions, all four asserted below:
//
//   * the day he asks COUNTS. The morning hour is gone by 14:40, so the first
//     one goes that evening rather than tomorrow.
//   * the hour is the one he already hears from Olma — his morning digest,
//     failing that the start of his own window. Never a constant we picked.
//   * a quiet day is SKIPPED, not moved onto and not moved off: Saturday is a
//     day nobody can take a camera to a repair shop, and the series comes back
//     on Sunday regardless.
//   * "עד ש..." plus a request for help is what arms one. Not every task with
//     a deadline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const preferences = require('../src/domain/preferences');
const proactive = require('../src/domain/proactive-text');
const { partsInZone, weekdayOfParts } = require('../src/domain/datetime');
const pause = require('../src/domain/pause');
const listBlock = require('../src/domain/list-block');
const sweeps = require('../src/jobs/sweeps');
const { BY_NAME } = require('../src/adapters/mcp/registry');

const TZ = 'Asia/Jerusalem';
// 2026: Tue 22 Sep … Mon 28 Sep. Every moment here is a literal computed once,
// never off the clock this run starts at (rules/testing.md).
const ASKED_AT = '2026-09-22T11:40:00.000Z';      // Tue 14:40 local — his real hour
const DUE_AT = '2026-09-27T21:00:00.000Z';        // Mon 28 Sep 00:00 local, day-shaped
const EVENING_1 = '2026-09-22T16:00:00.000Z';     // Tue 19:00 local
const MORNING = (d) => `2026-09-${d}T06:00:00.000Z`; // 09:00 local, any day that week

// Built from the parts rather than from a locale's own words: 'Sep' and
// 'Sept' are the same month to two different ICU builds, and a test that reads
// differently on the box than on a laptop is worse than no test.
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const local = (iso) => {
  const p = partsInZone(TZ, new Date(iso));
  const pad = (n) => String(n).padStart(2, '0');
  return `${WEEKDAY[weekdayOfParts(p)]} ${pad(p.d)}-${pad(p.m)} ${pad(p.hh)}:${pad(p.mi)}`;
};

let seq = 0;
async function person(pool, { quiet = 'sat', digest = null } = {}) {
  seq += 1;
  const u = await makeUser(pool, '+97250540' + String(4000 + seq), { timezone: TZ, locale: 'he' });
  await withTx(pool, (c) => preferences.remember(c, u.id, 'quiet_days', quiet));
  if (digest) await pool.query(`UPDATE users SET digest_times = $2 WHERE id = $1`, [u.id, digest]);
  return u;
}

// His own ask, as the model should have made it: one call, the deadline, and
// the flag that says he asked to be chased.
async function camera(pool, user, { now = ASKED_AT, dueAt = DUE_AT, nudge = true, title = null } = {}) {
  seq += 1;
  return withTx(pool, (c) => tasks.addTask(c, user.id, {
    title: title || `לקחת את המצלמה לתיקון ${seq}`, dueAt, nudge, now: new Date(now),
  }));
}

const pending = async (pool, taskId) => (await pool.query(
  `SELECT * FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL
    ORDER BY id`, [taskId])).rows;

const sent = async (pool) => (await pool.query(
  `SELECT idempotency_key, payload, urgency FROM outbox WHERE kind = 'reminder' ORDER BY id`)).rows;

// The worker delivers; nothing in a test does, so a rung that has to look
// delivered is stamped the way the gate would stamp it.
async function deliverAll(pool, atIso) {
  await pool.query(
    `UPDATE outbox SET sent_at = $1::timestamptz, hold_reason = NULL
      WHERE kind = 'reminder' AND sent_at IS NULL`, [atIso]);
}

async function deliver(pool, key, atIso) {
  const { rowCount } = await pool.query(
    `UPDATE outbox SET sent_at = $2::timestamptz, hold_reason = NULL WHERE idempotency_key = $1`,
    [key, atIso]);
  assert.equal(rowCount, 1, `expected an outbox row ${key}`);
}

// ---- the founding case, end to end ------------------------------------------

test('חיים asks on Tuesday afternoon and is chased daily until Monday, Saturday skipped', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u);
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));

  // The arrangement itself: one row, daily, ending with the day the thing is
  // due on — and its FIRST moment is that same evening, because the day he
  // asked counts and 09:00 was four hours gone.
  const [row] = await pending(pool, res.data.task.id);
  assert.equal(row.repeat_rule, 'daily');
  assert.equal(local(row.remind_at), local(EVENING_1), 'the first one goes the evening he asked');
  assert.equal(local(row.repeat_until), 'Mon 28-09 23:59', 'it ends with the day the thing is due on');
  assert.equal(row.nudge, true);
  assert.equal(row.auto, false, 'he asked for this in words, and the gate reads that');
  assert.equal(reminders.isChase(row), true);

  // …and the result says the SHAPE, which is the one thing a 👍 cannot carry.
  assert.equal(res.data.chase.every, 'daily');
  assert.equal(res.data.remindersAsked, false, 'he named no hour, so the hour is news too');

  // Now the week, one sweep per occurrence. Each message is delivered the way
  // the worker would deliver it, because the successor is armed on the send.
  // Monday is the last day, and a nudge says it up to three times that day
  // (owner, 2026-10-03): 09:00, then a gap of NUDGE_GAP_HOURS each.
  const MON_2 = '2026-09-28T11:00:00.000Z'; // 14:00 local
  const MON_3 = '2026-09-28T16:00:00.000Z'; // 19:00 local
  const days = [];
  for (const at of [EVENING_1, MORNING(23), MORNING(24), MORNING(25), MORNING(26), MORNING(27), MORNING(28), MON_2, MON_3, MORNING(29)]) {
    const fired = await withTx(pool, (c) => sweeps.sweepReminders(c, at));
    await deliverAll(pool, at);
    if (fired.length) days.push(local(at));
  }
  assert.deepEqual(days, [
    'Tue 22-09 19:00',
    'Wed 23-09 09:00',
    'Thu 24-09 09:00',
    'Fri 25-09 09:00',
    // Saturday 26 Sep is his quiet day: nothing at all, and the series is not
    // pushed a day either — Sunday's own occurrence is what arrives.
    'Sun 27-09 09:00',
    'Mon 28-09 09:00',
    'Mon 28-09 14:00',
    'Mon 28-09 19:00',
  ], 'one a day, from the day he asked, three on the day it is due, minus Shabbat');

  // Nothing survives the deadline: no pending row, and the sweep the next
  // morning has nothing to send.
  assert.deepEqual(await pending(pool, res.data.task.id), []);

  // And the three sentences. The first is a plain reminder, the middle ones
  // ask "בוצע?" and say how to stop it — a daily series that cannot be ended
  // in one sentence is the drum this whole file exists to avoid — and the last
  // one says it is the last.
  const rows = await sent(pool);
  const keys = rows.map((r) => proactive.reminderTemplateKey(r.payload));
  assert.deepEqual(keys, [
    'reminder',
    'reminder_followup', 'reminder_followup', 'reminder_followup', 'reminder_followup',
    'reminder_followup', 'reminder_followup', 'reminder_last',
  ]);
  // Only the first is a moment HE chose. Every one after it is an hour Olma
  // picked on a day Olma picked, which is the line the escalation ladder draws
  // between rung 1 and everything above it — and the gate reads `rung` for the
  // night window and `urgency` for the daily budget.
  assert.deepEqual(rows.map((r) => r.payload.rung), [1, 2, 2, 2, 2, 2, 2, 3]);
  assert.deepEqual(rows.map((r) => r.urgency), ['urgent', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']);
});

test('"עשיתי" closes it — the task AND the chase, which is the half that would have been worse', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u);
  const taskId = res.data.task.id;
  await withTx(pool, (c) => sweeps.sweepReminders(c, EVENING_1));

  const done = await withTx(pool, (c) => tasks.completeTask(c, u.id, taskId));
  assert.equal(done.ok, true);
  assert.equal(done.data.recurring, undefined, 'a chase is not a standing task');
  assert.equal(done.data.task.status, 'done');
  assert.deepEqual(await pending(pool, taskId), [], 'and tomorrow morning brings nothing');
});

test('a CADENCE is still a standing task, and completing it still does not end it', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  // user 16's thyroid pill, in the shape it is actually stored on the box.
  const taskId = await withTx(pool, async (c) => {
    const t2 = await tasks.addTask(c, u.id, { title: 'לקחת כדור לבלוטה' });
    await reminders.setReminder(c, u.id, t2.data.task.id, MORNING(23), 'daily');
    return t2.data.task.id;
  });
  const done = await withTx(pool, (c) => tasks.completeTask(c, u.id, taskId));
  assert.equal(done.data.recurring, true, 'doing it once does not finish it');
  assert.equal(done.data.task.status, 'open');
  assert.equal((await pending(pool, taskId)).length, 1);
});

// ---- the hour, and who decides it -------------------------------------------

test('the hour is the one they already hear from Olma, and the page picks it the same way', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  // A morning digest wins: the chase rides the picture they already read.
  const withDigest = await person(pool, { digest: '09:35' });
  const a = await camera(pool, withDigest);
  assert.match(local((await pending(pool, a.data.task.id))[0].remind_at), /19:00$/,
    'the day they ask still goes in the evening');
  const nextDay = await withTx(pool, (c) => sweeps.sweepReminders(c, EVENING_1));
  assert.equal(nextDay.length, 1);
  assert.equal(local((await pending(pool, a.data.task.id))[0].remind_at), 'Wed 23-09 09:35',
    'and every one after it is their own digest hour');

  // Nobody's digest is in the evening for this purpose: that is not "when I
  // read my updates in the morning", so it falls through to the window.
  assert.equal(reminders.chaseHour({ digestTimes: '18:00', windowStart: '08:00' }), '08:00');
  assert.equal(reminders.chaseHour({ digestTimes: '', windowStart: '08:00' }), '08:00');
  assert.equal(reminders.chaseHour({}), reminders.CHASE_FALLBACK_AT);

  // The PAGE answers the same question for a standing nudge, in its own
  // runtime, and the two must not drift: a person told 09:00 on their page and
  // chased at 08:00 in chat has been told two things about one arrangement.
  const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');
  assert.match(page, new RegExp(`REM_MORNING_BEFORE = "${reminders.CHASE_MORNING_BEFORE}"`));
  assert.match(page, new RegExp(`REM_FALLBACK_AT = "${reminders.CHASE_FALLBACK_AT}"`));
});

test('the first moment: their hour if it is still ahead, the evening if it is not, tomorrow if that is gone too', () => {
  const at = (now) => local(reminders.firstChaseMoment({
    hour: '09:00', timezone: TZ, windowEnd: '21:00', now: new Date(now),
  }).toISOString());
  assert.equal(at('2026-09-22T04:00:00Z'), 'Tue 22-09 09:00', 'asked at 07:00 — this morning');
  assert.equal(at(ASKED_AT), 'Tue 22-09 19:00', 'asked at 14:40 — this evening, his real case');
  assert.equal(at('2026-09-22T19:30:00Z'), 'Wed 23-09 09:00', 'asked at 22:30 — tomorrow morning');
  // Somebody whose window closes at 18:00 never gets the evening slot: the
  // gate would hold it, and a held rung 1 meets the expiry check first.
  assert.equal(local(reminders.firstChaseMoment({
    hour: '09:00', timezone: TZ, windowEnd: '18:00', now: new Date(ASKED_AT),
  }).toISOString()), 'Wed 23-09 09:00');
});

// ---- the two short shapes ----------------------------------------------------

test('a deadline tonight is a nudge that lives one day, from the next slot still ahead', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  // "תעזור לי לזכור, זה לסוף היום", asked at 14:40 — the 09:00 and 14:00 slots
  // are gone, so 19:00, and the series ends tonight.
  const res = await camera(pool, u, { dueAt: '2026-09-22T20:00:00.000Z' });
  const [row] = await pending(pool, res.data.task.id);
  assert.equal(row.repeat_rule, 'daily');
  assert.equal(local(row.remind_at), 'Tue 22-09 19:00');
  assert.equal(local(row.repeat_until), 'Tue 22-09 23:59');
  assert.equal(Number(row.rungs), reminders.NUDGE_PER_DAY, 'loud: a deadline inside three days');
  assert.equal(row.nudge_capped, false, 'it ends at a deadline they named');
  assert.match(res.data.chase.shape, /up to 3 messages a day until 2026-09-22/);
});

test('no deadline: three a day for three days, and then ONE question', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool, { quiet: 'none' });
  const res = await camera(pool, u, { dueAt: null });
  const [row] = await pending(pool, res.data.task.id);
  assert.equal(row.repeat_rule, 'daily');
  assert.equal(local(row.remind_at), 'Tue 22-09 19:00', 'the next slot still ahead today');
  assert.equal(local(row.repeat_until), 'Thu 24-09 23:59', 'three days, today counting');
  assert.equal(Number(row.rungs), reminders.NUDGE_PER_DAY);
  assert.equal(row.nudge_capped, true);
  assert.match(res.data.chase.shape, /for 3 days/);

  // Run the whole series and read what was said.
  const slots = [];
  for (const d of [23, 24]) for (const h of ['06', '11', '16']) slots.push(`2026-09-${d}T${h}:00:00.000Z`);
  for (const at of [EVENING_1, ...slots, MORNING(25)]) {
    await withTx(pool, (c) => sweeps.sweepReminders(c, at));
    await deliverAll(pool, at);
  }
  const rows = await sent(pool);
  assert.equal(rows.length, 7, 'Tuesday evening, then three on Wednesday and three on Thursday');
  const keys = rows.map((r) => proactive.reminderTemplateKey(r.payload));
  assert.equal(keys[keys.length - 1], 'reminder_nudge_end', 'the last one asks whether to go on');
  assert.deepEqual(keys.slice(1, -1), Array(5).fill('reminder_followup'));
  assert.deepEqual(await pending(pool, res.data.task.id), [], 'and nothing after it');
});

test('a task that is not chased is exactly what it was before any of this', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u, { nudge: false });
  const [row] = await pending(pool, res.data.task.id);
  assert.equal(row.repeat_rule, null);
  assert.equal(row.repeat_until, null);
  assert.equal(row.auto, true, 'the automatic hour-before/morning reminder, unchanged');
});

// ---- ending one ---------------------------------------------------------------

test('"להפסיק להזכיר" ends a chase, including the day already armed behind it', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u);
  const taskId = res.data.task.id;
  const [first] = await withTx(pool, (c) => sweeps.sweepReminders(c, EVENING_1));
  await deliver(pool, `reminder:${first}`, EVENING_1);
  assert.equal((await pending(pool, taskId)).length, 1, 'tomorrow is already armed');

  const stop = await withTx(pool, (c) => reminders.stopRecentLadders(c, u.id, { now: new Date(MORNING(23)) }));
  // The occurrence that reached him is already retired — a repeating reminder
  // never climbs, so it is stamped on the send — and what actually has to be
  // taken down is the one waiting behind it.
  assert.equal(stop.stopped.length, 1, 'the day already armed behind it');
  assert.deepEqual(await pending(pool, taskId), [], 'and nothing arrives tomorrow');
  // The task is untouched: stopping the reminders is not doing the thing.
  const { rows } = await pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  assert.equal(rows[0].status, 'open');
});

test('a cadence is left alone by the same write, which is the rule it was built on', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const taskId = await withTx(pool, async (c) => {
    const t2 = await tasks.addTask(c, u.id, { title: 'לקחת כדור לבלוטה' });
    await reminders.setReminder(c, u.id, t2.data.task.id, MORNING(23), 'daily');
    return t2.data.task.id;
  });
  const [fired] = await withTx(pool, (c) => sweeps.sweepReminders(c, MORNING(23)));
  await deliver(pool, `reminder:${fired}`, MORNING(23));
  const stop = await withTx(pool, (c) => reminders.stopRecentLadders(c, u.id, { now: new Date(MORNING(24)) }));
  assert.deepEqual(stop.stopped, [], 'a rhythm is ended with words, never by this write');
  assert.equal((await pending(pool, taskId)).length, 1);
});

// ---- a pause across one ------------------------------------------------------

test('a pause puts a chase back as the chase it was, end included', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u);
  const taskId = res.data.task.id;
  await withTx(pool, (c) => pause.pauseUser(c, u.id));
  // 07:00 local on the Thursday: their morning hour is still ahead, so the
  // answer is unambiguous — 09:00 is a re-derivation and 19:00 would be the
  // old row's moment carried across, which is the thing being tested.
  await withTx(pool, (c) => pause.resumeUser(c, u.id, { now: new Date('2026-09-24T04:00:00.000Z') }));
  const [row] = await pending(pool, taskId);
  assert.equal(row.repeat_rule, 'daily');
  assert.equal(local(row.repeat_until), 'Mon 28-09 23:59',
    're-armed without its end, it would be a daily nag with nothing to stop it');
  // Started again rather than continued: the moment it had was "the evening of
  // the day he asked", and that day is over. Their morning hour, from today.
  assert.equal(local(row.remind_at), 'Thu 24-09 09:00');
});

test('a chase whose deadline passed during the pause is not resurrected', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u);
  await withTx(pool, (c) => pause.pauseUser(c, u.id));
  await withTx(pool, (c) => pause.resumeUser(c, u.id, { now: new Date('2026-10-05T06:00:00.000Z') }));
  assert.deepEqual(await pending(pool, res.data.task.id), [],
    'a week of messages about a deadline that is gone');
});

// ---- what he is told it is ---------------------------------------------------

test('the list says the END, because "every day" alone is a promise to go on for ever', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  await camera(pool, u, { title: 'לקחת את המצלמה לתיקון' });
  await camera(pool, u, { title: 'להחזיר את הספרים לספרייה' });
  const list = await withTx(pool, (c) => reminders.listReminders(c, u.id));
  const block = listBlock.renderReminderListBlock(list.data, {
    locale: 'he', timezone: TZ, channelType: 'whatsapp', now: new Date(ASKED_AT),
  });
  assert.match(block, /כל יום עד /);
  assert.doesNotMatch(block, /כל יום,/, 'never the bare cadence for something that ends');
});

// ---- the arming the model actually makes -------------------------------------
//
// Run 79, 2026-09-23 — the first real eval night after twelve dead ones, and
// this file's own scenario went red. add_task armed the automatic 09:00 on the
// deadline day, `hints.chaseAvailable` asked for set_task_reminder(task_id,
// remind_at, nudge:true), and the model passed back the one moment in front of
// it: that 09:00. Taken as the anchor it made the chase's first day its last,
// the ladder fallback armed one reminder on Monday, and the reply promised one
// every day. The founding test above arms through add_task(nudge) in ONE call,
// which is the path the model did not take.

test('the moment the model echoes back is not an hour anybody named, so the owner\'s rules decide', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  const res = await camera(pool, u, { nudge: false });
  const [auto] = await pending(pool, res.data.task.id);
  assert.equal(auto.auto, true, 'add_task armed its own reminder first, as it did on the night');

  const chase = await withTx(pool, (c) => reminders.startChase(c, u.id, res.data.task.id,
    { now: new Date(ASKED_AT), at: auto.remind_at }));
  assert.ok(chase && chase.ok, 'echoing the automatic moment still arms a chase');
  const rows = await pending(pool, res.data.task.id);
  assert.equal(rows.length, 1, 'the automatic one is replaced, never joined');
  assert.equal(rows[0].repeat_rule, 'daily');
  assert.equal(local(rows[0].remind_at), local(EVENING_1), 'the day he asked still counts');
  assert.equal(local(rows[0].repeat_until), 'Mon 28-09 23:59');
});

test('through the tool: an echoed moment arms the chase and the result says its shape', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool, { quiet: 'none' });
  const NOW = Date.now();
  const added = await withTx(pool, (c) => tasks.addTask(c, u.id, {
    title: 'לקחת את המצלמה לתיקון', dueAt: new Date(NOW + 5 * 86400_000).toISOString(),
  }));
  const [auto] = await pending(pool, added.data.task.id);
  const res = await withTx(pool, (c) => BY_NAME.get('set_task_reminder').handler(c, { id: u.id, timezone: TZ }, {
    task_id: added.data.task.id,
    remind_at: new Date(auto.remind_at).toISOString().replace('Z', '+00:00'),
    nudge: true,
  }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.reminder.repeat_rule, 'daily');
  assert.ok(res.data.reminder.repeat_until, 'a chase, not a cadence');
  assert.ok(new Date(res.data.reminder.remind_at).getTime() < NOW + 86400_000,
    'the first one is inside a day — the eval asserts exactly this');
  assert.match(res.data.hints.chase, /nudge \("נודניק"\) is armed: .* once a day until/);
  const live = await pending(pool, added.data.task.id);
  assert.deepEqual(live.map((r) => Number(r.id)), [Number(res.data.reminder.id)],
    'the automatic row on the deadline day went: the chase already speaks that morning');
});

test('through the tool: a task with no date is a three-day nudge, and the result says so', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool, { quiet: 'none' });
  const added = await withTx(pool, (c) => tasks.addTask(c, u.id, { title: 'לקחת את המצלמה לתיקון' }));
  const res = await withTx(pool, (c) => BY_NAME.get('set_task_reminder').handler(c, { id: u.id, timezone: TZ }, {
    task_id: added.data.task.id,
    remind_at: new Date(Date.now() + 3 * 3600_000).toISOString().replace('Z', '+00:00'),
    nudge: true,
  }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.reminder.repeat_rule, 'daily');
  assert.equal(res.data.reminder.nudge_capped, true);
  assert.match(res.data.hints.chase, /for 3 days/);
  assert.match(res.data.hints.chase, /ONE question whether to go on/);
});

test('through the tool: a moment past the deadline is still ONE reminder, and says so', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool, { quiet: 'none' });
  const NOW = Date.now();
  const added = await withTx(pool, (c) => tasks.addTask(c, u.id, {
    title: 'לקחת את המצלמה לתיקון', dueAt: new Date(NOW + 2 * 86400_000).toISOString(),
  }));
  const res = await withTx(pool, (c) => BY_NAME.get('set_task_reminder').handler(c, { id: u.id, timezone: TZ }, {
    task_id: added.data.task.id,
    remind_at: new Date(NOW + 6 * 86400_000).toISOString().replace('Z', '+00:00'),
    nudge: true,
  }));
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  assert.equal(res.data.reminder.repeat_rule, null);
  assert.equal(res.data.reminder.nudge, true, 'they still get the ladder they asked for');
  assert.match(res.data.hints.chase, /No nudge was armed/);
  assert.match(res.data.hints.chase, /Never say "every day"/);
});

test('the list says a loud nudge is up to three a day, and a nudge never rides the digest', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const u = await person(pool);
  await camera(pool, u, { title: 'לשלוח את הטופס', dueAt: '2026-09-23T21:00:00.000Z' });
  await camera(pool, u, { title: 'להתקשר לבנק', dueAt: '2026-09-23T21:00:00.000Z' });
  const list = await withTx(pool, (c) => reminders.listReminders(c, u.id));
  const block = listBlock.renderReminderListBlock(list.data, {
    locale: 'he', timezone: TZ, channelType: 'whatsapp', now: new Date(ASKED_AT),
  });
  assert.match(block, /עד 3 פעמים ביום עד /);
  assert.equal(reminders.ridesDigest({ remindAt: MORNING(23), repeatRule: 'daily', dueAt: null,
    digestTimes: ['09:00'], timezone: TZ, rungs: 3 }), false);
});
