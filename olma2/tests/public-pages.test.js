'use strict';
// The two unauthenticated pages allma.world serves, and — more importantly —
// the line between them and the admin dashboard. `/` means two different
// things on two hostnames, and getting that wrong exposes the admin root.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const auth = require('../src/domain/dashboard-auth');
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
function get(path, host, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method,
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

// ---- the front door is the dashboard, locked (2026-09-29) -----------------

test('the public `/` is the stranger\'s dashboard, with the words Google reads under it', async () => {
  const res = await get('/', PUBLIC);
  assert.equal(res.status, 200, 'the front door is the page asked for, not a refusal');
  const html = await res.text();
  assert.match(html, /^<html data-served="1" data-new="1">/, 'not the locked dashboard');
  const about = html.slice(html.indexOf('<section class="about" id="about"'));
  assert.ok(about.length > 1000, 'the words under the lock are missing');
  // What a verification reviewer matches our scopes against, and the policy.
  for (const bit of ['calendar.readonly', 'calendar.events', 'contacts.readonly', 'href="/privacy"', 'href="/terms"']) {
    assert.ok(about.includes(bit), `the front door lost ${bit}`);
  }
  assert.ok(about.includes(publicPages.homeSections((n) => 'ab-' + n)), 'the front door drifted from the home page text');
  // Indexable: it is the product's front door and holds nothing of anybody's.
  assert.equal(res.headers.get('x-robots-tag'), undefined);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(res.headers.get('vary'), 'Cookie');
});

test('a visitor with a live session is sent past the lock to their own page', async () => {
  const me = await makeUser(db.pool, '+972531930077', { firstName: 'Front' });
  const link = await withTx(db.pool, (c) => auth.createLink(c, me.id));
  assert.equal(link.ok, true);
  const opened = await get('/d/' + link.data.token, PUBLIC, {}, 'POST');
  assert.equal(opened.status, 303);
  const cookie = String(opened.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='), 'no session was opened');
  const res = await get('/', PUBLIC, { cookie });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/me');
  // …and a cookie that resolves to nobody is a stranger, not an error.
  const stale = await get('/', PUBLIC, { cookie: cookie.replace(/=.*/, '=nobody') });
  assert.equal(stale.status, 200);
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

test('the accessibility statement is served unauthenticated, on either host', async () => {
  for (const host of [PUBLIC, ADMIN]) {
    const res = await get('/accessibility', host);
    assert.equal(res.status, 200, `accessibility should not need a password on ${host}`);
    const html = await res.text();
    assert.ok(html.includes('<h1>Accessibility Statement</h1>'));
    assert.ok(html.includes('<h2>הצהרת נגישות</h2>'));
  }
});

test('every public page links the other three in its footer', () => {
  const pages = {
    '/': publicPages.homePage(),
    '/privacy': publicPages.privacyPage(),
    '/terms': publicPages.termsPage(),
    '/accessibility': publicPages.accessibilityPage(),
  };
  for (const [self, html] of Object.entries(pages)) {
    const foot = html.slice(html.lastIndexOf('<div class="foot">'));
    for (const target of ['/privacy', '/terms', '/accessibility']) {
      if (target === self) continue;
      assert.ok(foot.includes(`href="${target}"`), `the ${self} footer does not link ${target}`);
    }
  }
});

test('the accessibility statement carries the owner\'s Hebrew and its placeholders filled', () => {
  const html = publicPages.accessibilityPage();
  for (const line of [
    'עולמה פועלת בעיקר בתוך וואטסאפ, כך שכלי הנגישות של הטלפון שלכם (קורא מסך, הגדלת טקסט, הכתבה) עובדים איתה כרגיל.',
    'תקן ישראלי 5568 ו־WCAG 2.0 ברמה AA',
    'כתבו לעולמה בוואטסאפ "בעיית נגישות"',
    'ונחזור אליכם תוך 7 ימים.',
    'עודכן: 2026-09-28',
  ]) assert.ok(html.includes(line), `missing: ${line}`);
  assert.ok(html.includes(`mailto:${publicPages.CONTACT_EMAIL}`), 'the statement must name where to write');
  assert.ok(!/\{[A-Z_]+\}/.test(html), 'a placeholder was left unfilled');
  // The owner's decision of 2026-09-29: the shared address, and no person named.
  assert.doesNotMatch(html, /מיירון|Mayron|mayrondadush|רכז נגישות|coordinator/i);
});

test('the pinch-zoom sentence follows the flag, and the flag follows the dashboard', () => {
  // The sentence confesses that /me cannot be pinch-zoomed. It is true only
  // while the dashboard's viewport meta forbids zoom, so the two are checked
  // against each other: restoring zoom without flipping PINCH_ZOOM_DISABLED
  // (or the reverse) fails here instead of publishing a false statement.
  const fs = require('node:fs');
  const path = require('node:path');
  const dash = fs.readFileSync(path.join(__dirname, '../docs/design/user-dashboard.html'), 'utf8');
  const meta = (dash.match(/<meta name="viewport"[^>]*>/) || [''])[0];
  const zoomOff = /user-scalable=no|maximum-scale=1(?:\.0)?\b/.test(meta);
  assert.equal(publicPages.PINCH_ZOOM_DISABLED, zoomOff,
    'PINCH_ZOOM_DISABLED in public-pages.js no longer matches the dashboard viewport meta');
  const html = publicPages.accessibilityPage();
  assert.equal(html.includes('אי אפשר להגדיל את הדף האישי בצביטה'), zoomOff);
  assert.equal(/cannot currently be enlarged by pinching/.test(html), zoomOff);
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

// Cypress + Mustard (the owner, 2026-09-28): the front door wears the same
// brand as the product, and the retired violet globe is nowhere on it.
test('the public pages wear the brand: cypress band, mustard action, always light, the round mark', () => {
  const home = publicPages.homePage();
  assert.ok(home.includes('<header class="band">'), 'the home page lost its cypress band');
  assert.ok(/--band:#004643/.test(home) && /--action:#F9C23C/.test(home));
  assert.ok(!/prefers-color-scheme/.test(home) && /color-scheme:light/.test(home),
    'the front door is always light, whatever the phone is set to');
  assert.ok(home.includes('<meta name="theme-color" content="#004643">'));
  assert.ok(home.includes("@font-face{font-family:'IBM Plex Sans Hebrew'"), 'the brand face, carried inline (fonts.js)');
  for (const html of [home, publicPages.privacyPage(), publicPages.termsPage()]) {
    assert.ok(!/#5B2FD6|#7C4DFF|Rubik/i.test(html), 'the old violet brand is still on a public page');
    const ids = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'two marks on one page share a clip-path id');
  }
});

// ---- the 2026-09-28 rewrite: what s.11 asks for, and what the box does -----

test('the policy gives the service address, says giving data is voluntary, and lists the rights, in both languages', () => {
  const html = publicPages.privacyPage();
  // No name, by the owner's choice (2026-09-28): the contact is the service's.
  assert.equal(publicPages.CONTACT_EMAIL, 'info@allma.world');
  assert.ok(html.includes('mailto:info@allma.world'));
  assert.ok(!html.includes('gmail.com'), 'no personal address on the page');
  assert.ok(/no legal obligation/i.test(html) && html.includes('אין חובה חוקית'));
  assert.ok(/cannot work/i.test(html) && html.includes('לא יכולה לעבוד'), 'what refusing costs');
  assert.ok(/See your data/.test(html) && /Correct it/.test(html), 'access and correction');
  assert.ok(html.includes('לעיין במידע שלכם') && html.includes('לתקן מידע לא נכון'));
});

test('the policy names every processor the box actually uses, and where the backup really is', () => {
  const html = publicPages.privacyPage();
  // StreamLake stays in the live route (owner, 2026-09-28), so it is named,
  // with its unverified location said rather than guessed.
  for (const who of ['OpenRouter', 'Novita', 'StreamLake', 'DeepInfra', 'Together', 'Anthropic',
    'ElevenLabs', 'Deepgram', 'Twilio', 'DigitalOcean', 'Frankfurt']) {
    assert.ok(html.includes(who), `the policy does not name ${who}`);
  }
  assert.ok(/location has not been verified/.test(html) && html.includes('לא אומת'));
  assert.ok(!/retained for 14 days and then deleted/.test(html),
    'the old sentence was false about the off-box copy (30 days, Frankfurt)');
});

test('nothing is promised on a timer: kept until they ask, and only the backups age out', () => {
  const html = publicPages.privacyPage();
  const R = publicPages.RETENTION;
  // The owner's decision (2026-09-28). No sweep deletes conversations or
  // group rosters, so the page must not name a number of days for them.
  assert.deepEqual(Object.keys(R).sort(), ['deletionDays', 'localBackupDays', 'offboxBackupDays']);
  assert.ok(/Nothing is deleted on a timer/.test(html) && html.includes('שום דבר לא נמחק אוטומטית'));
  assert.ok(html.includes(`within ${R.deletionDays} days`) && html.includes(`תוך ${R.deletionDays} יום`));
  assert.ok(/even if you never used the assistant/.test(html) && html.includes('גם אם מעולם לא השתמש'),
    'a group member who never wrote can still ask');
  assert.ok(/WhatsApp groups/.test(html) && html.includes('קבוצות וואטסאפ'), 'groups are named');
});

// ---- no third party learns who is reading ----------------------------------

// Since 2026-09-29 (finding 13 of the 2026-09-28 compliance review): these
// pages linked Google Fonts, so every visitor's browser sent Google its IP
// before a word was drawn — the transfer LG München I, 3 O 17493/20, fined.
// The fonts are inlined now (adapters/http/fonts.js). Asserted on what the
// SERVER sends, for every page allma.world reaches, so a link re-added
// anywhere on the way — the shell, the design file, the serve-time wrapper —
// fails here.
const GOOGLE_FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/;

test('no page on the public host loads a font from Google, and each carries its own', async () => {
  // `/me` with no session is the stranger's screen: the same file a signed-in
  // person gets, through the same servedPageHtml.
  for (const path of ['/', '/privacy', '/terms', '/me']) {
    const res = await get(path, PUBLIC);
    const html = await res.text();
    assert.ok(html.length > 1000, `${path} answered with nothing, so the check below would prove nothing`);
    assert.doesNotMatch(html, GOOGLE_FONT_HOSTS, `${path} still asks Google for a font`);
    for (const family of ['IBM Plex Sans Hebrew', 'IBM Plex Sans']) {
      assert.match(html, new RegExp(`@font-face\\{font-family:'${family}';[^}]*src:url\\(data:font/woff2;base64,`),
        `${path} does not carry ${family} inline`);
    }
    const csp = res.headers.get('content-security-policy') || '';
    assert.doesNotMatch(csp, GOOGLE_FONT_HOSTS, `${path}'s CSP still allows Google`);
  }
});

test('the vendored fonts are real woff2 and their OFL licence travels with them', () => {
  const fs = require('node:fs');
  const pathMod = require('node:path');
  const { FONT_DIR, FACES } = require('../src/adapters/http/fonts');
  for (const [, , file] of FACES) {
    const buf = fs.readFileSync(pathMod.join(FONT_DIR, file));
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'wOF2', `${file} is not a woff2 file`);
  }
  assert.match(fs.readFileSync(pathMod.join(FONT_DIR, 'OFL-IBM-Plex.txt'), 'utf8'), /SIL Open Font License/i);
});
