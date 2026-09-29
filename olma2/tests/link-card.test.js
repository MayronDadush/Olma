'use strict';
// The card a shared allma.world link shows (src/adapters/http/link-card.js):
// every public page carries one, its image is a route the app actually serves
// in public, and the sign-in page's card says nothing about whose link it is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const auth = require('../src/domain/dashboard-auth');
const { createDashboard } = require('../src/adapters/http/dashboard');
const card = require('../src/adapters/http/link-card');
const pwa = require('../src/adapters/http/pwa');

let db, server, me;
const PUBLIC = 'allma.world';

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531930077', { firstName: 'Zohara' });
  server = createDashboard({ pool: db.pool, adminUser: 'admin', adminPass: 'test-password-123' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(async () => { server.close(); await db.teardown(); });

// node:http, because fetch drops a Host header and the host is what routes.
function get(path, host = PUBLIC) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path,
      headers: { Host: host }, setHost: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const og = (html, name) => {
  const m = html.match(new RegExp(`<meta property="${name}" content="([^"]*)">`));
  return m ? m[1] : null;
};

test('the front page carries a card, in Hebrew, pointing at itself', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  const html = res.body.toString('utf8');
  assert.equal(og(html, 'og:title'), 'עולמה');
  assert.equal(og(html, 'og:url'), 'https://allma.world/');
  assert.equal(og(html, 'og:locale'), 'he_IL');
  assert.ok(og(html, 'og:description'), 'a card with no line under the title');
  // Before the <title>, inside the <head>: a tag after </head> is ignored.
  assert.ok(html.indexOf('og:title') < html.indexOf('<title>'), 'the card is not in the head');
});

test("the card's image is a public route the app serves, not a file that 404s", async () => {
  const html = (await get('/')).body.toString('utf8');
  const image = og(html, 'og:image');
  assert.equal(image, card.ORIGIN + card.IMAGE_PATH);
  // Caddy on allma.world passes pwa.js's icon paths one by one; a new path
  // here would need the Caddyfile first. Pinning it to that set is the check.
  assert.ok(Object.keys(pwa.ICONS).includes(card.IMAGE_PATH), 'the image is not one of the icons Caddy already passes');
  const res = await get(card.IMAGE_PATH);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /image\/png/);
  assert.equal(res.body.readUInt32BE(16), 512, 'og:image:width says 512 and the file is not');
});

test('each policy page names itself, in the language it is drawn in', async () => {
  for (const [path, lang, locale] of [['/privacy', 'en', 'en_US'], ['/terms?lang=he', 'he', 'he_IL'], ['/accessibility', 'en', 'en_US']]) {
    const html = (await get(path)).body.toString('utf8');
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    assert.equal(og(html, 'og:title'), title, `${path}: the card and the tab disagree`);
    assert.equal(og(html, 'og:locale'), locale, path);
    assert.equal(og(html, 'og:url'), 'https://allma.world' + path.split('?')[0] + (lang === 'he' ? '?lang=he' : ''), path);
  }
});

test("a sign-in link's card says nothing about whose link it is", async () => {
  const made = await withTx(db.pool, (c) => auth.createLink(c, me.id));
  assert.equal(made.ok, true);
  const token = made.data.token;
  const html = (await get('/d/' + token)).body.toString('utf8');
  const tags = html.match(/<meta (property|name)="(og:|twitter:|description)[^>]*>/g) || [];
  assert.ok(tags.length >= 5, 'the sign-in page has no card');
  for (const t of tags) {
    assert.ok(!t.includes('Zohara'), `a card names the person: ${t}`);
    assert.ok(!t.includes(token), `a card carries the key: ${t}`);
  }
  assert.equal(og(html, 'og:url'), 'https://allma.world/');
});

test('what goes into a card is escaped', () => {
  const html = card.linkCard({ lang: 'en', title: '"><script>x</script>', path: '/x' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
});

test('a page with no <title> is left as it was, not broken', () => {
  assert.equal(card.withLinkCard('<html><body>x</body></html>', {}), '<html><body>x</body></html>');
});
