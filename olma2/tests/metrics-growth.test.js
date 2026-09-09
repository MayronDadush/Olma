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

test('growthTable: each window sums its own days, and active users are averaged, not summed', () => {
  const today = '2026-09-09';
  const rows = [];
  for (let age = 0; age < 60; age++) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - age * 86400_000).toISOString().slice(0, 10);
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

test('the sweep counts what people sent and the rooms she joined, and the section renders the comparison', async () => {
  await withTx(db.pool, async (c) => {
    await audit.record(c, user.id, 'message.received', { n: 1 });
    await audit.record(c, user.id, 'message.received', { n: 2 });
    await c.query(`INSERT INTO chat_groups (external_id) VALUES ('120363000000000001@g.us')`);
  });
  await withTx(db.pool, (c) => metrics.sweepMetrics(c));
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily WHERE date = $1::date AND metric IN ('messages_received', 'groups_created')`, [iso(0)]);
  const by = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(by.messages_received, 2);
  assert.equal(by.groups_created, 1);
  // rendered through the function the dashboard calls, never a replica of its query
  const html = await section.renderMetrics(db.pool);
  assert.match(html, /צמיחה — יום מול יום/);
  assert.match(html, /הודעות שהתקבלו/);
  assert.match(html, /קבוצות חדשות/);
  assert.match(html, /7 שלפניהם/);
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
      { at: at - 86400_000, text: 'אני מניח שאתה בישראל' }, // yesterday — not this day's count
    ],
    [`u-${other.id}`]: null, // a store that could not be opened
  };
  const sessions = { scanAssistantTextSince: async (agentId) => stores[agentId] };
  const out = await withTx(db.pool, (c) => metrics.rollupVoiceDay(c, sessions, day));
  assert.deepEqual(out, { messages: 2, flawed: 1, unreadable: 1 });
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily WHERE date = $1::date AND metric IN ('assistant_messages', 'hebrew_flaws') ORDER BY metric`, [day]);
  assert.deepEqual(rows.map((r) => [r.metric, Number(r.value)]), [['assistant_messages', 2], ['hebrew_flaws', 1]]);
  // the section says "1 of 2" for today, never a percentage
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
