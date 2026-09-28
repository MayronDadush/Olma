'use strict';
// The dashboard as a home-screen app (src/adapters/http/pwa.js) and the way
// into it on an iPhone — an eight-digit code (dashboard-auth.createCode,
// POST /me/code). Over real HTTP, through the same server the page is served
// by, because the two things most likely to break are both at that boundary:
// a route that falls through to the admin password, and a policy header that
// quietly blocks the manifest.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');
const userDashboard = require('../src/adapters/http/user-dashboard');
const pwa = require('../src/adapters/http/pwa');
const auth = require('../src/domain/dashboard-auth');

let db, server, base, me, en;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531940001', { firstName: 'Miron' });
  en = await makeUser(db.pool, '+447700900123', { firstName: 'Sarah' });
  await db.pool.query(`UPDATE users SET locale = 'en' WHERE id = $1`, [en.id]);
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.teardown(); });
beforeEach(() => userDashboard.resetCodeLimits());

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const cookieFrom = (res) => String(res.headers.get('set-cookie') || '').split(';')[0];
async function sessionFor(user) {
  const link = await withTx(db.pool, (c) => auth.createLink(c, user.id));
  const res = await get('/d/' + link.data.token, { method: 'POST' });
  return cookieFrom(res);
}
async function codeFor(user) {
  const r = await withTx(db.pool, (c) => auth.createCode(c, user.id));
  assert.equal(r.ok, true, JSON.stringify(r.error || ''));
  return r.data.code;
}
const postCode = (code, headers = {}) => get('/me/code', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ code }),
});

// ---- the manifest -----------------------------------------------------------
test('the manifest needs no sign-in and describes an installable app', async () => {
  const res = await get('/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'it is per-session, so never shared');
  const m = await res.json();
  assert.equal(m.id, '/me');
  assert.equal(m.start_url, '/me?hl=he', 'the signed-out app screen opens in the installer\'s language');
  assert.equal(m.scope, '/', 'a /d/ link must open inside the installed app on Android');
  assert.equal(m.display, 'standalone');
  assert.equal(m.name, 'עולמה');
  assert.equal(m.dir, 'rtl');
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable']);
  for (const i of m.icons) assert.ok(pwa.PATHS.has(i.src), `${i.src} is not a route pwa.js serves`);
  assert.deepEqual(m.shortcuts.map((s) => s.url), ['/me#new-task', '/me#new-meeting', '/me#tasks']);
});

test('the installed app is named in the language of whoever installs it', async () => {
  const res = await get('/manifest.webmanifest', { headers: { cookie: await sessionFor(en) } });
  const m = await res.json();
  assert.equal(m.name, 'Allma');
  assert.equal(m.lang, 'en');
  assert.equal(m.dir, 'ltr');
  assert.equal(m.start_url, '/me?hl=en');
  assert.equal(m.id, '/me', 'the identity of the installed app never follows the language');
  assert.equal(m.shortcuts[0].name, 'New task');
});

// ---- the icons --------------------------------------------------------------
// The first eight bytes of every PNG, then IHDR's width and height.
function pngSize(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 'not a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('each icon is a PNG of exactly the size it is declared as', async () => {
  for (const [p, spec] of Object.entries(pwa.ICONS)) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /^public, max-age=\d+$/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(pngSize(buf), [spec.size, spec.size], p);
  }
});

test('an icon the phone already has is answered 304', async () => {
  const first = await get('/icons/icon-192.png');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await get('/icons/icon-192.png', { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
});

test('a path that is nearly ours falls through to the admin password, never to an icon', async () => {
  for (const p of ['/icons/other.png', '/icons/', '/manifest.json', '/icons/icon-192.png/x']) {
    const res = await get(p);
    assert.equal(res.status, 401, p);
    assert.match(res.headers.get('www-authenticate') || '', /^Basic/, p);
  }
});

// ---- the offline screen -----------------------------------------------------
test('the service worker needs no sign-in and is never cached for long', async () => {
  const res = await get('/sw.js?hl=he');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'a stale worker is how a fix never arrives');
  const src = await res.text();
  assert.doesNotThrow(() => new Function(src), 'the worker must parse');
});

test('the worker caches nothing and answers only a failed navigation to the page', () => {
  const src = pwa.SW_SOURCE;
  assert.doesNotMatch(src, /caches\./, 'nothing of anybody\'s list may be kept on the phone');
  assert.match(src, /r\.mode !== "navigate"/, 'data and writes are never intercepted');
  assert.match(src, /fetch\(r\)\.catch\(/, 'the network is always asked first, and a reply it gives goes through');
});

test('the worker serves the offline screen in the language it was registered with', async () => {
  // Run the worker's own source against a stand-in `self`, so what is
  // asserted is what a phone would execute, not a copy of it.
  async function offlineFor(hl, url) {
    const handlers = {};
    const self = {
      location: { href: 'https://allma.world/sw.js' + (hl ? '?hl=' + hl : '') },
      addEventListener: (k, fn) => { handlers[k] = fn; },
      skipWaiting() {}, clients: { claim: () => Promise.resolve() },
    };
    const failing = () => Promise.reject(new TypeError('Failed to fetch'));
    new Function('self', 'fetch', 'Response', 'URL', pwa.SW_SOURCE)(self, failing, Response, URL);
    let answered = null;
    handlers.fetch({ request: { mode: 'navigate', method: 'GET', url }, respondWith: (p) => { answered = p; } });
    return answered && (await answered);
  }
  const he = await offlineFor('he', 'https://allma.world/me');
  assert.equal(he.status, 503);
  assert.match(he.headers.get('content-security-policy'), /default-src 'none'/);
  const heText = await he.text();
  assert.match(heText, /אין חיבור כרגע/);
  assert.match(heText, /dir="rtl"/);
  assert.match(await (await offlineFor('en', 'https://allma.world/d/abc')).text(), /No connection right now/);
  assert.equal(await offlineFor('he', 'https://allma.world/privacy'), null, 'other pages are left alone');
});

test('the page lets the browser read its manifest and its icon', async () => {
  const res = await get('/me', { headers: { cookie: await sessionFor(me) } });
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /worker-src 'self'/, 'without it the offline worker is refused silently');
  assert.match(csp, /connect-src 'self'/, 'the rest of the policy is unchanged');
  const html = await res.text();
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
  assert.equal((html.match(/<meta name="theme-color"/g) || []).length, 2, 'one per scheme');
});

// ---- the code ---------------------------------------------------------------
test('a code opens a session once, on the front page', async () => {
  const code = await codeFor(me);
  assert.match(code, /^\d{8}$/);
  const res = await postCode(code.slice(0, 4) + ' ' + code.slice(4));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const cookie = cookieFrom(res);
  assert.match(cookie, /^olma_dash=[a-f0-9]{64}$/);
  assert.equal((await get('/me/data', { headers: { cookie } })).status, 200);
  const twice = await postCode(code);
  assert.equal(twice.status, 400, 'a code is spent by being used');
});

test('asking again replaces the last code: the newest message is the one that works', async () => {
  const first = await codeFor(me);
  const second = await codeFor(me);
  assert.equal((await postCode(first)).status, 400);
  assert.equal((await postCode(second)).status, 200);
});

test('a code dies in ten minutes whether or not it was used', async () => {
  const code = await codeFor(me);
  await db.pool.query(
    `UPDATE magic_links SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND target = 'code'`, [me.id]);
  assert.equal((await postCode(code)).status, 400);
});

test('a code is not a link, and a link is not a code', async () => {
  // Five live links — the most a person holds — and a code on top: the code
  // pushes none of them out, and none of them pushes the code out.
  const links = [];
  for (let i = 0; i < auth.MAX_LIVE_LINKS; i += 1) {
    links.push((await withTx(db.pool, (c) => auth.createLink(c, en.id))).data.token);
  }
  const code = await codeFor(en);
  await withTx(db.pool, (c) => auth.createLink(c, en.id));
  const live = await db.pool.query(
    `SELECT target FROM magic_links WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at`, [en.id]);
  assert.equal(live.rows.filter((r) => r.target === 'code').length, 1, 'the code survived six links');
  assert.equal(live.rows.filter((r) => r.target !== 'code').length, auth.MAX_LIVE_LINKS);
  // A code never opens as /d/<…> (wrong shape), and a link token never as a code.
  assert.equal((await get('/d/' + code)).status, 401, 'eight digits is not a link shape — Basic Auth');
  assert.equal((await postCode(links[4])).status, 400);
  assert.equal((await postCode(code)).status, 200);
});

test('five wrong codes from one address close it; the right code then waits too', async () => {
  const code = await codeFor(me);
  for (let i = 0; i < userDashboard.CODE_MAX_PER_ADDRESS; i += 1) {
    const wrong = String((Number(code) + 1 + i) % 1e8).padStart(8, '0');
    assert.equal((await postCode(wrong)).status, 400);
  }
  const blocked = await postCode(code);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { ok: false, error: { code: 'rate_limited' } });
  userDashboard.resetCodeLimits();
  assert.equal((await postCode(code)).status, 200, 'a refusal for guessing did not spend the real code');
});

test('guesses from many addresses are capped in total', async () => {
  for (let i = 0; i < userDashboard.CODE_MAX_TOTAL; i += 1) {
    await postCode('00000000', { 'x-forwarded-for': `10.0.${Math.floor(i / 4)}.${i % 4}` });
  }
  const res = await postCode('00000000', { 'x-forwarded-for': '10.9.9.9' });
  assert.equal(res.status, 429, 'a fresh address still meets the global cap');
});

test('the code route takes a JSON POST from this origin and nothing else', async () => {
  assert.equal((await get('/me/code')).status, 405);
  const code = await codeFor(me);
  const cross = await postCode(code, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal((await postCode('not a code')).status, 400);
  assert.equal((await postCode(code)).status, 200, 'the refused attempts did not spend it');
});

test('a paused or blocked person cannot sign in with a code minted before', async () => {
  const other = await makeUser(db.pool, '+972531940099', { firstName: 'Dana' });
  const code = await codeFor(other);
  await db.pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [other.id]);
  assert.equal((await postCode(code)).status, 403);
});

// ---- the page ---------------------------------------------------------------
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

test('the page carries the code door and the install card in both languages', () => {
  const keys = ['code.have', 'code.h', 'code.p', 'code.get', 'code.waText', 'code.ph', 'code.go', 'code.bad',
    'code.slow', 'code.net', 'inst.h', 'inst.p', 'inst.pIos', 'inst.btn', 'inst.later', 'inst.ok',
    'inst.ios1', 'inst.ios2', 'inst.ios3'];
  for (const k of keys) {
    assert.equal((PAGE.match(new RegExp(`"${k.replace('.', '\\.')}":`, 'g')) || []).length, 2, `${k} in both tables`);
  }
  // What the button types into WhatsApp must be what brokerd answers.
  const linkRequest = require('../src/domain/link-request');
  for (const [lang, text] of [['he', 'קוד כניסה לאפליקציה'], ['en', 'App sign-in code']]) {
    assert.ok(PAGE.includes(`"code.waText":"${text}"`), text);
    assert.deepEqual(linkRequest.matchLinkRequest(text), { lang, kind: 'code' });
  }
});

test('the invitation waits for the browser, and never shows inside the installed app', () => {
  assert.match(PAGE, /addEventListener\("beforeinstallprompt"/);
  assert.match(PAGE, /display-mode: standalone/);
  assert.match(PAGE, /olma\.installDismissed/);
  // Every storage touch in the new code is guarded: private mode throws.
  const block = PAGE.slice(PAGE.indexOf('THE HOME-SCREEN APP'), PAGE.indexOf('One or the other, never both'));
  const touches = block.match(/localStorage\.\w+Item/g) || [];
  const guarded = block.match(/try\{ (?:return )?localStorage\.\w+Item/g) || [];
  assert.equal(touches.length, guarded.length);
});

test('no class the new blocks own is defined twice', () => {
  // One CSS namespace (see tests/meeting-quorum.test.js): a second bare
  // definition wins by source order and nothing else notices.
  for (const cls of ['inst', 'inst-mark', 'inst-steps', 'inst-acts', 'wcode', 'wcode-in', 'wcode-get', 'wcode-go']) {
    const n = (PAGE.match(new RegExp(`^\\.${cls}\\{`, 'gm')) || []).length;
    assert.equal(n, 1, `.${cls} is defined ${n} times`);
  }
});

test('the brand layer only moves tokens, and is off unless asked for', () => {
  const start = PAGE.indexOf(':root[data-brand="allma"]{');
  assert.ok(start > 0);
  const end = PAGE.indexOf('[dir="ltr"]{--dirf', start);
  const layer = PAGE.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const line of layer.split('\n').map((l) => l.trim()).filter(Boolean)) {
    assert.ok(/^(--[a-z0-9-]+:.+;|[}{]|:root\[data-brand="allma"\](\[data-theme="dark"\]|:not\(\[data-theme="light"\]\))?\{|@media \(prefers-color-scheme: dark\)\{)$/.test(line),
      `the brand layer does more than set a token: ${line}`);
  }
  assert.match(PAGE, /localStorage\.getItem\("olma\.brand"\) === "1"/);
  assert.ok(!/<html[^>]*data-brand/.test(PAGE), 'the page never ships with the brand on');
});
