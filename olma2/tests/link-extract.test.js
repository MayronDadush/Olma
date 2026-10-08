'use strict';
// Reading a saved link (domain/link-extract.js). The network is always
// injected: every page here is a fixture captured from the real site, and
// `lookup` answers a public address unless a test says otherwise, so nothing
// leaves the machine (rules/testing.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const x = require('../src/domain/link-extract');

const F = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'links', n));
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeFetch(routes, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET' });
    for (const [re, res] of routes) {
      if (re.test(url)) return typeof res === 'function' ? res(url, init) : res();
    }
    return new Response('no', { status: 404 });
  };
}
const ok = (body, type) => () => new Response(body, { status: 200, headers: { 'content-type': type } });
const redirect = (to, status = 302) => () => new Response(null, { status, headers: { location: to } });

// ---- finding and naming -------------------------------------------------------
test('findUrls takes the URLs out of a sentence and leaves the sentence\'s punctuation', () => {
  assert.deepEqual(x.findUrls('תראי https://example.com/a. וגם (https://example.com/b)!'),
    ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(x.findUrls('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(x.findUrls('https://a.com https://a.com'), ['https://a.com'], 'the same one twice is one');
  assert.deepEqual(x.findUrls('ftp://a.com javascript:alert(1) https://user:pw@a.com'), []);
  assert.deepEqual(x.findUrls(null), []);
});

test('two saves of the same thing share one canonical form', () => {
  const same = (a, b) => assert.equal(x.normalize(a).canonical, x.normalize(b).canonical, `${a} vs ${b}`);
  same('https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=x');
  same('https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  same('https://www.instagram.com/reel/Cabc123/?igsh=xyz', 'https://instagram.com/somebody/p/Cabc123');
  same('https://www.tiktok.com/@a.b/video/123?is_from_webapp=1', 'https://tiktok.com/@a.b/video/123');
  same('https://www.yad2.co.il/realestate/item/tel-aviv-area/abc123?opened-from=feed', 'https://yad2.co.il/realestate/item/abc123');
  same('https://example.com/page/?utm_campaign=z#top', 'https://example.com/page');
  assert.notEqual(x.normalize('https://example.com/a?id=1').canonical, x.normalize('https://example.com/a?id=2').canonical,
    'a query that is not tracking is part of what was saved');
  assert.equal(x.normalize('not a url'), null);
});

test('the platform is read off the host', () => {
  assert.equal(x.platformOf('https://maps.app.goo.gl/AbC'), 'maps');
  assert.equal(x.platformOf('https://www.google.com/maps/place/Cafe'), 'maps');
  assert.equal(x.platformOf('https://www.google.com/search?q=x'), 'web');
  assert.equal(x.platformOf('https://vm.tiktok.com/ZS123'), 'tiktok');
  assert.equal(x.platformOf('https://notinstagram.com/p/x'), 'web');
});

// ---- the guard ------------------------------------------------------------------
test('no private, loopback, link-local or our own address is ever fetched', async () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(x.isPrivateIp(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.equal(x.isPrivateIp(ip), false, ip);
  const seen = [];
  const fetchImpl = fakeFetch([[/./, ok('<title>x</title>', 'text/html')]], seen);
  const internal = async () => [{ address: '10.1.2.3', family: 4 }];
  assert.equal(await x.extract('https://intranet.example.com/', { fetchImpl, lookup: internal }), null);
  assert.equal(await x.extract('http://169.254.169.254/latest/meta-data/', { fetchImpl, lookup: PUBLIC }), null);
  assert.equal(await x.extract('https://allma.world/me', { fetchImpl, lookup: PUBLIC }), null);
  assert.equal(await x.extract('http://localhost:8788/', { fetchImpl, lookup: PUBLIC }), null);
  assert.equal(seen.length, 0, 'refused before any request was made');
});

test('a redirect into a private address is refused at the hop, not after it', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([
    [/^https:\/\/public\.example/, redirect('http://192.168.0.1/admin')],
    [/192\.168/, ok('<title>router</title>', 'text/html')],
  ], seen);
  assert.equal(await x.extract('https://public.example.com/x', { fetchImpl, lookup: PUBLIC }), null);
  assert.deepEqual(seen.map((s) => s.url), ['https://public.example.com/x']);
});

test('a lookup that fails or answers nothing is a refusal', async () => {
  const u = new URL('https://example.com/');
  assert.equal(await x.hostIsSafe(u, async () => { throw new Error('ENOTFOUND'); }), false);
  assert.equal(await x.hostIsSafe(u, async () => []), false);
  assert.equal(await x.hostIsSafe(u, async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }]), false,
    'one private answer among several is enough to refuse');
});

// Review of PR #802, reproduced: `new URL` writes [::ffff:169.254.169.254] as
// [::ffff:a9fe:a9fe], which the old string patterns let through.
test('every way of writing a private address inside IPv6 is refused', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1', '::ffff:c0a8:101', '[::ffff:7f00:1]',
    '::7f00:1', '::', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '2002:7f00:1::', '2002:808:808::1',
    'fec0::1', 'ff02::1', '2001:db8::1', '198.18.0.1', '203.0.113.9', '255.255.255.255', 'not-an-ip']) {
    assert.equal(x.isPrivateIp(ip), true, ip);
  }
  assert.equal(x.isPrivateIp('::ffff:808:808'), false, 'a public IPv4 mapped into IPv6 is still public');
  const seen = [];
  const fetchImpl = fakeFetch([[/./, ok('<title>x</title>', 'text/html')]], seen);
  for (const u of ['http://[::ffff:169.254.169.254]/latest/', 'http://[::ffff:7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/',
    'http://0x7f.1/', 'http://2130706433/']) {
    assert.equal(await x.extract(u, { fetchImpl, lookup: PUBLIC }), null, u);
  }
  assert.equal(seen.length, 0);
});

test('only the two web ports, and our own hosts in every spelling', async () => {
  const safe = (u) => x.hostIsSafe(new URL(u), PUBLIC);
  assert.equal(await safe('https://example.com/'), true);
  assert.equal(await safe('http://example.com:80/'), true);
  assert.equal(await safe('https://example.com:443/'), true);
  for (const u of ['http://example.com:22/', 'https://example.com:8443/', 'http://example.com:6379/',
    'https://allma.world./me', 'https://ALLMA.WORLD/me', 'https://olmachat.duckdns.org./', 'http://157.230.210.233/',
    'https://x.allma.world/']) {
    assert.equal(await safe(u), false, u);
  }
  assert.equal(x.isOwnHost('allma.world.'), true);
  assert.equal(x.isOwnHost('157.230.210.233'), true);
  assert.equal(x.isOwnHost('example.com'), false);
});

// The fetch resolves the host itself, so the check above could be answered
// with a public address and the socket opened to a private one (DNS
// rebinding). The default fetch connects through the same check.
test('the default fetch refuses at the SOCKET an address it was not shown', async () => {
  const http = require('node:http');
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.end('secret'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const rebound = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(x.guardedFetch(`http://rebind.example:${port}/`, {}, rebound), (e) => e.code === 'EREFUSED_PRIVATE');
    assert.equal(hits, 0, 'nothing reached the private address');
    const answers = [];
    x.guardedLookup(PUBLIC)('example.com', { all: true }, (e, a) => answers.push([e, a]));
    x.guardedLookup(PUBLIC)('example.com', {}, (e, a, f) => answers.push([e, a, f]));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(answers, [[null, [{ address: '93.184.216.34', family: 4 }]], [null, '93.184.216.34', 4]]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a short link spends the same three redirects the read gets, and a deadline already past reads nothing', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([
    [/vm\.tiktok\.com/, redirect('https://vt.tiktok.com/b')],
    [/vt\.tiktok\.com/, redirect('https://pin.it/c')],
    [/pin\.it/, redirect('https://www.example.com/d')],
    [/example\.com\/d/, redirect('https://www.example.com/e')],
    [/example\.com\/e/, ok('<title>far</title>', 'text/html')],
  ], seen);
  assert.equal(await x.extract('https://vm.tiktok.com/a', { fetchImpl, lookup: PUBLIC }), null, 'four hops is one too many');
  const none = [];
  assert.equal(await x.extract('https://example.com/', {
    fetchImpl: fakeFetch([[/./, ok('<title>x</title>', 'text/html')]], none), lookup: PUBLIC, deadline: Date.now() - 1,
  }), null);
  assert.equal(none.length, 0);
});

test('a page over the size cap, a non-200 or a thrown fetch reads as null and never throws', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 'a');
  const reasons = [];
  assert.equal(await x.safeGet('https://example.com/', {
    fetchImpl: fakeFetch([[/./, ok(big, 'text/html')]]), lookup: PUBLIC, why: (r) => reasons.push(r),
  }), null);
  assert.equal(await x.extract('https://example.com/', { fetchImpl: fakeFetch([[/./, () => new Response('x', { status: 500 })]]), lookup: PUBLIC }), null);
  assert.equal(await x.extract('https://example.com/', { fetchImpl: async () => { throw new Error('boom'); }, lookup: PUBLIC }), null);
  assert.deepEqual(reasons, ['too_big']);
});

// ---- per platform ------------------------------------------------------------------
test('YouTube is read through oEmbed: title, channel, picture', async () => {
  const seen = [];
  const r = await x.extract('https://youtu.be/dQw4w9WgXcQ?si=abc', {
    fetchImpl: fakeFetch([[/youtube\.com\/oembed/, ok(F('yt.json'), 'application/json')]], seen), lookup: PUBLIC,
  });
  assert.equal(r.platform, 'youtube');
  assert.equal(r.kind, 'video');
  assert.equal(r.canonical, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.match(r.title, /^Rick Astley - Never Gonna Give You Up/);
  assert.equal(r.author, 'Rick Astley');
  assert.equal(r.image, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(r.level, 'meta');
  assert.match(seen[0].url, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ/, 'asks about the canonical form');
});

test('TikTok: the caption is kept whole, the title loses the hashtags, the author is the HANDLE', async () => {
  const r = await x.extract('https://www.tiktok.com/@butterworthdasyrup/video/6948591256497458438', {
    fetchImpl: fakeFetch([[/tiktok\.com\/oembed/, ok(F('tt.json'), 'application/json')]]), lookup: PUBLIC,
  });
  assert.equal(r.kind, 'video');
  assert.equal(r.author, '@butterworthdasyrup', 'never "@Tyler Butterworth" — that is a display name');
  assert.match(r.caption, /#recipe/);
  assert.doesNotMatch(r.title, /#/);
  assert.ok(r.title.length <= 120);
  assert.equal(r.level, 'full');
});

test('Yad2: the address is the title, and the flat is one line of numbers', async () => {
  const r = await x.extract('https://www.yad2.co.il/realestate/item/tel-aviv-area/abc123', {
    fetchImpl: fakeFetch([[/yad2/, ok(F('yad2.html'), 'text/html')]]), lookup: PUBLIC,
  });
  assert.equal(r.kind, 'listing');
  assert.equal(r.title, "דירה, הדוגמה 1, רמת אביב ג', תל אביב יפו", 'the slogan after the bar is gone');
  assert.equal(r.line, '₪10,000 · 5 חד׳ · 105 מ״ר · קומה 2');
  assert.equal(r.level, 'full');
  const en = await x.extract('https://www.yad2.co.il/realestate/item/abc123', {
    fetchImpl: fakeFetch([[/yad2/, ok(F('yad2.html'), 'text/html')]]), lookup: PUBLIC, lang: 'en',
  });
  assert.doesNotMatch(en.line, /[֐-׿]/, 'an English reader gets the line in English');
});

test('a recipe site: JSON-LD gives the name, the ingredients and a line', async () => {
  const r = await x.extract('https://www.10dakot.co.il/recipe/x/', {
    fetchImpl: fakeFetch([[/10dakot/, ok(F('dakot.html'), 'text/html; charset=utf-8')]]), lookup: PUBLIC,
  });
  assert.equal(r.kind, 'recipe');
  assert.equal(r.title, 'עוגת שוקולד לילדים');
  assert.ok(r.recipe.ingredients.length >= 5);
  assert.match(r.line, /מצרכים/);
  assert.equal(r.level, 'full');
});

test('a short link is followed to where it goes, and named by THAT', async () => {
  const r = await x.extract('https://vm.tiktok.com/ZSabc/', {
    fetchImpl: fakeFetch([
      [/vm\.tiktok\.com/, redirect('https://www.tiktok.com/@butterworthdasyrup/video/6948591256497458438?_r=1')],
      [/tiktok\.com\/oembed/, ok(F('tt.json'), 'application/json')],
    ]),
    lookup: PUBLIC,
  });
  assert.equal(r.canonical, 'https://www.tiktok.com/@butterworthdasyrup/video/6948591256497458438');
});

test('a Maps link that cannot be fetched still names the place its URL carries', async () => {
  const r = await x.extract('https://www.google.com/maps/place/Cafe+Xoho/@32.08,34.78,17z', {
    fetchImpl: fakeFetch([]), lookup: PUBLIC,
  });
  assert.deepEqual({ kind: r.kind, title: r.title, level: r.level }, { kind: 'place', title: 'Cafe Xoho', level: 'meta' });
});

test('a picture is kept only when it IS a picture and is small enough', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const got = await x.fetchImage('https://img.example.com/a.png', { fetchImpl: fakeFetch([[/./, ok(png, 'image/png')]]), lookup: PUBLIC });
  assert.equal(got.mime, 'image/png');
  assert.deepEqual(got.bytes, png);
  assert.equal(await x.fetchImage('https://img.example.com/a', { fetchImpl: fakeFetch([[/./, ok('<html>', 'text/html')]]), lookup: PUBLIC }), null);
  assert.equal(await x.fetchImage('https://img.example.com/a', {
    fetchImpl: fakeFetch([[/./, ok(Buffer.alloc(x.MAX_IMAGE_BYTES + 1), 'image/jpeg')]]), lookup: PUBLIC,
  }), null);
  assert.equal(await x.fetchImage(null), null);
});
