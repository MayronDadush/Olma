'use strict';
// The apps on the home screen of somebody's own page (domain/user-apps.js):
// one icon per pack they hold, in place of the invitation, and a tap that
// goes to their own page in that app. Through the real routes, /me/data and
// /me/act, with gamesd and foodd stood in for by one local server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const auth = require('../src/domain/dashboard-auth');
const userApps = require('../src/domain/user-apps');

let db, server, base, svc, asked, answers;

before(async () => {
  db = await freshDb();
  svc = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ url: req.url, body: JSON.parse(body || '{}') });
      const a = answers[req.url];
      if (a === 'down' || a === undefined) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(typeof a === 'function' ? a(JSON.parse(body || '{}')) : a));
    });
  });
  await new Promise((r) => svc.listen(0, '127.0.0.1', r));
  const svcUrl = `http://127.0.0.1:${svc.address().port}`;
  process.env.OLMA_GAMESD_URL = svcUrl;
  process.env.OLMA_FOODD_URL = svcUrl;
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  delete process.env.OLMA_GAMESD_URL;
  delete process.env.OLMA_FOODD_URL;
  server.close();
  await new Promise((r) => svc.close(r));
  await db.teardown();
});

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];
async function signIn(userId) {
  const r = await withTx(db.pool, (c) => auth.createLink(c, userId));
  const res = await get('/d/' + r.data.token, { method: 'POST' });
  assert.equal(res.status, 303);
  return cookieFrom(res);
}
const grant = (userId, pack) =>
  db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, $2, 'owner')`, [userId, pack]);
const data = async (cookie) => (await (await get('/me/data', { headers: { cookie } })).json()).data;
const open = (cookie, app) => get('/me/act', {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'openApp', payload: { app } }),
});

const NIGHT = 'https://allma.test/night/AAAAAAAAAAAAAAAAAAAAAA#me-p1';
const OLD = 'https://allma.test/night/BBBBBBBBBBBBBBBBBBBBBB#me-p2';

test('somebody with both packs sees both, in order, and an open night is a badge', async () => {
  const u = await makeUser(db.pool, '+972531940001', { firstName: 'Miron' });
  await grant(u.id, 'games');
  await grant(u.id, 'food');
  const cookie = await signIn(u.id);
  asked = [];
  answers = { '/api/mine': { ok: true, nights: [{ code: 'QW3RT', status: 'open' }, { code: '8CACT', status: 'settled' }] } };
  const d = await data(cookie);
  assert.deepEqual(d.apps, [{ id: 'food', badge: 0 }, { id: 'games', badge: 1 }]);
  // The badge asks for no links: a count is all the home screen draws.
  assert.deepEqual(asked, [{ url: '/api/mine', body: { userId: u.id } }]);
});

test('somebody with food only sees food and asks gamesd nothing; nobody with none sees any', async () => {
  const maya = await makeUser(db.pool, '+972531940002', { firstName: 'Maya' });
  await grant(maya.id, 'food');
  asked = [];
  answers = {};
  assert.deepEqual((await data(await signIn(maya.id))).apps, [{ id: 'food', badge: 0 }]);
  assert.deepEqual(asked, []);

  const none = await makeUser(db.pool, '+972531940003', { firstName: 'Dana' });
  assert.deepEqual((await data(await signIn(none.id))).apps, []);
});

test('a gamesd that is down costs the badge, never the page', async () => {
  const u = await makeUser(db.pool, '+972531940004', { firstName: 'Yossi' });
  await grant(u.id, 'games');
  answers = { '/api/mine': 'down' };
  const res = await get('/me/data', { headers: { cookie: await signIn(u.id) } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.apps, [{ id: 'games', badge: 0 }]);
});

test('a tap on food goes to their food page, asked of foodd with who they are', async () => {
  const u = await makeUser(db.pool, '+972531940005', { firstName: 'Noa' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [u.id]);
  await grant(u.id, 'food');
  asked = [];
  answers = { '/api/page': { ok: true, url: 'https://allma.test/food/CCCCCCCCCCCCCCCCCCCCCC' } };
  const res = await open(await signIn(u.id), 'food');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, { url: 'https://allma.test/food/CCCCCCCCCCCCCCCCCCCCCC' });
  assert.deepEqual(asked, [{ url: '/api/page', body: { user: { id: u.id, name: 'Noa', timezone: 'Asia/Jerusalem', locale: 'he' } } }]);
});

test('a tap on games goes to the open night, else the newest, else a chat that starts one', async () => {
  const u = await makeUser(db.pool, '+972531940006', { firstName: 'Avi' });
  await grant(u.id, 'games');
  const cookie = await signIn(u.id);

  asked = [];
  answers = { '/api/mine': { ok: true, nights: [{ status: 'settled', url: OLD }, { status: 'open', url: NIGHT }] } };
  assert.equal((await (await open(cookie, 'games')).json()).data.url, NIGHT);
  assert.deepEqual(asked, [{ url: '/api/mine', body: { userId: u.id, links: true } }]);

  answers = { '/api/mine': { ok: true, nights: [{ status: 'settled', url: OLD }] } };
  assert.equal((await (await open(cookie, 'games')).json()).data.url, OLD);

  answers = { '/api/mine': { ok: true, nights: [] } };
  const url = (await (await open(cookie, 'games')).json()).data.url;
  assert.equal(url, userApps.newNightLink('he'));
  assert.match(decodeURIComponent(url), /text=ערב משחק חדש$/);
});

test('a pack they do not hold, an unknown app, and a service that is down are refused by name', async () => {
  const u = await makeUser(db.pool, '+972531940007', { firstName: 'Lior' });
  await grant(u.id, 'food');
  const cookie = await signIn(u.id);
  asked = [];
  const notMine = await open(cookie, 'games');
  assert.equal(notMine.status, 403);
  assert.equal((await notMine.json()).error.reason, 'not_enabled');
  assert.deepEqual(asked, [], 'asked a service about a pack they do not hold');
  assert.equal((await open(cookie, 'admin')).status, 400);
  // A gamesd from before `links` answers nights with no url: that is not "no
  // night", and must never send them to start one.
  const g = await makeUser(db.pool, '+972531940009', { firstName: 'Shir' });
  await grant(g.id, 'games');
  answers = { '/api/mine': { ok: true, nights: [{ status: 'open', code: 'QW3RT' }] } };
  const old = await open(await signIn(g.id), 'games');
  assert.equal(old.status, 503);
  answers = { '/api/page': 'down' };
  const down = await open(cookie, 'food');
  assert.equal(down.status, 503);
  assert.equal((await down.json()).error.code, 'unavailable');
});

test('openApp is a write-route action: no session, no tap; another origin, no tap', async () => {
  assert.equal((await get('/me/act', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'openApp', payload: { app: 'food' } }),
  })).status, 401);
  const u = await makeUser(db.pool, '+972531940008', { firstName: 'Tal' });
  await grant(u.id, 'food');
  const forged = await get('/me/act', {
    method: 'POST', headers: { cookie: await signIn(u.id), origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'openApp', payload: { app: 'food' } }),
  });
  assert.equal(forged.status, 403);
});
