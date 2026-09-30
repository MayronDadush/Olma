'use strict';
// Retention (owner, 2026-10-01): of the people who met her two to four weeks
// before the date, how many were active in its week.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const metrics = require('../src/jobs/metrics');
const section = require('../src/adapters/http/admin/sections/metrics');
const report = require('../src/jobs/growth-report');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const DAY = '2026-09-30';
const at = (d) => `${d} 12:00:00+00`;

test('cohort_2_4w: onboarded 14-27 days before, and the ones active this week', async () => {
  const person = async (phone, onboarded, extra = '') => {
    const u = await makeUser(db.pool, phone);
    await db.pool.query(`UPDATE users SET status = 'active', agent_id = $2, onboarded_at = $3 ${extra} WHERE id = $1`,
      [u.id, `u-${u.id}`, at(onboarded)]);
    return u.id;
  };
  const said = (uid, d) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at, retention_class) VALUES ($1, 'message.received', $2, 'routine')`,
    [uid, at(d)]);
  const stayed = await person('+972601029001', '2026-09-16'); // 14 days: the young edge
  await said(stayed, '2026-09-28');
  const lapsed = await person('+972601029002', '2026-09-03'); // 27 days: the old edge
  await said(lapsed, '2026-09-10');
  await person('+972601029003', '2026-09-17'); // 13 days: too new
  const old = await person('+972601029004', '2026-09-02'); // 28 days: too old
  await said(old, '2026-09-29');
  const bot = await person('+972601029005', '2026-09-10', ', is_eval = true');
  await said(bot, '2026-09-29');

  await withTx(db.pool, (c) => metrics.rollupDay(c, DAY));
  const { rows } = await db.pool.query(`SELECT metric, value FROM product_metrics_daily WHERE date = $1`, [DAY]);
  const v = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(v.cohort_2_4w, 2);
  assert.equal(v.cohort_2_4w_active, 1);
});

test('the admin block and the report say the cohort as two counts, and nothing without it', () => {
  const rows = [
    { date: DAY, metric: 'weekly_active_users', value: 15 },
    { date: DAY, metric: 'cohort_2_4w', value: 7 },
    { date: DAY, metric: 'cohort_2_4w_active', value: 3 },
  ];
  assert.match(section.goalBlock(rows, DAY), /הצטרפו לפני 2–4 שבועות: <b>7<\/b> · 3 מהם פעילים השבוע/);
  assert.doesNotMatch(section.goalBlock(rows.slice(0, 1), DAY), /2–4 שבועות/);

  const base = { asOf: DAY, wau: 15, lastWeek: null, joined: { friend_link: 0, room: 0, invite: 0, direct: 0 }, clicks: 0, rooms: null, tests: [] };
  assert.match(report.reportText({ ...base, retention: { cohort: 7, active: 3 } }), /^הצטרפו לפני 2–4 שבועות: 7 — 3 מהם פעילים השבוע$/m);
  assert.doesNotMatch(report.reportText({ ...base, retention: null }), /2–4 שבועות/);
  assert.doesNotMatch(report.reportText({ ...base, retention: { cohort: 7, active: 3 } }), /%/, 'counts, not a rate');
});
