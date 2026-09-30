'use strict';
// The owner's weekly growth report (jobs/growth-report.js): once, on Sunday
// morning in his clock, read from the same rows the admin page reads.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { withTx } = require('../src/db/pool');
const report = require('../src/jobs/growth-report');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A fixed Sunday, 10:00 in Jerusalem (07:00 UTC in October, summer time).
const SUNDAY = new Date('2026-10-04T07:00:00Z');
const MONDAY = new Date('2026-10-05T07:00:00Z');
const SUNDAY_NIGHT = new Date('2026-10-04T03:00:00Z'); // 06:00 local

async function metric(date, name, value) {
  await db.pool.query(
    `INSERT INTO product_metrics_daily (date, metric, value) VALUES ($1, $2, $3)
     ON CONFLICT (date, metric) DO UPDATE SET value = EXCLUDED.value`, [date, name, value]);
}

test('the owner clock decides the day and the hour', () => {
  assert.deepEqual(report.localParts(SUNDAY), { date: '2026-10-04', weekday: 0, hour: 10 });
  assert.equal(report.localParts(SUNDAY_NIGHT).hour, 6);
});

test('nothing is sent before there is anything to read', async () => {
  const sent = [];
  const r = await withTx(db.pool, (c) => report.run(c, { now: SUNDAY, send: async (p, t) => { sent.push(t); return { ok: true }; } }));
  assert.equal(r.reason, 'no metrics yet');
  assert.equal(sent.length, 0);
});

test('Sunday morning: one message with the goal, last week, the doors and the tests — and only once', async () => {
  await metric('2026-10-04', 'weekly_active_users', 21);
  await metric('2026-09-27', 'weekly_active_users', 18);
  await metric('2026-10-01', 'joined_room', 2);
  await metric('2026-10-03', 'joined_friend_link', 1);
  await metric('2026-09-20', 'joined_direct', 9); // outside the week
  await metric('2026-10-02', 'referral_clicks', 4);
  await metric('2026-10-04', 'room_people', 40);
  await metric('2026-10-04', 'room_people_met', 9);
  await metric('2026-10-04', 'room_people_active', 6);
  await metric('2026-10-03', 'room_people', 99); // not the day WAU was read on
  await metric('2026-10-04', 'cohort_2_4w', 5);
  await metric('2026-10-04', 'cohort_2_4w_active', 2);

  const sent = [];
  const send = async (phone, text) => { sent.push({ phone, text }); return { ok: true }; };
  assert.equal((await withTx(db.pool, (c) => report.run(c, { now: SUNDAY_NIGHT, send }))).reason, 'not the hour');
  assert.equal((await withTx(db.pool, (c) => report.run(c, { now: MONDAY, send }))).reason, 'not the hour');

  const r = await withTx(db.pool, (c) => report.run(c, { now: SUNDAY, send }));
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  const t = sent[0].text;
  assert.match(t, /פעילים בשבוע: \*21 מתוך 100\* \(לפני שבוע: 18\)/);
  assert.match(t, /הצטרפו השבוע: 3 — קישור מחבר 1 · קבוצה 2 · הזמנה אישית — · ישירות —/);
  assert.match(t, /לחיצות על קישורי הזמנה: 4/);
  assert.match(t, /בקבוצות עם עולמה: 40 אנשים — 9 כבר אצלה, 6 פעילים השבוע/);
  assert.match(t, /הצטרפו לפני 2–4 שבועות: 5 — 2 מהם פעילים השבוע/);
  assert.match(t, /מתי מופיע כרטיס ההזמנה בדף האישי: A 0\/0 · B 0\/0 — עוד מוקדם/);
  assert.ok(!t.includes('?'), 'a report, not a question');

  assert.equal((await withTx(db.pool, (c) => report.run(c, { now: new Date(SUNDAY.getTime() + 3600e3), send }))).reason, 'already sent');
  assert.equal(sent.length, 1);
});

test('a failed send is not stamped, so the next hour tries again', async () => {
  await db.pool.query(`DELETE FROM feature_flags WHERE key = $1`, [report.SENT_FLAG]);
  const fail = async () => ({ ok: false });
  assert.equal((await withTx(db.pool, (c) => report.run(c, { now: SUNDAY, send: fail }))).notifyFailed, true);
  const ok = [];
  const r = await withTx(db.pool, (c) => report.run(c, { now: SUNDAY, send: async (p, t) => { ok.push(t); return { ok: true }; } }));
  assert.equal(r.sent, true);
  assert.equal(ok.length, 1);
});
