'use strict';
// Who opens their own page, and who gets a morning or evening summary — the
// two admin sections in admin/sections/reach.js. The first test is the one
// the owner asked for by name: his own "פתיחה" from the admin user page must
// never count as the person opening their page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const auth = require('../src/domain/dashboard-auth');
const opens = require('../src/domain/dashboard-opens');
const digestStats = require('../src/domain/digest-stats');
const flags = require('../src/domain/flags');
const reach = require('../src/adapters/http/admin/sections/reach');

const AUTH = 'Basic ' + Buffer.from('admin:test-password-123').toString('base64');
let db, server, base;

before(async () => {
  db = await freshDb();
  await withTx(db.pool, (c) => flags.setFlag(c, 'public_base_url', 'https://allma.world'));
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];
const opensOf = async (uid) => (await db.pool.query(
  `SELECT by_admin FROM dashboard_opens WHERE user_id = $1 ORDER BY id`, [uid])).rows.map((r) => r.by_admin);

async function ownSignIn(uid) {
  const made = await withTx(db.pool, (c) => auth.createLink(c, uid));
  const res = await get('/d/' + made.data.token, { method: 'POST' });
  assert.equal(res.status, 303);
  return cookieFrom(res);
}

async function adminSignIn(uid, cookie = '') {
  const csrf = 'c-opens-' + uid;
  const res = await get('/users/dashboard', {
    method: 'POST',
    headers: { Authorization: AUTH, Cookie: `csrf=${csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `id=${uid}&back=/&csrf=${csrf}`,
  });
  assert.equal(res.status, 303);
  const link = new URL(res.headers.get('location')).pathname;
  // His browser may already hold this person's session from a previous click.
  if (cookie) {
    const peek = await get(link, { headers: { Cookie: cookie } });
    assert.equal(peek.status, 303, 'a signed-in browser should go straight through');
    return cookie;
  }
  const post = await get(link, { method: 'POST' });
  assert.equal(post.status, 303);
  return cookieFrom(post);
}

test('the owner opening a page from the admin is marked, and never counted as the person', async () => {
  const u = await makeUser(db.pool, '+972531960001', { firstName: 'Dana' });
  const theirs = await ownSignIn(u.id);
  assert.equal((await get('/me', { headers: { Cookie: theirs } })).status, 200);

  const his = await adminSignIn(u.id);
  assert.equal((await get('/me', { headers: { Cookie: his } })).status, 200);
  // A second click on "פתיחה" with the session still in his browser: the GET
  // on the new link goes straight to /me, and the old session's mark holds.
  await adminSignIn(u.id, his);

  assert.deepEqual(await opensOf(u.id), [false, true], 'one of hers, one of his');
  const { rows: [s] } = await db.pool.query(
    `SELECT count(*) FILTER (WHERE by_admin)::int AS admin, count(*)::int AS n FROM dashboard_sessions WHERE user_id = $1`, [u.id]);
  assert.deepEqual(s, { admin: 1, n: 2 });

  const sum = await withTx(db.pool, (c) => opens.summary(c));
  const row = sum.people.find((p) => Number(p.id) === u.id);
  assert.equal(row.opens, 1, 'his visit was counted as hers');
  assert.ok(sum.totals.admin_opens >= 1, 'the page must say how many of his it left out');
});

test('loads inside half an hour are one visit; the JSON behind the page is not a visit', async () => {
  const u = await makeUser(db.pool, '+972531960002', { firstName: 'Eli' });
  const c = await ownSignIn(u.id);
  for (let i = 0; i < 3; i++) await get('/me', { headers: { Cookie: c } });
  await get('/me/data', { headers: { Cookie: c } });
  assert.deepEqual(await opensOf(u.id), [false]);
  await db.pool.query(`UPDATE dashboard_opens SET opened_at = now() - interval '31 minutes' WHERE user_id = $1`, [u.id]);
  await get('/me', { headers: { Cookie: c } });
  assert.deepEqual(await opensOf(u.id), [false, false]);
});

test('a signed-out /me and a test account count nothing toward the people', async () => {
  const u = await makeUser(db.pool, '+972531960003', { firstName: 'Tal' });
  await get('/me');
  await db.pool.query(`UPDATE users SET is_test = true WHERE id = $1`, [u.id]);
  const c = await ownSignIn(u.id);
  await get('/me', { headers: { Cookie: c } });
  const sum = await withTx(db.pool, (cl) => opens.summary(cl));
  assert.equal(sum.people.find((p) => Number(p.id) === u.id), undefined);
  assert.ok(sum.totals.test_opens >= 1);
});

test('the opens section renders, empty and full', async () => {
  const html = await withTx(db.pool, (c) => reach.renderDashboardOpens(c));
  assert.ok(html.includes('Dana') && html.includes('פתיחות שלך'));
  const empty = reach.renderOpensView({ days: 30, people: [], byHour: [], byDay: [],
    totals: { opens: 0, people: 0, opens7: 0, people7: 0, admin_opens: 0, test_opens: 0, counting_since: null } });
  assert.ok(empty.includes('אף אחד לא פתח'));
});

// ---- digests ------------------------------------------------------------------

async function digestRow(uid, key, { hold = null, hoursAgo = 1 } = {}) {
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, idempotency_key, sent_at, hold_reason)
     VALUES ($1, 'digest', '{}', $2, now() - ($3 || ' hours')::interval, $4)`,
    [uid, key, String(hoursAgo), hold]);
}

test('who gets a morning or evening summary, and what actually reached them', async () => {
  const a = await makeUser(db.pool, '+972531960011', { firstName: 'Morning' });
  const b = await makeUser(db.pool, '+972531960012', { firstName: 'Paused' });
  await db.pool.query(
    `UPDATE users SET digest_times = '08:00,20:00', onboarded_at = now(), timezone = 'Asia/Jerusalem' WHERE id = $1`, [a.id]);
  await db.pool.query(
    `UPDATE users SET digest_times = '09:00', onboarded_at = now(), paused_at = now(), timezone = 'Asia/Jerusalem' WHERE id = $1`, [b.id]);
  await digestRow(a.id, `digest:${a.id}:2026-10-01:08:00`);
  await digestRow(a.id, `digest:${a.id}:2026-10-02:08:00`, { hoursAgo: 30 });
  await digestRow(a.id, `digest:${a.id}:2026-10-02:20:00`, { hold: 'quiet' });
  await digestRow(a.id, `owner-digest:${a.id}:2026-10-03`);

  const s = await withTx(db.pool, (c) => digestStats.summary(c));
  const pa = s.people.find((p) => p.id === a.id);
  const pb = s.people.find((p) => p.id === b.id);
  assert.equal(pa.state, 'on');
  assert.equal(pb.state, 'paused');
  assert.deepEqual(pa.slots.map((x) => [x.slot, x.part, x.arrived]), [['08:00', 'morning', 2], ['20:00', 'evening', 0]]);
  assert.equal(pa.manual, 1, 'a digest sent by hand is not a slot');
  assert.deepEqual(pa.reasons, { quiet: 1 });
  // The paused person is set but will not get one, so is not in the headcount.
  assert.equal(s.parts.morning, 1);
  assert.equal(s.parts.evening, 1);

  const html = reach.renderDigestView(s);
  assert.ok(html.includes('Morning') && html.includes('לא ענה לבדיקה'));
});

test('daily_once_phones is 20:00 whatever digest_times says, and the hour matches the sweep', async () => {
  const { DAILY_ONCE_AT } = require('../src/jobs/sweeps');
  assert.equal(digestStats.DAILY_ONCE_AT, DAILY_ONCE_AT);
  const u = await makeUser(db.pool, '+972531960021', { firstName: 'Once' });
  await db.pool.query(`UPDATE users SET digest_times = '08:00', onboarded_at = now() WHERE id = $1`, [u.id]);
  await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', '+972531960021'));
  const s = await withTx(db.pool, (c) => digestStats.summary(c));
  const p = s.people.find((x) => x.id === u.id);
  assert.equal(p.dailyOnce, true);
  assert.deepEqual(p.times, ['20:00']);
  await withTx(db.pool, (c) => flags.setFlag(c, 'daily_once_phones', ''));
});

test('partOf: morning before noon, evening from five, and the gap is its own word', () => {
  assert.equal(digestStats.partOf('09:35'), 'morning');
  assert.equal(digestStats.partOf('14:00'), 'noon');
  assert.equal(digestStats.partOf('17:00'), 'evening');
  assert.equal(digestStats.partOf(''), null);
});
