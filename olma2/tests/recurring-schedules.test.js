'use strict';
// The three shapes people actually ask for, end to end:
//   "בסוף כל חודש תזכירי לי לעשות ניהול"      → monthly:last
//   "כל 16 לחודש לקחת תרופה"                   → monthly:16
//   "שני וחמישי לסדר את הבית"                  → weekly:MO,TH
//
// Only the third worked before this, and it worked until the person said they
// had done it — which cancelled the recurrence. Both halves are pinned here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const sweeps = require('../src/jobs/sweeps');

const TZ = 'Asia/Jerusalem';
const local = (iso) => new Date(iso).toLocaleString('en-CA', {
  timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

async function arm(pool, phone, { title, remindAt, rule }) {
  const user = await makeUser(pool, phone, { timezone: TZ });
  const taskId = await withTx(pool, async (c) => {
    const t = await tasks.addTask(c, user.id, { title });
    const r = await reminders.setReminder(c, user.id, t.data.task.id, remindAt, rule);
    assert.equal(r.ok, true, JSON.stringify(r.error || {}));
    return t.data.task.id;
  });
  return { user, taskId };
}

// Walk the sweep forward: fire the pending reminder, read the successor it
// wrote, repeat. This is the real path — normalize, nextOccurrence and the
// INSERT all together — not nextOccurrence called in isolation.
async function walk(pool, steps) {
  const out = [];
  for (let i = 0; i < steps; i++) {
    const { rows } = await pool.query(
      `SELECT id, remind_at FROM task_reminders
        WHERE sent_at IS NULL AND cancelled_at IS NULL ORDER BY remind_at LIMIT 1`);
    if (!rows[0]) break;
    const at = new Date(rows[0].remind_at);
    out.push(local(at));
    await withTx(pool, (c) => sweeps.sweepReminders(c, new Date(at.getTime() + 60_000).toISOString()));
  }
  return out;
}

test('"בסוף כל חודש" lands on the last day of each month, whatever it is', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  // 31 Dec 2025, 20:00 Jerusalem
  await arm(pool, '+972506600001',
    { title: 'ניהול סוף חודש', remindAt: '2025-12-31T18:00:00+00:00', rule: 'monthly:last' });

  assert.deepEqual(await walk(pool, 5), [
    '2025-12-31, 20:00',
    '2026-01-31, 20:00',
    '2026-02-28, 20:00',   // not the 31st, and not skipped
    '2026-03-31, 20:00',   // the clamp must not have dragged this to the 28th
    '2026-04-30, 20:00',
  ]);
});

test('"כל 16 לחודש" keeps the 16th, and keeps the hour across a DST switch', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  // 08:00 Jerusalem on 16 Feb 2026 (standard time). Israel springs forward on
  // 27 March: a flat +30 days or +1 month of milliseconds would drift the hour.
  await arm(pool, '+972506600002',
    { title: 'לקחת תרופה', remindAt: '2026-02-16T06:00:00+00:00', rule: 'FREQ=MONTHLY;BYMONTHDAY=16' });

  const seen = await walk(pool, 4);
  assert.deepEqual(seen, [
    '2026-02-16, 08:00',
    '2026-03-16, 08:00',
    '2026-04-16, 08:00',   // after the DST switch — still 08:00 local
    '2026-05-16, 08:00',
  ]);
  // ...and the stored instant really did move by an hour in UTC, which is the
  // whole point: the wall clock was preserved, not the offset.
  const { rows } = await pool.query(
    `SELECT remind_at FROM task_reminders ORDER BY remind_at`);
  const utcHours = rows.map((r) => new Date(r.remind_at).getUTCHours());
  assert.deepEqual(utcHours.slice(0, 4), [6, 6, 5, 5]);
});

// A reminder in the small hours has a LOCAL date one day ahead of its UTC one.
// Reading "the 16th" off a UTC clock would anchor this to the 15th and every
// occurrence after it would be a day early, for ever.
test('a small-hours reminder anchors to the local day, not the UTC one', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  // 01:00 Jerusalem on the 16th = 22:00Z on the FIFTEENTH
  await arm(pool, '+972506600003',
    { title: 'משמרת לילה', remindAt: '2026-08-15T22:00:00+00:00', rule: 'monthly' });

  const { rows } = await pool.query(`SELECT repeat_rule FROM task_reminders`);
  assert.equal(rows[0].repeat_rule, 'monthly:16', 'bare "monthly" pins to the LOCAL day');
  assert.deepEqual(await walk(pool, 3), [
    '2026-08-16, 01:00', '2026-09-16, 01:00', '2026-10-16, 01:00',
  ]);
});

test('a 31st-of-the-month rule clamps to short months without compounding', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await arm(pool, '+972506600004',
    { title: 'תשלום', remindAt: '2026-01-31T07:00:00+00:00', rule: 'monthly:31' });
  assert.deepEqual(await walk(pool, 4), [
    '2026-01-31, 09:00',
    '2026-02-28, 09:00',
    '2026-03-31, 09:00',   // back to the 31st — a compounding clamp says 28
    '2026-04-30, 09:00',
  ]);
});

// The live bug this feature would have hit on first use. Task 17 on user 3
// ("לנקות את הכלים", weekly:MO,TH) was completed on 2026-08-27 and has not
// reminded anyone since: the sweep writes the next occurrence as a pending row
// the moment it fires, and completeTask cancelled every pending reminder.
test('saying you did this week\'s chore does not end the chore', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const { user, taskId } = await arm(pool, '+972506600005',
    { title: 'לסדר את הבית', remindAt: '2026-08-17T15:00:00+00:00', rule: 'weekly:MO,TH' });

  await withTx(pool, (c) => sweeps.sweepReminders(c, '2026-08-17T15:01:00Z'));
  const res = await withTx(pool, (c) => tasks.completeTask(c, user.id, taskId));

  assert.equal(res.ok, true);
  assert.equal(res.data.recurring, true);
  assert.equal(res.data.repeatRule, 'weekly:MO,TH');
  assert.equal(res.data.task.status, 'open', 'a standing task stays on the list');
  assert.equal(local(res.data.nextRemindAt), '2026-08-20, 18:00', 'Thursday, as promised');

  // and the cadence really is still running
  assert.deepEqual(await walk(pool, 3),
    ['2026-08-20, 18:00', '2026-08-24, 18:00', '2026-08-27, 18:00']);
});

test('cancelling the cadence first is what lets a standing task be finished', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const { user, taskId } = await arm(pool, '+972506600006',
    { title: 'קורס תרופות', remindAt: '2026-08-17T15:00:00+00:00', rule: 'daily' });
  const { rows } = await pool.query(`SELECT id FROM task_reminders`);

  await withTx(pool, (c) => reminders.cancelReminder(c, user.id, rows[0].id));
  const res = await withTx(pool, (c) => tasks.completeTask(c, user.id, taskId));
  assert.equal(res.data.recurring, undefined);
  assert.equal(res.data.task.status, 'done');
});

// A one-off is unaffected by any of the above.
test('a one-off task still completes and cancels its reminder', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const { user, taskId } = await arm(pool, '+972506600007',
    { title: 'לשלוח מייל', remindAt: '2026-08-17T15:00:00+00:00', rule: null });
  const res = await withTx(pool, (c) => tasks.completeTask(c, user.id, taskId));
  assert.equal(res.data.task.status, 'done');
  assert.equal(res.data.remindersCancelled, 1);
});
