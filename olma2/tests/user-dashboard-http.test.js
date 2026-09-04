'use strict';
// The personal dashboard over real HTTP, through the same server the operator
// page is served by. Mostly it tests what does NOT happen: what a link does on
// GET, what a signed-out request gets, and what the admin password does and
// does not open.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const auth = require('../src/domain/dashboard-auth');

let db, server, base, me;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531930001', { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const newToken = async () => {
  const r = await withTx(db.pool, (c) => auth.createLink(c, me.id));
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  return r.data.token;
};
// The cookie the browser would send back. Set-Cookie carries Secure, which a
// real browser honours over HTTPS; the test server is plain http, so the value
// is read off the header rather than through a cookie jar.
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];

async function signIn() {
  const token = await newToken();
  const res = await get('/d/' + token, { method: 'POST' });
  assert.equal(res.status, 303);
  return cookieFrom(res);
}

test('GET on a link shows a button and spends nothing — the crawler rule', async () => {
  const token = await newToken();
  const res = await get('/d/' + token);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Miron'), 'the page does not greet the person it is for');
  assert.ok(html.includes('method="POST"'), 'the button is not a POST, so a preview would spend the link');
  assert.equal(res.headers.get('set-cookie'), null, 'a GET opened a session');
  // Still usable: WhatsApp fetching it for a preview must not have burned it.
  const post = await get('/d/' + token, { method: 'POST' });
  assert.equal(post.status, 303, 'the link was spent by being looked at');
});

test('POST on a link opens a session and sends you to the page', async () => {
  const token = await newToken();
  const res = await get('/d/' + token, { method: 'POST' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/me');
  const setCookie = String(res.headers.get('set-cookie'));
  for (const bit of ['HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(setCookie.includes(bit), `cookie missing ${bit}`);
  }
  const again = await get('/d/' + token, { method: 'POST' });
  assert.equal(again.status, 410, 'a spent link opened a second session');
});

test('an unknown or malformed link is a dead end, not a 500', async () => {
  for (const p of ['/d/' + 'f'.repeat(64), '/d/nothex', '/d/']) {
    const res = await get(p);
    assert.ok(res.status === 410 || res.status === 401 || res.status === 404,
      `${p} answered ${res.status}`);
  }
});

test('the page needs a session, and the admin password is not one', async () => {
  const anon = await get('/me');
  assert.equal(anon.status, 401);
  assert.ok((await anon.text()).includes('קישור'), 'the refusal does not say how to get in');

  const admin = await get('/me', {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:test-password-123').toString('base64') },
  });
  assert.equal(admin.status, 401,
    'the operator password opened a private page it has no identity for');
});

test('a signed-in request gets the real page, and it is not indexable or cacheable', async () => {
  const cookie = await signIn();
  const res = await get('/me', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.match(res.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /connect-src 'self'/, 'a script on this page could ship the contents anywhere');
  assert.match(csp, /frame-ancestors 'none'/);
  const html = await res.text();
  assert.ok(html.length > 100_000 && html.includes('<title>'), 'that is not the dashboard');
});

test('the data endpoint answers only the person it belongs to', async () => {
  const anon = await get('/me/data');
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).error.code, 'unauthorized');
  assert.match(anon.headers.get('content-type') || '', /application\/json/,
    'the page fetches this — an HTML body reads as a parse error, not a 401');

  const cookie = await signIn();
  const res = await get('/me/data', { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(String(body.data.user.id), String(me.id));
  assert.equal(JSON.stringify(body).includes(me.phone), false, 'a phone number reached the browser');
});

test('a write needs a session, a POST, and an origin of ours', async () => {
  const cookie = await signIn();
  assert.equal((await get('/me/act', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await get('/me/act', { method: 'GET', headers: { cookie } })).status, 405);

  const forged = await get('/me/act', {
    method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'addTask', payload: { title: 'לא שלי' } }),
  });
  assert.equal(forged.status, 403, 'another origin wrote to this account');
});

test('a write lands, and comes back on the very next read', async () => {
  const cookie = await signIn();
  const res = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'addTask', payload: { title: 'לתקן את הדוד' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  const page = await (await get('/me/data', { headers: { cookie } })).json();
  assert.equal(page.data.tasks.some((t) => t.title === 'לתקן את הדוד'), true);
});

test('a refused write carries its reason and a status that agrees with it', async () => {
  const cookie = await signIn();
  const unknown = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'wipeEverything' }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'invalid');

  const missing = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'completeTask', payload: { taskId: 99999 } }),
  });
  assert.equal(missing.status, 404);

  const junk = await get('/me/act', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: 'not json',
  });
  assert.equal(junk.status, 400);
});

test('signing out ends it, and the cookie goes with it', async () => {
  const cookie = await signIn();
  const out = await get('/me/out', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 303);
  assert.match(String(out.headers.get('set-cookie')), /Max-Age=0/);
  assert.equal((await get('/me/data', { headers: { cookie } })).status, 401);
});

test('a nearly-ours path falls through to the operator page, not to us', async () => {
  // /mesh and /me/x are not this router's business; answering them here would
  // quietly put a chunk of the admin surface behind the wrong identity model.
  for (const p of ['/mesh', '/me/x', '/medata']) {
    const res = await get(p);
    assert.equal(res.status, 401);
    assert.ok((res.headers.get('www-authenticate') || '').startsWith('Basic'),
      `${p} was answered by the personal dashboard`);
  }
});

test('the payload carries every field the page reads out of it', async () => {
  // The page and the server are one file apart and there is no type between
  // them, so this is the contract. Each name here is read by `hydrate()` in
  // docs/design/user-dashboard.html; renaming one on the server without
  // renaming it there produces a page that renders with a piece missing and no
  // error anywhere — the failure this list exists to turn into a red test.
  const tasks = require('../src/domain/tasks');
  const shares = require('../src/domain/shares');
  const connections = require('../src/domain/connections');
  const friend = await makeUser(db.pool, '+972531930002', { firstName: 'Gali' });

  const mine = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'קניות' }));
  const req = await withTx(db.pool, (c) => connections.requestConnection(c, me.id, friend.phone));
  await withTx(db.pool, (c) =>
    connections.respondToConnection(c, friend.id, req.data.connection.id, 'approve'));
  const offer = await withTx(db.pool, (c) =>
    shares.offerShare(c, me.id, mine.data.task.id, friend.id, 'viewer'));
  await withTx(db.pool, (c) => shares.respondToShare(c, friend.id, offer.data.share.id, 'accept'));
  const done = await withTx(db.pool, (c) => tasks.addTask(c, me.id, { title: 'לחדש ביטוח' }));
  await withTx(db.pool, (c) => tasks.completeTask(c, me.id, done.data.task.id));
  await withTx(db.pool, (c) => tasks.archiveTask(c, me.id, done.data.task.id));

  const cookie = await signIn();
  const { data } = await (await get('/me/data', { headers: { cookie } })).json();

  for (const k of ['id', 'firstName', 'timezone', 'timezoneConfirmed', 'paused']) {
    assert.ok(k in data.user, `user.${k} is gone — the page reads it`);
  }
  const shared = data.tasks.find((t) => t.who.length);
  assert.ok(shared, 'no shared task came back');
  for (const k of ['id', 'title', 'category', 'date', 'time', 'allDay',
    'reminder', 'items', 'mine', 'owner', 'who', 'source', 'caps']) {
    assert.ok(k in shared, `task.${k} is gone — the page reads it`);
  }
  assert.ok('shareId' in shared.who[0], 'who[].shareId is gone — removing a person needs it');
  assert.ok('completedAt' in data.archived[0], 'archived[].completedAt is gone — the "when" is built from it');
  for (const k of ['id', 'connectionId', 'name', 'timezone', 'since', 'features']) {
    assert.ok(k in data.friends[0], `friend.${k} is gone — the page reads it`);
  }
  for (const k of ['provider', 'connected', 'needsReauth', 'access', 'account']) {
    assert.ok(k in (data.integrations[0] || { [k]: null }), `integration.${k} is gone`);
  }
});

test('the served page really is the one that knows how to hydrate', async () => {
  // Serving a copy that predates the wiring would produce a page showing seed
  // fixtures to a real person — the one outcome the hydration comment calls
  // out as worse than either extreme.
  const cookie = await signIn();
  const html = await (await get('/me', { headers: { cookie } })).text();
  assert.ok(html.includes('/me/data'), 'the served page never asks for any data');
  assert.ok(html.includes('/me/act'), 'the served page cannot write anything back');
});
