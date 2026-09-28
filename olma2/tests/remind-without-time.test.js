'use strict';
// "תזכיר לי לקבוע לרחלה תור" — a reminder asked for with no WHEN at all.
//
// Dov, 2026-09-27, three in one afternoon: each was saved as a task with no
// date and no reminder, answered "רשמתי 🙂", and nothing would ever have
// reached him — he has no morning digest, and neither do 22 of the 30 active
// people. The owner's ruling (2026-09-28): once a week, at the morning hour,
// until it is done. The hook reads the words (remindWithoutTime), brokerd
// carries the verdict (tests/turn-open.test.js), and addTask arms it through
// reminders.startWeeklyNudge — every half asserted here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.OLMA_HOOK_TRACE = require('node:path').join(require('node:os').tmpdir(), `remind-without-time-hook-${process.pid}.log`);
const { remindWithoutTime } = require('../gateway-hooks/olma-turn-open/handler');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');
const preferences = require('../src/domain/preferences');
const { partsInZone, weekdayOfParts } = require('../src/domain/datetime');

const TZ = 'Asia/Jerusalem';
// Sun 27 Sep 2026, 15:00 local — Dov's afternoon. A literal, never the clock
// this run starts at (rules/testing.md).
const ASKED_AT = new Date('2026-09-27T12:00:00.000Z');
const local = (d) => {
  const p = partsInZone(TZ, new Date(d));
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}`;
};

// ── the words ────────────────────────────────────────────────────────────────
// Measured on the box 2026-09-28 against all 85 real messages asking for a
// reminder: these five, all Dov's, and nothing else. Four of them were saved
// with no date at all.
const DOV = [
  '[Audio transcript (machine-generated, untrusted)]: "תזכירי לי לשים מגן מסך על הטלפון"',
  'תזכיר לי לקבץ את כל החומרים של דב מדיה בתיקייה אחת בכונן גיבוי ולעלות הכל ליוטיוב',
  'ותזכיר לי לסיים אתר לרוזיו',
  'תזכיר לי לשאול את אמא מה עם העובד בחדר שינה',
  'תזכיר לי לקבוע לרחלה תור ליהודית המכשפה מנחלים',
];

test('Dov\'s five reminders with no time are read as exactly that', () => {
  for (const t of DOV) assert.equal(remindWithoutTime(t), true, t);
  assert.equal(remindWithoutTime('remind me to call mom'), true);
});

// The four the looser noun-or-verb reading also took, off the same 85 real
// messages — a question, a thank-you answering one, a relay to a group, and a
// dated ask — plus the shapes that name a when and so are the model's to arm.
test('what is not a reminder without a time', () => {
  const not = [
    'תזכיר לי מראש?',
    'כרגע אצטרך רק תזכורת תודה רבה',
    'מעולה תוסיף בבקשה תזכורת לרשימה הראשונה נדבר עם אביטל מהפועל באר שבע',
    'יכול להקפיץ תזכורת בקבוצה שוב לגבי הפאדל מתי הם יכולים?',
    'תזכיר לי מחר בבוקר לסדר עניני חתונה',
    'תזכיר לי להוציא קבלה ללוינשטין נתיב על ה9',
    'תזכורת כל ערב בשבוע הקרוב לסדר קבלות',
    'תזכירי לי לשאול את אבא הערב',
    'תזכיר לי כל יום לשתות',
    'תזכיר לי כשאגיע הביתה לתלות כביסה',
    'תזכיר לי לקנות מתנה ליום הולדת',
    'תזכיר לי מה אמרתי לגבי הפגישה',
    'תזכיר לי למה קבענו את זה',
    'תפסיק להזכיר לי לשתות',
    'remind me in an hour to stretch',
    'remind me to call mom tomorrow',
    'לקנות חלב',
    '',
  ];
  for (const t of not) assert.equal(remindWithoutTime(t), false, t);
  assert.equal(remindWithoutTime('תזכיר לי ל' + 'א'.repeat(400)), false, 'a long message is not one ask');
});

// ── the arming ───────────────────────────────────────────────────────────────
let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

let seq = 0;
async function person({ digest = null } = {}) {
  seq += 1;
  const u = await makeUser(db.pool, '+97250541' + String(4000 + seq), { timezone: TZ, locale: 'he' });
  await withTx(db.pool, (c) => preferences.remember(c, u.id, 'quiet_days', 'sat'));
  if (digest) await db.pool.query(`UPDATE users SET digest_times = $2 WHERE id = $1`, [u.id, digest]);
  return u;
}
const save = (u, extra = {}) => withTx(db.pool, (c) => tasks.addTask(c, u.id, {
  title: `לסיים אתר לרוזיו ${++seq}`, weekly: true, now: ASKED_AT, ...extra,
}));

test('a week out, at the start of their window, weekly, for eight weeks', async () => {
  const u = await person();
  const res = await save(u);
  assert.equal(res.ok, true, JSON.stringify(res.error || {}));
  const r = res.data.reminders[0];
  assert.equal(r.repeat_rule, 'weekly');
  assert.equal(local(r.remind_at), '2026-10-04 09:00', 'a week after they asked, at 09:00 — never today');
  assert.equal(local(r.repeat_until).slice(0, 10), '2026-11-22', 'eight weeks, the last on the eighth');
  assert.equal(res.data.task.due_at, null, 'a nudge never dates the task');
  assert.deepEqual(res.data.chase, { until: r.repeat_until, every: 'weekly' });
  assert.equal(reminders.isChase(r), true, 'an end makes it a chase, so "done" closes it');
});

test('somebody with a morning digest gets it at that hour, where it rides the digest', async () => {
  const u = await person({ digest: '07:30,20:00' });
  const r = (await save(u)).data.reminders[0];
  assert.equal(local(r.remind_at), '2026-10-04 07:30');
  assert.equal(reminders.ridesDigest({
    dueAt: null, repeatRule: r.repeat_rule, remindAt: r.remind_at, timezone: TZ,
    digestTimes: '07:30,20:00', repeatUntil: r.repeat_until,
  }), true);
});

test('a week from a Saturday is a Saturday, and the first one moves off it', async () => {
  const u = await person();
  const sat = new Date('2026-09-26T09:00:00.000Z');
  const r = (await save(u, { now: sat })).data.reminders[0];
  const p = partsInZone(TZ, new Date(r.remind_at));
  assert.notEqual(weekdayOfParts(p), 6, 'not on the day they keep quiet');
  assert.equal(local(r.remind_at).slice(11), '09:00', 'the same hour, on the next kept day');
});

test('a date, an hour or an event is not this case, and nothing weekly is armed', async () => {
  const u = await person();
  const due = await save(u, { dueAt: '2026-10-01T10:00:00+03:00' });
  assert.equal(due.ok, true);
  assert.ok(!due.data.chase, 'a date arms its own reminder');
  const at = await save(u, { remindAt: '2026-10-01T10:00:00+03:00' });
  assert.ok(!at.data.chase);
  const ev = await save(u, { title: 'פגישה עם רחלה', kind: 'event' });
  assert.ok(!(ev.data && ev.data.chase), 'an event is never nudged');
});

test('"done" closes it', async () => {
  const u = await person();
  const res = await save(u);
  const done = await withTx(db.pool, (c) => tasks.completeTask(c, u.id, res.data.task.id));
  assert.equal(done.ok, true, JSON.stringify(done.error || {}));
  const { rows } = await db.pool.query(
    `SELECT cancelled_at FROM task_reminders WHERE task_id = $1`, [res.data.task.id]);
  assert.ok(rows.every((x) => x.cancelled_at), 'nothing weekly outlives the task');
});
