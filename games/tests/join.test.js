'use strict';
// POST /api/open and /api/join: a night opened, and a seat taken, from a
// private message with no model in between. brokerd is the only caller.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');

async function boot(t) {
  const pool = await freshDb(t);
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html>', announce: async () => ({ ok: true, queued: [] }) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeListeners(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body, headers = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { pool, base, post };
}

const HOST = 3, DANI = 8, DANA = 9;
const open = post => post('/api/open', { userId: HOST, name: 'מירון', price: 50, chips: 1000, nightName: 'ערב משחק' });
const tokenOf = url => url.match(/\/night\/([A-Za-z0-9]{22})#me-/)[1];

test('opening: the host is seated and linked, and the link carries their seat', async t => {
  const { pool, post } = await boot(t);
  const { status, body } = await open(post);
  assert.equal(status, 200);
  assert.equal(body.opened, true);
  assert.deepEqual({ ...body.night, code: undefined }, { name: 'ערב משחק', price: 50, chips: 1000, code: undefined });
  assert.match(body.night.code, /^[2-9A-HJKMNP-Z]{5}$/);
  const { rows: [p] } = await pool.query('SELECT id, name, linked_via FROM players WHERE user_id = $1', [HOST]);
  assert.equal(p.name, 'מירון');
  assert.equal(p.linked_via, 'host');
  assert.equal(body.url, `https://allma.test/night/${tokenOf(body.url)}#me-${p.id}`);
});

test('opening twice hands back the night already open instead of a second one', async t => {
  const { pool, post } = await boot(t);
  const first = (await open(post)).body;
  const again = (await open(post)).body;
  assert.equal(again.already, true);
  assert.equal(again.night.code, first.night.code);
  assert.equal(again.url, first.url);
  assert.equal((await pool.query('SELECT count(*)::int n FROM nights')).rows[0].n, 1);
});

test('a probe opens nothing, and finds the night already open', async t => {
  const { pool, post } = await boot(t);
  assert.deepEqual((await post('/api/open', { userId: HOST, probe: true })).body, { ok: true, none: true });
  assert.equal((await pool.query('SELECT count(*)::int n FROM nights')).rows[0].n, 0);
  const first = (await open(post)).body;
  const probe = (await post('/api/open', { userId: HOST, probe: true })).body;
  assert.equal(probe.already, true);
  assert.equal(probe.night.code, first.night.code);
});

test('opening with a price the page would refuse is refused the same way', async t => {
  const { post } = await boot(t);
  const { body } = await post('/api/open', { userId: HOST, name: 'מירון', price: -5, chips: 1000 });
  assert.equal(body.ok, false);
  assert.equal(body.error, 'bad_number');
});

test('joining by code seats them under their name, linked by invite, with a log line', async t => {
  const { pool, base, post } = await boot(t);
  const { night } = (await open(post)).body;
  const { body } = await post('/api/join', { userId: DANI, code: night.code.toLowerCase(), names: ['דני', 'דני ל׳'] });
  assert.equal(body.joined, true);
  assert.equal(body.name, 'דני');
  assert.equal(body.buyins, 0, 'joining is not a buy-in');
  const { rows: [p] } = await pool.query('SELECT id, linked_via FROM players WHERE user_id = $1', [DANI]);
  assert.equal(p.linked_via, 'invite');
  assert.ok(body.url.endsWith('#me-' + p.id));
  const st = await (await fetch(`${base}/night/${tokenOf(body.url)}/api/state`)).json();
  assert.ok(Object.values(st.log).some(l => l.t === 'דני בשולחן' && l.via === 'olma'));
});

test('a name the host already typed, and nobody claimed, is taken over rather than doubled', async t => {
  const { pool, post } = await boot(t);
  const { night } = (await open(post)).body;
  // The host adds "דני" from the page before Dani ever writes.
  await pool.query("INSERT INTO players (night_id, id, name, ord) SELECT id, 'pdani', 'דני', 5 FROM nights");
  const { body } = await post('/api/join', { userId: DANI, code: night.code, names: ['דני'] });
  assert.equal(body.joined, true);
  assert.ok(body.url.endsWith('#me-pdani'));
  assert.equal((await pool.query("SELECT count(*)::int n FROM players WHERE name = 'דני'")).rows[0].n, 1);
});

test('a name somebody else already holds falls to the next one offered, then to name_taken', async t => {
  const { post } = await boot(t);
  const { night } = (await open(post)).body;
  assert.equal((await post('/api/join', { userId: DANI, code: night.code, names: ['דני'] })).body.name, 'דני');
  const second = (await post('/api/join', { userId: DANA, code: night.code, names: ['דני', 'דני כ׳'] })).body;
  assert.equal(second.name, 'דני כ׳');
  const third = (await post('/api/join', { userId: 10, code: night.code, names: ['דני', 'דני כ׳'] })).body;
  assert.equal(third.ok, false);
  assert.equal(third.error, 'name_taken');
  assert.equal(third.name, 'דני');
  assert.equal(third.night.code, night.code);
});

test('sending the code again says where they stand, and counts their buy-ins', async t => {
  const { pool, base, post } = await boot(t);
  const { night } = (await open(post)).body;
  const joined = (await post('/api/join', { userId: DANI, code: night.code, names: ['דני'] })).body;
  const pid = joined.url.split('#me-')[1];
  const token = tokenOf(joined.url);
  for (const n of [1, 0.5]) {
    await fetch(`${base}/night/${token}/api/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add', col: 'buyins', data: { pid, n } }) });
  }
  const again = (await post('/api/join', { userId: DANI, code: night.code, names: ['שם אחר'] })).body;
  assert.equal(again.already, true);
  assert.equal(again.name, 'דני');
  assert.equal(again.buyins, 1.5);
  assert.equal((await pool.query('SELECT count(*)::int n FROM players WHERE user_id = $1', [DANI])).rows[0].n, 1);
});

test('a code that is unknown or malformed is no_night, and so is one closed more than a day ago', async t => {
  const { pool, post } = await boot(t);
  const { night } = (await open(post)).body;
  assert.equal((await post('/api/join', { userId: DANI, code: 'ZZZZZ', names: ['דני'] })).body.error, 'no_night');
  assert.equal((await post('/api/join', { userId: DANI, code: 'AB1', names: ['דני'] })).body.error, 'no_night');
  await pool.query("UPDATE nights SET closed_at = now() - interval '25 hours'");
  assert.equal((await post('/api/join', { userId: DANI, code: night.code, names: ['דני'] })).body.error, 'no_night');
});

test('a night closed in the last day answers its code with the page to look at, and seats nobody', async t => {
  const { pool, post } = await boot(t);
  const opened = (await open(post)).body;
  const token = tokenOf(opened.url);
  await pool.query("UPDATE nights SET closed_at = now() - interval '23 hours'");
  const stranger = (await post('/api/join', { userId: DANI, code: opened.night.code, names: ['דני'] })).body;
  assert.equal(stranger.error, 'closed');
  assert.equal(stranger.night.code, opened.night.code);
  assert.equal(stranger.url, `https://allma.test/night/${token}#view`);
  assert.equal((await pool.query('SELECT count(*)::int n FROM players WHERE user_id = $1', [DANI])).rows[0].n, 0);
  // somebody who sat in it gets their own seat back, not the look-only page
  const host = (await post('/api/join', { userId: HOST, code: opened.night.code, names: ['מירון'] })).body;
  assert.equal(host.error, 'closed');
  assert.equal(host.url, opened.url);
});

test('a seat the host typed under the first or the LAST name is theirs, under the host\'s name', async t => {
  const { pool, post } = await boot(t);
  const { night } = (await open(post)).body;
  // friends call him by his surname
  await pool.query("INSERT INTO players (night_id, id, name, ord) SELECT id, 'pdadush', 'דדוש', 5 FROM nights");
  const { body } = await post('/api/join', { userId: DANI, code: night.code, names: ['דני', 'דני דדוש'] });
  assert.equal(body.joined, true);
  assert.equal(body.name, 'דדוש');
  assert.ok(body.url.endsWith('#me-pdadush'));
  assert.equal((await pool.query('SELECT count(*)::int n FROM players')).rows[0].n, 2, 'no second seat for him');
  // an answer to "what's your name?" with two words finds the seat under the first
  await pool.query("INSERT INTO players (night_id, id, name, ord) SELECT id, 'pdana', 'דנה', 6 FROM nights");
  const dana = (await post('/api/join', { userId: DANA, code: night.code, names: ['דנה לוי'] })).body;
  assert.ok(dana.url.endsWith('#me-pdana'));
  assert.equal(dana.name, 'דנה');
});

test('no name to offer: the night is named, so the question can say which one', async t => {
  const { pool, post } = await boot(t);
  const { night } = (await open(post)).body;
  const { body } = await post('/api/join', { userId: DANI, code: night.code, names: [] });
  assert.equal(body.error, 'need_name');
  assert.equal(body.night.name, 'ערב משחק');
  assert.equal((await pool.query('SELECT count(*)::int n FROM players')).rows[0].n, 1, 'nobody seated');
});

test('a full table is full', async t => {
  const { pool, post } = await boot(t);
  const { night } = (await open(post)).body;
  await pool.query("INSERT INTO players (night_id, id, name, ord) SELECT n.id, 'p' || g, 'שחקן ' || g, g FROM nights n, generate_series(2, 30) g");
  const { body } = await post('/api/join', { userId: DANI, code: night.code, names: ['דני'] });
  assert.equal(body.error, 'full');
  assert.equal(body.night.code, night.code);
});

test('both routes are the box\'s only: through a proxy they do not exist', async t => {
  const { post } = await boot(t);
  const fwd = { 'X-Forwarded-For': '203.0.113.9' };
  assert.equal((await post('/api/open', { userId: HOST, price: 50, chips: 1000 }, fwd)).status, 404);
  assert.equal((await post('/api/join', { userId: DANI, code: 'ABCDE', names: ['x'] }, fwd)).status, 404);
});

test('a missing user id is refused before anything is read', async t => {
  const { post } = await boot(t);
  assert.equal((await post('/api/open', { price: 50, chips: 1000 })).body.error, 'bad_user');
  assert.equal((await post('/api/join', { userId: 'x', code: 'ABCDE', names: ['x'] })).body.error, 'bad_user');
});

test('the short link opens a chat with Olma holding the code, and reads nothing', async t => {
  const { base } = await boot(t);
  const get = p => fetch(base + p, { redirect: 'manual', headers: { 'X-Forwarded-For': '203.0.113.9' } });
  const res = await get('/g/k7m2q');
  assert.equal(res.status, 302, 'public, through the proxy');
  assert.equal(res.headers.get('location'), `https://wa.me/972559347282?text=${encodeURIComponent('משחק K7M2Q')}`);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  // No night has that code: the link does not say so. Olma does, in the chat.
  for (const bad of ['/g/K7M2', '/g/K7M2Q1', '/g/K1M2Q', '/g/K7M2Q/x']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  const post = await fetch(base + '/g/K7M2Q', { method: 'POST', redirect: 'manual' });
  assert.equal(post.status, 405);
});

// Olma's turn context reads this (olma2 domain/turn.advise): on 2026-10-03 the
// settlement went out by code and her session never saw the night close.
test('their nights, as they stand now: open, settled, closed without one; nobody else\'s', async t => {
  const { pool, post } = await boot(t);
  assert.deepEqual((await post('/api/mine', { userId: HOST })).body, { ok: true, nights: [] });
  assert.equal((await post('/api/mine', { userId: HOST }, { 'X-Forwarded-For': '203.0.113.9' })).status, 404);
  assert.equal((await post('/api/mine', { userId: 'x' })).body.error, 'bad_user');

  const store = require('../src/store');
  const first = (await open(post)).body;
  const tok = tokenOf(first.url);
  const { rows: [me] } = await pool.query('SELECT id FROM players WHERE user_id = $1', [HOST]);
  await store.write(pool, tok, { op: 'add', col: 'buyins', data: { pid: me.id, n: 1 } });
  let mine = (await post('/api/mine', { userId: HOST })).body.nights;
  assert.deepEqual(mine.map(n => [n.code, n.status, n.buyins, n.players, n.reported]), [[first.night.code, 'open', 1, 1, 0]]);
  assert.ok(!('closedAt' in mine[0]));

  await store.write(pool, tok, { op: 'set', col: 'cashouts', id: me.id, data: { chips: 1000 } });
  mine = (await post('/api/mine', { userId: HOST })).body.nights;
  assert.equal(mine[0].status, 'settled');
  assert.ok(mine[0].closedAt);

  const second = (await open(post)).body;
  await store.cancelNight(pool, tokenOf(second.url));
  mine = (await post('/api/mine', { userId: HOST })).body.nights;
  assert.deepEqual(mine.map(n => [n.code, n.status]), [[second.night.code, 'closed_without_settlement'], [first.night.code, 'settled']]);
  assert.deepEqual((await post('/api/mine', { userId: DANA })).body.nights, []);
});
