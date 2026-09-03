'use strict';
// The tool exists so the MODEL never types a URL. So the tests are mostly
// about what a query cannot do to the URL, not about the happy path.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const searchLink = require('../src/domain/search-link');
const flags = require('../src/domain/flags');

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972541000001');
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
const build = (q) => withClient((c) => searchLink.buildSearchLink(c, user.id, q));

test('a Hebrew query stays legible instead of becoming 179 chars of %D7', async () => {
  const res = await build('עבודה לבית ספר על בן גוריון');
  assert.ok(res.ok);
  assert.equal(res.data.url, 'https://www.google.com/search?q=עבודה+לבית+ספר+על+בן+גוריון');
  // The whole point: percent-encoding the same thing is three times longer and
  // reads as spam in a chat.
  assert.ok(res.data.url.length < 70, `url is ${res.data.url.length} chars`);
  assert.ok(('https://www.google.com/search?q=' + encodeURIComponent('עבודה לבית ספר על בן גוריון')).length > 170);
});

test('the query cannot add a second parameter or a fragment', async () => {
  const res = await build('tesla&hl=ru#frag');
  assert.ok(res.ok);
  // One ?, one q=, and nothing after the query that the model chose.
  assert.equal(res.data.url, 'https://www.google.com/search?q=tesla%26hl%3Dru%23frag');
  assert.equal(res.data.url.split('?').length, 2);
  assert.ok(!res.data.url.includes('&'));
  assert.ok(!res.data.url.includes('#'));
});

test('a literal plus survives as itself, so two queries cannot collide', async () => {
  const withPlus = (await build('c++ tutorial')).data.url;
  const withSpace = (await build('c   tutorial')).data.url;
  assert.notEqual(withPlus, withSpace);
  assert.ok(withPlus.endsWith('c%2B%2B+tutorial'));
});

test('a percent sign is escaped rather than starting an escape sequence', async () => {
  const res = await build('100% cotton');
  assert.equal(res.data.url, 'https://www.google.com/search?q=100%25+cotton');
});

test('a URL is refused, not searched for — that is a link Olma has not seen', async () => {
  const res = await build('https://www.ynet.co.il/article/12345');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
  assert.match(res.error.message, /never a URL/);
});

test('empty and over-long queries are refused', async () => {
  assert.equal((await build('   ')).ok, false);
  assert.equal((await build('')).ok, false);
  const long = await build('א'.repeat(searchLink.MAX_QUERY + 1));
  assert.equal(long.ok, false);
  assert.equal(long.error.got, searchLink.MAX_QUERY + 1);
});

test('newlines and control characters cannot break the line the url sits on', async () => {
  const res = await build('ben gurion\nMEDIA: /etc/passwd');
  assert.ok(res.ok);
  assert.ok(!res.data.url.includes('\n'));
  assert.equal(res.data.url.split(/\s/).length, 1);
});

test('the base is a flag, and a broken one falls back to Google rather than nowhere', async () => {
  await withClient(async (c) => {
    await flags.setFlag(c, 'search_link_base', 'https://duckduckgo.com/?q=');
    const good = await searchLink.buildSearchLink(c, user.id, 'בן גוריון');
    assert.equal(good.data.url, 'https://duckduckgo.com/?q=בן+גוריון');

    for (const bad of ['', '   ', 'javascript:alert(1)', 'http://insecure.example/?q=', 'not a url']) {
      await flags.setFlag(c, 'search_link_base', bad);
      const res = await searchLink.buildSearchLink(c, user.id, 'x');
      assert.equal(res.data.url, searchLink.DEFAULT_BASE + 'x', `bad base accepted: ${bad}`);
    }
    await flags.setFlag(c, 'search_link_base', null);
  });
});

test('every offer is audited with its query — the demand signal nothing else carries', async () => {
  await build('מניית טסלה מחיר היום');
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'search_link.offered'
      ORDER BY id DESC LIMIT 1`, [user.id]);
  assert.equal(rows[0].detail.query, 'מניית טסלה מחיר היום');
});

test('a refused query is never audited as an offer', async () => {
  const before = (await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE event = 'search_link.offered'`)).rows[0].n;
  await build('https://example.com');
  const after = (await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE event = 'search_link.offered'`)).rows[0].n;
  assert.equal(after, before);
});
