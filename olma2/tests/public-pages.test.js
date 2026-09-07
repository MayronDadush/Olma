'use strict';
// The two unauthenticated pages allma.world serves, and — more importantly —
// the line between them and the admin dashboard. `/` means two different
// things on two hostnames, and getting that wrong exposes the admin root.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createDashboard } = require('../src/adapters/http/dashboard');
const publicPages = require('../src/adapters/http/public-pages');

let db, server;
const AUTH = 'Basic ' + Buffer.from('admin:test-password-123').toString('base64');
const PUBLIC = 'allma.world';
const ADMIN = 'olmachat.duckdns.org';

before(async () => {
  db = await freshDb();
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => { server.close(); await db.teardown(); });

// node:http, not fetch: `host` is a forbidden header name in the fetch spec,
// so undici silently drops it and every request would arrive with the
// 127.0.0.1 host — which is exactly the variable under test here.
const http = require('node:http');
function get(path, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method: 'GET',
      headers: { ...(host === '' ? {} : { Host: host }), ...headers },
      setHost: false,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (k) => res.headers[k.toLowerCase()] },
        text: async () => body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- the public pages exist and need no password ---------------------------

test('the home page is served unauthenticated on the public host', async () => {
  const res = await get('/', PUBLIC);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('עולמה'), 'the assistant is not named on its own front door');
  assert.ok(/text\/html/.test(res.headers.get('content-type')));
});

test('the privacy policy is served unauthenticated, on either host', async () => {
  for (const host of [PUBLIC, ADMIN]) {
    const res = await get('/privacy', host);
    assert.equal(res.status, 200, `privacy should not need a password on ${host}`);
    const html = await res.text();
    assert.ok(html.includes('מדיניות פרטיות'));
  }
});

test('the terms of service page is served unauthenticated, on either host', async () => {
  for (const host of [PUBLIC, ADMIN]) {
    const res = await get('/terms', host);
    assert.equal(res.status, 200, `terms should not need a password on ${host}`);
    const html = await res.text();
    assert.ok(html.includes('תנאי שימוש'));
  }
});

// ---- the admin dashboard must NOT have moved -------------------------------

test('`/` on the ADMIN host still demands the admin password', async () => {
  const res = await get('/', ADMIN);
  assert.equal(res.status, 401, 'the public home page must never shadow the admin dashboard root');
  assert.ok(/Basic realm/.test(res.headers.get('www-authenticate') || ''));
});

test('`/` on the admin host with the password is the dashboard, not the home page', async () => {
  const res = await get('/', ADMIN, { authorization: AUTH });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes('פתיחת שיחה בוואטסאפ'), 'the admin got the public home page instead of their dashboard');
});

test('an unknown or lookalike host falls through to Basic Auth, never to the public page', async () => {
  // The suffix case is the one worth naming: a Set membership test matches
  // the WHOLE host, so "allma.world.evil.example" is not a near-miss that
  // squeaks through the way a startsWith/includes check would let it.
  for (const host of ['evil.example', 'allma.world.evil.example', 'notallma.world']) {
    const res = await get('/', host);
    assert.equal(res.status, 401, `host "${host}" must not be treated as public`);
  }
});

test('a request with no Host header at all never reaches the route', async () => {
  // Node's HTTP server rejects a HTTP/1.1 request without Host before any
  // handler runs. Asserted rather than assumed, because "" is the value
  // hostOf() would reduce an absent header to.
  const res = await get('/', '');
  assert.equal(res.status, 400);
});

test('the host match ignores case and a port suffix', async () => {
  for (const host of ['ALLMA.WORLD', 'allma.world:443', 'www.allma.world']) {
    const res = await get('/', host);
    assert.equal(res.status, 200, `host "${host}" should be recognised as public`);
  }
});

// ---- what a verification reviewer actually checks --------------------------

test('the home page names every Google scope the code really requests, and links the policy', () => {
  const html = publicPages.homePage();
  for (const scope of ['calendar.readonly', 'calendar.events', 'contacts.readonly']) {
    assert.ok(html.includes(scope), `home page does not disclose ${scope}`);
  }
  assert.ok(html.includes('href="/privacy"'), 'Google requires the home page to link the privacy policy');
});

test('the privacy policy carries the Limited Use disclosure and the policy link', () => {
  const html = publicPages.privacyPage();
  assert.ok(/Limited Use/.test(html), 'the Limited Use disclosure is what verification turns on');
  assert.ok(html.includes('developers.google.com/terms/api-services-user-data-policy'),
    'the Limited Use paragraph must cite the policy it claims to follow');
  assert.ok(/not used to train generalized models/i.test(html));
});

test('the policy states the same scopes as the home page, in both languages', () => {
  const html = publicPages.privacyPage();
  for (const scope of ['calendar.readonly', 'calendar.events', 'contacts.readonly', 'userinfo.email']) {
    assert.ok(html.includes(scope), `privacy policy does not disclose ${scope}`);
  }
  assert.ok(/Privacy Policy/i.test(html), 'a Google reviewer reads English first');
  assert.ok(html.includes('מדיניות פרטיות (עברית)'), 'Hebrew users still get the full policy');
  assert.ok(/myaccount\.google\.com\/permissions/.test(html), 'users must be told how to revoke directly');
});

test('no public page declares a RESTRICTED scope, in either language', () => {
  // These pages ARE the declaration a verification reviewer reads, and the
  // free sensitive track is decided by what an app declares rather than by
  // what it calls. They went on describing Gmail for a day after the tools
  // that used it were deleted (2026-09-07) — a page saying `gmail.readonly`
  // is an app asking for `gmail.readonly` as far as that reader is concerned.
  //
  // The list is every RESTRICTED Google scope a personal assistant could
  // plausibly grow into, not just the one that was here: the next person to
  // add mail, Drive or chat has to come through this test.
  const RESTRICTED = [
    'gmail.readonly', 'gmail.modify', 'gmail.send', 'gmail.compose',
    'https://mail.google.com/', 'drive.readonly', 'auth/drive',
  ];
  for (const [name, html] of Object.entries({
    home: publicPages.homePage(),
    privacy: publicPages.privacyPage(),
    terms: publicPages.termsPage(),
  })) {
    for (const scope of RESTRICTED) {
      assert.ok(!html.includes(scope),
        `the ${name} page declares the restricted scope ${scope} — that is the paid verification track`);
    }
    assert.ok(!/Gmail/.test(html), `the ${name} page still offers Gmail as a feature`);
  }
});

test('what the pages DO promise still matches what the code can do', () => {
  const home = publicPages.homePage();
  const privacy = publicPages.privacyPage();
  // Contacts import is the one silent read left, and both pages carry the
  // promise that it tells nobody.
  assert.ok(/notifies nobody/i.test(home), 'the home page must keep the silent-import promise');
  assert.ok(/notifies nobody and discloses to no third party/i.test(privacy));
  // Calendar writes only where edit access was granted AND asked for.
  assert.ok(/only if you granted edit access and explicitly asked for it/i.test(privacy));
});

test('neither page carries a form, a script, or anything that takes input', () => {
  for (const html of [publicPages.homePage(), publicPages.privacyPage(), publicPages.termsPage()]) {
    assert.ok(!/<form/i.test(html), 'a public unauthenticated page must not accept input');
    assert.ok(!/<script/i.test(html), 'these pages have no moving parts on purpose');
  }
});

test('the terms page reads English first, links the privacy policy, and carries the Hebrew text in full', () => {
  const html = publicPages.termsPage();
  assert.ok(/Terms of Service/i.test(html), 'a Google reviewer reads English first');
  assert.ok(html.includes('href="/privacy"'), 'terms must link the privacy policy');
  assert.ok(html.includes('תנאי שימוש (עברית)'), 'Hebrew users still get the full terms');
});
