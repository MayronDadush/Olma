'use strict';
// The invitation to a friend and the growth numbers it is read by (owner,
// 2026-09-30: the goal is 100 weekly active users).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const referral = require('../src/domain/referral');
const metrics = require('../src/jobs/metrics');
const section = require('../src/adapters/http/admin/sections/metrics');

test('the code is a bijection of the id, five characters of the alphabet', () => {
  const seen = new Set();
  for (let id = 1; id <= 3000; id++) {
    const c = referral.codeFor(id);
    assert.match(c, new RegExp(`^[${referral.ALPHABET}]{5}$`));
    assert.equal(referral.idFor(c), id);
    assert.ok(!seen.has(c)); seen.add(c);
  }
  assert.equal(referral.codeFor(0), null);
  assert.equal(referral.codeFor('x'), null);
  assert.equal(referral.idFor('AAAA'), null);
  assert.equal(referral.idFor('AAAA1'), null, '1 is not in the alphabet');
});

test('the code is found in the prefilled sentence, and not inside words', () => {
  const c = referral.codeFor(42);
  assert.deepEqual(referral.candidateIds(`היי עולמה 👋 הגעתי דרך דנה (קוד ${c})`), [42]);
  assert.deepEqual(referral.candidateIds(`Hi Allma 👋 Dana sent me (code ${c})`), [42]);
  assert.deepEqual(referral.candidateIds(`X${c}`), [], 'embedded in a longer token');
  assert.deepEqual(referral.candidateIds(c.toLowerCase()), [], 'typed, not pasted');
  assert.deepEqual(referral.candidateIds(null), []);
});

test('the invitation: the link carries the code, and the share text carries the link', () => {
  const he = referral.inviteFor({ id: 7, firstName: ' דנה ', locale: 'he' });
  assert.equal(he.code, referral.codeFor(7));
  const words = decodeURIComponent(he.link.split('?text=')[1]);
  assert.equal(words, `היי עולמה 👋 הגעתי דרך דנה (קוד ${he.code})`);
  assert.ok(he.link.startsWith(`https://wa.me/${referral.WA_NUMBER}?text=`));
  assert.ok(he.share.endsWith(he.link));
  assert.equal(decodeURIComponent(he.shareUrl.split('?text=')[1]), he.share);
  const en = referral.inviteFor({ id: 7, firstName: null, locale: 'en' });
  assert.equal(decodeURIComponent(en.link.split('?text=')[1]), `Hi Allma 👋 a friend sent me (code ${en.code})`);
  assert.match(en.share, /^Have you met Allma\?/);
  assert.equal(referral.inviteFor({ id: null }), null);
});

test('goalBlock reads the headcount on its day and sums only the joins', () => {
  const today = '2026-09-30';
  const rows = [
    { date: '2026-09-30', metric: 'weekly_active_users', value: 23 },
    { date: '2026-09-23', metric: 'weekly_active_users', value: 19 },
    { date: '2026-09-30', metric: 'joined_room', value: 2 },
    { date: '2026-09-27', metric: 'joined_room', value: 1 },
    { date: '2026-09-10', metric: 'joined_room', value: 4 },
    { date: '2026-09-30', metric: 'wau_room', value: 11 },
  ];
  const html = section.goalBlock(rows, today);
  assert.match(html, /23 מתוך 100/);
  assert.match(html, /לפני שבוע: 19/);
  assert.match(html, /קבוצה<\/td><td>3<\/td><td>7<\/td><td>11<\/td>/);
  assert.match(html, /קישור מחבר<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/, 'no row yet is a dash');
  assert.equal(section.goalBlock([], today), '', 'nothing counted, nothing drawn');
});

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

test('weekly_active_users: wrote or used the page in seven days, real people only', async () => {
  const mk = async (phone, via, extra = '') => {
    const u = await makeUser(db.pool, phone);
    await db.pool.query(`UPDATE users SET status = 'active', agent_id = $2, joined_via = $3 ${extra} WHERE id = $1`,
      [u.id, `u-${u.id}`, via]);
    return u.id;
  };
  const writer = await mk('+972601009001', 'room');
  const tapper = await mk('+972601009002', 'friend_link');
  const stale = await mk('+972601009003', 'direct');
  const evalBot = await mk('+972601009004', 'direct', ', is_eval = true');
  const devAcct = await mk('+972601009005', 'direct', ', is_test = true');
  const day = '2026-09-20';
  const at = (d) => `${d} 12:00:00+00`;
  const ins = (id, ev, d) => db.pool.query(
    `INSERT INTO audit_log (actor_id, event, created_at, retention_class) VALUES ($1, $2, $3, 'routine')`, [id, ev, at(d)]);
  await ins(writer, 'message.received', '2026-09-14');
  await ins(tapper, 'dashboard.editTask', '2026-09-20');
  await ins(stale, 'message.received', '2026-09-13'); // eight days before
  await ins(stale, 'task.created', '2026-09-19'); // not something THEY did
  await ins(evalBot, 'message.received', '2026-09-20');
  await ins(devAcct, 'message.received', '2026-09-20');
  await db.pool.query(`UPDATE users SET onboarded_at = $2 WHERE id = $1`, [tapper, at(day)]);

  await withTx(db.pool, (c) => metrics.rollupDay(c, day));
  const { rows } = await db.pool.query(
    `SELECT metric, value FROM product_metrics_daily WHERE date = $1`, [day]);
  const v = Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
  assert.equal(v.weekly_active_users, 2);
  assert.equal(v.wau_room, 1);
  assert.equal(v.wau_friend_link, 1);
  assert.equal(v.wau_direct, 0);
  assert.equal(v.joined_friend_link, 1);
});

test('the page payload carries the invitation, built from the id', async () => {
  const dash = require('../src/domain/user-dashboard');
  const u = await makeUser(db.pool, '+972601009010', { firstName: 'רון' });
  const res = await withTx(db.pool, (c) => dash.load(c, u.id));
  assert.equal(res.ok, true);
  assert.equal(res.data.invite.code, referral.codeFor(u.id));
  assert.match(decodeURIComponent(res.data.invite.link), /הגעתי דרך רון/);
});
