'use strict';
// The growth table and the voice count on the "שימוש במוצר" section
// (2026-09-09): sums per window from the daily rows the sweep writes, and
// Olma's own sentences read back from the transcripts and counted.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const metrics = require('../src/jobs/metrics');
const section = require('../src/adapters/http/admin/sections/metrics');
const audit = require('../src/domain/audit');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972505600001', { firstName: 'צמיחה' });
});
after(async () => { await db.teardown(); });

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);

// pg's own date parser: a DATE column comes back as `new Date(Date.UTC(y, m-1, d))`,
// never a string. `String()` of that is `Date.prototype.toString()` — the
// weekday-first local form, not the ISO one — so a fixture built from a
// plain string cannot reproduce the bug this file exists to catch.
// domain/hebrew-quality's founding-case comment ("measured, not assumed")
// is the same discipline: a check must be exercised against the real shape.
const pgDate = (isoDay) => new Date(`${isoDay}T00:00:00Z`);

test('dateKey: a pg Date column and a plain string both key the same day', () => {
  assert.equal(section.dateKey(new Date('2026-09-09T00:00:00.000Z')), '2026-09-09');
  assert.equal(section.dateKey('2026-09-09'), '2026-09-09');
  // the bug this guards: String(Date) is "Wed Sep 09 2026 …", not the ISO
  // form, and slicing THAT to 10 chars is "Wed Sep 09" — a key nothing
  // else in the file ever looks up, and a string Date.parse cannot read
  // (NaN), which read as "outside every window" everywhere it compared,
  // never as an error.
  assert.notEqual(String(new Date('2026-09-09T00:00:00.000Z')).slice(0, 10), '2026-09-09');
});

test('growthTable: each window sums its own days, and active users are averaged, not summed — against real pg-shaped dates', () => {
  const today = '2026-09-09';
  const rows = [];
  for (let age = 0; age < 60; age++) {
    const d = pgDate(new Date(Date.parse(`${today}T00:00:00Z`) - age * 86400_000).toISOString().slice(0, 10));
    rows.push({ date: d, metric: 'messages_received', value: age < 7 ? 10 : (age < 14 ? 5 : 1) });
    rows.push({ date: d, metric: 'active_users', value: 12 });
  }
  const g = section.growthTable(rows, today);
  // today, yesterday, 7 days, the 7 before, 30 days, the 30 before
  assert.deepEqual(g.messages_received, [10, 10, 70, 35, 70 + 35 + 16, 30]);
  assert.deepEqual(g.active_users, [12, 12, 12, 12, 12, 12]);
  // a metric with no rows is a row of zeros, not a missing row
  assert.deepEqual(g.groups_created, [0, 0, 0, 0, 0, 0]);
});

test('the sweep counts what people sent and the rooms she joined, and the section renders the real numbers — through a real pg row, not a fixture', async () => {
  await withTx(db.pool, async (c) => {
    await audit.record(c, user.id, 'message.received', { n: 1 });
    await audit.record(c, user.id, 'message.received', { n: 2 });
    await c.query(`INSERT INTO chat_groups (external_id) VALUES ('120363000000000001@g.us')`);
  });
  await withTx(db.pool, (c) => metrics.sweepMetrics(c));
  const { rows } = await db.pool.query(
    `SELECT date, metric, value FROM product_metrics_daily WHERE date = $1::date AND metric IN ('messages_received', 'groups_created', 'active_users')`, [iso(0)]);
  // this is the exact row shape renderMetrics gets in production — a real
  // pg client, never a hand-built object — so date really is a Date here
  assert.ok(rows[0].date instanceof Date, 'a real query returns a Date, not a string');
  const by = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(by.messages_received, 2);
  assert.equal(by.groups_created, 1);
  // rendered through the function the dashboard calls, never a replica of its query
  const html = await section.renderMetrics(db.pool);
  assert.match(html, /צמיחה — יום מול יום/);
  // the actual numbers, not just that the labels are on the page — this is
  // what the label-only version of this test missed on 2026-09-09
  assert.match(html, /<div class="num">2<\/div><div class="lbl">הודעות שהתקבלו היום<\/div>/);
  assert.match(html, /nowrap">הודעות שהתקבלו<\/td><td>2<\/td><td>0<\/td><td>2<\/td>/);
  assert.match(html, /nowrap">קבוצות חדשות<\/td><td>1<\/td><td>0<\/td><td>1<\/td>/);
});

test('her voice is counted per day from the transcripts: flawed of written, and an unreadable store is not a clean one', async () => {
  const day = iso(0);
  const at = Date.parse(`${day}T09:00:00Z`);
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [user.id]);
  const other = await makeUser(db.pool, '+972505600002', { firstName: 'שני' });
  await db.pool.query(`UPDATE users SET agent_id = 'u-' || id WHERE id = $1`, [other.id]);
  const stores = {
    [`u-${user.id}`]: [
      { at, text: 'רשמתי ✅ אזכיר לך שעה לפני.' },
      { at: at + 1000, text: 'אני מבין. כבר אמרתי לשרה 🤝' },
      { at: at + 2000, text: 'NO_REPLY' },
      { at: at - 86400_000, text: 'אני מניח שאתה בישראל' }, // yesterday — must NOT land in today's count
    ],
    [`u-${other.id}`]: null, // a store that could not be opened
  };
  const sessions = { scanAssistantTextSince: async (agentId) => stores[agentId] };
  const out = await withTx(db.pool, (c) => metrics.rollupVoiceDay(c, sessions, day));
  assert.deepEqual(out, { messages: 2, flawed: 1, unreadable: 1 });
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily WHERE date = $1::date AND metric IN ('assistant_messages', 'hebrew_flaws') ORDER BY metric`, [day]);
  assert.deepEqual(rows.map((r) => [r.metric, Number(r.value)]), [['assistant_messages', 2], ['hebrew_flaws', 1]]);
  // the section says "1 of 2" for TODAY specifically, never yesterday's
  // slip folded in and never a percentage
  const html = await section.renderMetrics(db.pool);
  assert.match(html, /העברית של עולמה/);
  assert.match(html, /היום 1 מתוך 2/);
  // and the hourly sweep carries the reader through when it is given one —
  // yesterday and today together, so yesterday's slip is in this total
  const swept = await withTx(db.pool, (c) => metrics.sweepMetrics(c, new Date(), { sessions }));
  assert.deepEqual(swept.voice, { messages: 3, flawed: 2, unreadable: 2 });
  const bare = await withTx(db.pool, (c) => metrics.sweepMetrics(c));
  assert.match(String(bare.voice), /skipped/);
});
