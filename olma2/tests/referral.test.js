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

test('the invitation: a short link of ours in the share text, landing on the chat link', () => {
  const he = referral.inviteFor({ id: 7, firstName: ' דנה ', locale: 'he' });
  assert.equal(he.code, referral.codeFor(7));
  assert.equal(he.link, `https://allma.world/i/${he.code}`);
  assert.match(new URL(he.link).pathname, referral.SHORT_PATH_RE);
  const words = decodeURIComponent(he.chatLink.split('?text=')[1]);
  assert.equal(words, `היי עולמה 👋 הגעתי דרך דנה (קוד ${he.code})`);
  assert.ok(he.chatLink.startsWith(`https://wa.me/${referral.WA_NUMBER}?text=`));
  assert.ok(he.share.endsWith(he.link));
  assert.ok(he.share.length < 150, 'no percent-encoded wall in the message');
  assert.equal(decodeURIComponent(he.shareUrl.split('?text=')[1]), he.share);
  const en = referral.inviteFor({ id: 7, firstName: null, locale: 'en' });
  assert.equal(decodeURIComponent(en.chatLink.split('?text=')[1]), `Hi Allma 👋 a friend sent me (code ${en.code})`);
  assert.equal(he.share, `תנסו את עולמה, עוזרת אישית בוואטסאפ 👇\n${he.link}`);
  assert.equal(en.share, `Try Allma, a personal assistant on WhatsApp 👇\n${en.link}`);
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
    { date: '2026-09-29', metric: 'referral_clicks', value: 5 },
    { date: '2026-09-15', metric: 'referral_clicks', value: 2 },
  ];
  const html = section.goalBlock(rows, today);
  assert.match(html, /23 מתוך 100/);
  assert.match(html, /לפני שבוע: 19/);
  assert.match(html, /קבוצה<\/td><td>3<\/td><td>7<\/td><td>11<\/td>/);
  assert.match(html, /קישור מחבר<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/, 'no row yet is a dash');
  assert.match(html, /קישורי הזמנה: <b>5<\/b> ב־7 ימים · 7 ב־30 יום/);
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
  assert.match(decodeURIComponent(res.data.invite.chatLink), /הגעתי דרך רון/);
});

// ---- the short link itself, through the real router ----
const http = require('node:http');
const { createDashboard } = require('../src/adapters/http/dashboard');
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
function get(server, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { Host: 'allma.world', ...headers }, setHost: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const clicksOf = async (id) => Number((await db.pool.query(
  `SELECT count(*) FROM audit_log WHERE actor_id = $1 AND event = 'referral.clicked'`, [id])).rows[0].count);

test('/i/<code>: a tap is counted and lands on the chat; a preview is not counted; nobody is attributed to a stranger', async () => {
  const server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const u = await makeUser(db.pool, '+972601009020', { firstName: 'מיכל' });
    await db.pool.query(`UPDATE users SET status = 'active', agent_id = $2 WHERE id = $1`, [u.id, `u-${u.id}`]);
    const code = referral.codeFor(u.id);

    const tap = await get(server, `/i/${code}`, { 'User-Agent': PHONE_UA });
    assert.equal(tap.status, 302);
    assert.ok(tap.location.startsWith(`https://wa.me/${referral.WA_NUMBER}?text=`));
    assert.equal(decodeURIComponent(tap.location.split('?text=')[1]), `היי עולמה 👋 הגעתי דרך מיכל (קוד ${code})`);
    assert.equal(await clicksOf(u.id), 1);

    // The SENDING phone fetches the link to draw the card: our card, no count.
    const preview = await get(server, `/i/${code}`, { 'User-Agent': 'WhatsApp/2.24.1 i' });
    assert.equal(preview.status, 200);
    assert.match(preview.body, /og:url" content="https:\/\/allma\.world\/i\//);
    assert.match(preview.body, /http-equiv="refresh"/);
    assert.equal((await get(server, `/i/${code}`, { 'User-Agent': PHONE_UA }, 'HEAD')).status, 200);
    assert.equal(await get(server, `/i/${code}`, {}).then((r) => r.status), 200, 'no user agent is not a person');
    assert.equal(await clicksOf(u.id), 1);

    // A code naming nobody still opens a chat with her, attributed to no one.
    const eval_ = await makeUser(db.pool, '+972601009021');
    await db.pool.query(`UPDATE users SET status = 'active', agent_id = $2, is_eval = true WHERE id = $1`, [eval_.id, `u-${eval_.id}`]);
    for (const c of [referral.codeFor(eval_.id), referral.codeFor(999999)]) {
      const r = await get(server, `/i/${c}`, { 'User-Agent': PHONE_UA });
      assert.equal(r.status, 302);
      assert.equal(decodeURIComponent(r.location.split('?text=')[1]), 'היי עולמה 👋');
    }
    assert.equal(await clicksOf(eval_.id), 0);

    // Off the exact shape it is not this route (Caddy never passes it either).
    assert.equal((await get(server, `/i/${code}x`, { 'User-Agent': PHONE_UA })).status, 401);
    assert.equal((await get(server, `/i/${code.toLowerCase()}`, { 'User-Agent': PHONE_UA })).status, 401);

    // …and the day's count reaches the metric.
    // The row's own day, never the clock's: a tap at 23:59:59 is yesterday's.
    const today = (await db.pool.query(`SELECT created_at::date::text AS d FROM audit_log
      WHERE actor_id = $1 AND event = 'referral.clicked'`, [u.id])).rows[0].d;
    await withTx(db.pool, (c) => metrics.rollupDay(c, today));
    const { rows } = await db.pool.query(
      `SELECT value FROM product_metrics_daily WHERE date = $1 AND metric = 'referral_clicks'`, [today]);
    assert.equal(Number(rows[0].value), 1);
  } finally {
    server.close();
  }
});
