'use strict';
// The rooms as a funnel (owner, 2026-10-01): of the people in a room with
// her, how many have met her and how many were active in the week.
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

const DAY = '2026-09-20';
const at = (d) => `${d} 12:00:00+00`;

test('room funnel: in a room, met her, active — each a subset, as of the date', async () => {
  const room = async (jid, state = 'open') => (await db.pool.query(
    `INSERT INTO chat_groups (external_id, state) VALUES ($1, $2) RETURNING id`, [jid, state])).rows[0].id;
  const a = await room('1@g.us');
  const b = await room('2@g.us');
  const gone = await room('3@g.us', 'retired');
  const person = async (phone, { met = false, extra = '' } = {}) => {
    const u = await makeUser(db.pool, phone);
    if (met) {
      await db.pool.query(`UPDATE users SET status = 'active', agent_id = $2, onboarded_at = $3 ${extra} WHERE id = $1`,
        [u.id, `u-${u.id}`, at('2026-09-01')]);
    } else {
      await db.pool.query(`UPDATE users SET status = 'pending', agent_id = NULL ${extra} WHERE id = $1`, [u.id]);
    }
    return u.id;
  };
  const join = (g, uid, phone, { first = '2026-09-01', left = null } = {}) => db.pool.query(
    `INSERT INTO chat_group_members (group_id, phone, user_id, first_seen_at, left_at) VALUES ($1, $2, $3, $4, $5)`,
    [g, phone, uid, at(first), left && at(left)]);
  const said = (uid, d) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at, retention_class) VALUES ($1, 'message.received', $2, 'routine')`,
    [uid, at(d)]);

  const active = await person('+972601019001', { met: true });
  await join(a, active, '972601019001');
  await join(b, active, '972601019001'); // two rooms, one person
  await said(active, '2026-09-18');
  const quiet = await person('+972601019002', { met: true });
  await join(a, quiet, '972601019002');
  await said(quiet, '2026-09-10'); // outside the week
  const roster = await person('+972601019003');
  await join(a, roster, '972601019003');
  const lateJoiner = await person('+972601019004');
  await join(a, lateJoiner, '972601019004', { first: '2026-09-25' }); // not yet in the room on DAY
  const leftBefore = await person('+972601019005');
  await join(a, leftBefore, '972601019005', { left: '2026-09-15' });
  const leftAfter = await person('+972601019006');
  await join(a, leftAfter, '972601019006', { left: '2026-09-25' }); // still in on DAY
  const retiredOnly = await person('+972601019007');
  await join(gone, retiredOnly, '972601019007');
  const evalBot = await person('+972601019008', { met: true, extra: ', is_eval = true' });
  await join(a, evalBot, '972601019008');
  await said(evalBot, '2026-09-19');
  const outsider = await person('+972601019009', { met: true }); // active, in no room
  await said(outsider, '2026-09-19');

  await withTx(db.pool, (c) => metrics.rollupDay(c, DAY));
  const { rows } = await db.pool.query(`SELECT metric, value FROM product_metrics_daily WHERE date = $1`, [DAY]);
  const v = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(v.room_people, 4, 'active, quiet, roster, leftAfter');
  assert.equal(v.room_people_met, 2, 'active, quiet');
  assert.equal(v.room_people_active, 1, 'active');
});

test('the admin goal block and the report both say the funnel, and say nothing without it', () => {
  const today = '2026-09-30';
  const rows = [
    { date: today, metric: 'weekly_active_users', value: 15 },
    { date: today, metric: 'room_people', value: 40 },
    { date: today, metric: 'room_people_met', value: 9 },
    { date: today, metric: 'room_people_active', value: 6 },
  ];
  const html = section.goalBlock(rows, today);
  assert.match(html, /בקבוצות עם עולמה: <b>40<\/b> אנשים · 9 מהם כבר אצלה · 6 פעילים השבוע/);
  assert.doesNotMatch(section.goalBlock(rows.slice(0, 1), today), /בקבוצות עם עולמה/);

  const base = { asOf: today, wau: 15, lastWeek: null, joined: { friend_link: 0, room: 0, invite: 0, direct: 0 }, clicks: 0, tests: [] };
  assert.match(report.reportText({ ...base, rooms: { people: 40, met: 9, active: 6 } }),
    /\nבקבוצות עם עולמה: 40 אנשים — 9 כבר אצלה, 6 פעילים השבוע$/m);
  assert.doesNotMatch(report.reportText({ ...base, rooms: null }), /בקבוצות/);
});
