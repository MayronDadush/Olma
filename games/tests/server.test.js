'use strict';
// gamesd end to end: a real server on a random port, a real database, and
// the same HTTP calls the page makes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { createServer } = require('../src/server');
const { seatTag } = require('../src/store');

async function boot(t) {
  const pool = await freshDb(t);
  // brokerd is never reached from a test: a close is recorded here instead.
  const announced = [];
  const announce = async (p, nightId, state) => { announced.push({ nightId, closedAt: state.game.closedAt }); return { ok: true, queued: [], skipped: [] }; };
  const server = createServer({ pool, publicBase: 'https://allma.test', page: '<!doctype html><title>night</title>', announce });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeListeners(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { pool, base, post, announced };
}

async function openNight(post, extra = {}) {
  const res = await post('/api/nights', { name: 'פוקר של חמישי', price: 50, chips: 1000, players: ['מיכל', 'יוסי', 'דני'], ...extra });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.token, /^[A-Za-z0-9]{22}$/);
  assert.match(body.code, /^[2-9A-HJ-KM-NP-Z]{5}$/);
  assert.equal(body.url, 'https://allma.test/night/' + body.token);
  return body.token;
}

test('a night opens from the box, and the page and its state answer on its link', async t => {
  const { base, post } = await boot(t);
  const token = await openNight(post);
  const page = await fetch(`${base}/night/${token}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const st = await (await fetch(`${base}/night/${token}/api/state`)).json();
  assert.equal(st.game.name, 'פוקר של חמישי');
  assert.equal(st.game.price, 50);
  assert.deepEqual(Object.values(st.players).map(p => p.name).sort(), ['דני', 'יוסי', 'מיכל']);
});

test('a link that is not a night is a 404, and so is anything outside the two public shapes', async t => {
  const { base } = await boot(t);
  assert.equal((await fetch(`${base}/night/${'A'.repeat(22)}`)).status, 404);
  assert.equal((await fetch(`${base}/night/short`)).status, 404);
  assert.equal((await fetch(`${base}/night/${'A'.repeat(22)}/api/secrets`)).status, 404);
});

test('opening a night through a proxy is refused, even with the right path', async t => {
  const { post } = await boot(t);
  const res = await post('/api/nights', { name: 'x', price: 50, chips: 1000 }, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(res.status, 404);
});

test('a whole night: buy-ins, a half, an undo, counts that do not add up, then do, and game_results follows', async t => {
  const { pool, base, post, announced } = await boot(t);
  const token = await openNight(post);
  const W = async w => { const r = await post(`/night/${token}/api/write`, w); const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b; };
  let st = (await (await fetch(`${base}/night/${token}/api/state`)).json());
  const [m, y, d] = Object.entries(st.players).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);

  for (const pid of [m, y, d, d]) await W({ op: 'add', col: 'buyins', data: { pid, n: 1, at: Date.now(), via: 'tap' } });
  const half = await W({ op: 'add', col: 'buyins', data: { pid: y, n: 0.5, at: Date.now() } });
  await W({ op: 'delete', col: 'buyins', id: half.id });

  await W({ op: 'set', col: 'cashouts', id: m, data: { chips: 2000 } });
  await W({ op: 'set', col: 'cashouts', id: y, data: { chips: 500 } });
  st = (await W({ op: 'set', col: 'cashouts', id: d, data: { chips: 1499 } })).state;
  assert.equal(st.game.closedAt, null, 'one chip short: not closed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_results')).rows[0].n, 0);

  assert.equal(announced.length, 0);
  const closing = await W({ op: 'set', col: 'cashouts', id: d, data: { chips: 1500 } });
  st = closing.state;
  assert.ok(st.game.closedAt, 'adds up: closed');
  assert.equal(announced.length, 1, 'a tap that closes the count announces it');
  assert.ok(!('closed' in closing), 'the night\'s own id never reaches the page');
  const rows = (await pool.query('SELECT player_id, net_ag, buyins, pot_ag FROM game_results ORDER BY net_ag DESC')).rows;
  assert.deepEqual(rows.map(r => [r.player_id, r.net_ag, r.buyins, r.pot_ag]), [[m, 5000, 1, 20000], [y, -2500, 1, 20000], [d, -2500, 2, 20000]]);

  // a correction after closing rewrites the rows, never adds more
  await W({ op: 'set', col: 'cashouts', id: m, data: { chips: 1500 } });
  await W({ op: 'set', col: 'cashouts', id: y, data: { chips: 1000 } });
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_results')).rows[0].n, 3);
  assert.equal((await pool.query(`SELECT net_ag FROM game_results WHERE player_id = $1`, [m])).rows[0].net_ag, 2500);
  // It reopened on the first correction and closed on the second: a new
  // settlement, so a second announcement. A write to a night already closed
  // announces nothing.
  assert.equal(announced.length, 2);
  await W({ op: 'add', col: 'log', data: { t: 'סוף', via: 'tap' } });
  assert.equal(announced.length, 2);

  // and a count taken back reopens the night and empties its results
  st = (await W({ op: 'delete', col: 'cashouts', id: d })).state;
  assert.equal(st.game.closedAt, null);
  assert.equal(announced.length, 2, 'reopening is not news');
  assert.equal((await pool.query('SELECT count(*)::int n FROM game_results')).rows[0].n, 0);
});

test('food, the night itself, and the log go through; nonsense is refused whole', async t => {
  const { base, post } = await boot(t);
  const token = await openNight(post);
  const st = (await (await fetch(`${base}/night/${token}/api/state`)).json());
  const [a, b] = Object.keys(st.players);
  const w = body => post(`/night/${token}/api/write`, body);

  let r = await w({ op: 'add', col: 'food', data: { kind: 'pizza', what: 'פיצה', amount: 240, payer: a, eaters: [a, b], own: { a: 58 } } });
  assert.equal(r.status, 400, 'an own-dish key that is not an id shape is refused');
  r = await w({ op: 'add', col: 'food', data: { kind: 'pizza', what: 'פיצה', amount: 240, payer: a, eaters: [a, b] } });
  assert.equal(r.status, 200);
  const { id: fid, state } = await r.json();
  assert.equal(state.food[fid].amount, 240);

  assert.equal((await w({ op: 'update', col: 'game', data: { foodMode: 'split', name: 'פוקר של שישי' } })).status, 200);
  assert.equal((await w({ op: 'update', col: 'game', data: { token: 'x' } })).status, 400, 'only the four night fields');
  assert.equal((await w({ op: 'add', col: 'buyins', data: { pid: a, n: 3 } })).status, 400, 'a buy-in is 1 or ½');
  assert.equal((await w({ op: 'add', col: 'buyins', data: { pid: 'nobody00', n: 1 } })).status, 404);
  assert.equal((await w({ op: 'set', col: 'cashouts', id: a, data: { chips: -5 } })).status, 400);
  assert.equal((await w({ op: 'drop', col: 'nights' })).status, 400);
  assert.equal((await w({ op: 'add', col: 'log', data: { t: 'מיכל + כניסה', via: 'tap' } })).status, 200);

  const after = await (await fetch(`${base}/night/${token}/api/state`)).json();
  assert.equal(after.game.name, 'פוקר של שישי');
  assert.equal(after.game.foodMode, 'split');
  assert.equal(Object.keys(after.log).length, 1);
});

test('a seat added by mistake comes off, but never with money on it, and never once the count closed', async t => {
  const { pool, base, post } = await boot(t);
  const token = await openNight(post, { players: ['מיכל', 'יוסי'] });
  const w = async body => { const r = await post(`/night/${token}/api/write`, body); return { status: r.status, ...(await r.json()) }; };
  const st0 = await (await fetch(`${base}/night/${token}/api/state`)).json();
  const [m, y] = Object.entries(st0.players).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  const del = id => w({ op: 'delete', col: 'players', id });
  const seat = async (id, name) => assert.equal((await w({ op: 'set', col: 'players', id, data: { name, order: Date.now() } })).status, 200);

  // the case it exists for: a name nobody played under
  await seat('oops01', 'דני');
  let r = await del('oops01');
  assert.equal(r.status, 200);
  assert.ok(!r.state.players.oops01);
  assert.equal((await del('oops01')).error, 'not_found', 'twice is not found, not a second removal');
  assert.equal((await del('x')).error, 'bad_id');

  // a buy-in on it: refused until the buy-in is taken back
  const bi = await w({ op: 'add', col: 'buyins', data: { pid: y, n: 1 } });
  assert.equal((await del(y)).error, 'has_money');
  await w({ op: 'delete', col: 'buyins', id: bi.id });
  assert.equal((await del(y)).status, 200);

  // a count alone, and every way into an order, each hold the seat
  await seat('cnt001', 'גל');
  await w({ op: 'set', col: 'cashouts', id: 'cnt001', data: { chips: 0 } });
  assert.equal((await del('cnt001')).error, 'has_money', 'a count of zero is still a count');
  const food = async data => (await w({ op: 'add', col: 'food', data: { what: 'פיצה', amount: 100, payer: m, eaters: [m], ...data } })).id;
  for (const [name, data] of [
    ['payer', pid => ({ payer: pid })],
    ['eater', pid => ({ eaters: [m, pid] })],
    ['own dish', pid => ({ own: { [pid]: 30 } })],
    ['paid back', pid => ({ paid: { [pid]: 30 } })],
  ]) {
    await seat('food01', 'רון');
    const fid = await food(data('food01'));
    assert.equal((await del('food01')).error, 'has_money', `the ${name} of an order`);
    await w({ op: 'delete', col: 'food', id: fid });
    assert.equal((await del('food01')).status, 200, `with the order gone, the ${name} comes off`);
  }

  // somebody who joined from WhatsApp comes off too, and their link with it:
  // putting the name back is a new seat, and the code is how they return
  await seat('link01', 'נועה');
  await pool.query(`UPDATE players SET user_id = 7, linked_at = now(), linked_via = 'invite' WHERE id = 'link01'`);
  assert.equal((await del('link01')).status, 200);
  await seat('link01', 'נועה');
  assert.equal((await pool.query(`SELECT user_id FROM players WHERE id = 'link01'`)).rows[0].user_id, null);

  // closed: nothing comes off, not even an empty seat
  await w({ op: 'delete', col: 'cashouts', id: 'cnt001' });
  await w({ op: 'add', col: 'buyins', data: { pid: m, n: 1 } });
  r = await w({ op: 'set', col: 'cashouts', id: m, data: { chips: 1000 } });
  assert.ok(r.state.game.closedAt, 'one player, square count: closed');
  assert.equal((await del('link01')).error, 'closed');
  assert.equal((await del('cnt001')).error, 'closed');
});

test('one seat, one phone: a held seat is refused unless taken on purpose, and a phone sits in one seat', async t => {
  const { post } = await boot(t);
  const token = await openNight(post, { players: ['מירון', 'מיכל'] });
  const w = async body => { const r = await post(`/night/${token}/api/write`, body); return { status: r.status, ...(await r.json()) }; };
  const st0 = await (await w({ op: 'add', col: 'log', data: { t: 'x' } })).state;
  const [mir, mic] = Object.entries(st0.players).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  const A = 'phoneAAAA01', B = 'phoneBBBB02';
  // the state carries a hash of the phone's tag, never the tag (migration 004)
  const hA = seatTag(A), hB = seatTag(B);
  const hold = (id, device, take) => w({ op: 'hold', col: 'players', id, data: { device, ...(take ? { take: true } : {}) } });

  // the incident: Miron is held by phone A, and phone B taps Miron too
  let r = await hold(mir, A);
  assert.equal(r.status, 200);
  assert.equal(r.state.players[mir].held, hA);
  assert.equal((await hold(mir, B)).error, 'held', 'a second phone is refused the first time');
  assert.equal((await hold(mir, A)).status, 200, 'the same phone again is no conflict');

  // a phone sits in one seat: B in Michal, then B in Miron on purpose, lets Michal go
  assert.equal((await hold(mic, B)).state.players[mic].held, hB);
  r = await hold(mir, B, true);
  assert.equal(r.state.players[mir].held, hB, 'a confirmed second tap takes the seat');
  assert.equal(r.state.players[mic].held, undefined, 'and the seat it held before is free');

  // release: only the phone's own hold comes off
  r = await w({ op: 'release', col: 'players', id: mir, data: { device: A } });
  assert.equal(r.state.players[mir].held, hB, 'A cannot release a seat B holds');
  r = await w({ op: 'release', col: 'players', id: mir, data: { device: B } });
  assert.equal(r.state.players[mir].held, undefined);

  // renaming a seat keeps its phone; nonsense is refused whole
  await hold(mic, A);
  r = await w({ op: 'set', col: 'players', id: mic, data: { name: 'מיכלי', order: 1 } });
  assert.equal(r.state.players[mic].held, hA);
  assert.equal((await hold(mic, 'short')).error, 'bad_doc');
  assert.equal((await hold(mic, '../etc/passwd')).error, 'bad_doc');
  assert.equal((await hold('nobody01', A)).error, 'not_found');
});

test('a player cap stops a link in the wrong hands from filling the table', async t => {
  const { post } = await boot(t);
  const token = await openNight(post, { players: [] });
  for (let i = 0; i < 30; i++) {
    const r = await post(`/night/${token}/api/write`, { op: 'set', col: 'players', id: 'pl' + i, data: { name: 'שחקן ' + i, order: i } });
    assert.equal(r.status, 200);
  }
  const r = await post(`/night/${token}/api/write`, { op: 'set', col: 'players', id: 'pl30', data: { name: 'עוד אחד', order: 30 } });
  assert.equal(r.status, 429);
});

test('writes are rate limited per night', async t => {
  const { post } = await boot(t);
  const token = await openNight(post);
  let last;
  for (let i = 0; i < 125; i++) last = await post(`/night/${token}/api/write`, { op: 'add', col: 'log', data: { t: 'x' + i } });
  assert.equal(last.status, 429);
});

test('the next night keeps the table and the price, on a new link', async t => {
  const { base, post } = await boot(t);
  const token = await openNight(post);
  const r = await post(`/night/${token}/api/next`, {});
  assert.equal(r.status, 201);
  const { token: t2 } = await r.json();
  assert.notEqual(t2, token);
  const st = await (await fetch(`${base}/night/${t2}/api/state`)).json();
  assert.equal(st.game.price, 50);
  assert.equal(Object.keys(st.players).length, 3);
  assert.equal(Object.keys(st.buyins).length, 0);
});

test('the event stream pushes the new state to another phone after a write', async t => {
  const { base, post } = await boot(t);
  const token = await openNight(post);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(`${base}/night/${token}/api/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const nextState = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').find(l => l.startsWith('data: '));
        if (block.includes('event: state') && data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
    }
  };
  const first = await nextState();
  const pid = Object.keys(first.players)[0];
  await post(`/night/${token}/api/write`, { op: 'add', col: 'buyins', data: { pid, n: 1 } });
  const second = await nextState();
  assert.equal(Object.keys(second.buyins).length, 1);
});

// The owner, 2026-10-05: a locked night's buy-ins and other players' chips
// are the host's; everybody still writes their own chips, names and food.
test('a locked night: buy-ins and others\' chips are the host\'s phone alone, and the host seat cannot be walked off with', async t => {
  const { pool, post } = await boot(t);
  const token = await openNight(post, { players: ['מירון', 'מיכל', 'יוסי'] });
  const w = async body => { const r = await post(`/night/${token}/api/write`, body); return { status: r.status, ...(await r.json()) }; };
  const st0 = (await w({ op: 'add', col: 'log', data: { t: 'x' } })).state;
  const [mir, mic, yos] = Object.entries(st0.players).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);
  const H = 'hostPhone01', M = 'michalPhone2', X = 'strangerPh3';
  const hold = (id, device, extra = {}) => w({ op: 'hold', col: 'players', id, data: { device, ...extra } });
  const lock = (on, device) => w({ op: 'update', col: 'game', data: { locked: on }, device });
  const buy = (pid, device) => w({ op: 'add', col: 'buyins', data: { pid, n: 1 }, device });
  const chips = (pid, n, device) => w({ op: 'set', col: 'cashouts', id: pid, data: { chips: n }, device });

  // a night from the box has no host and cannot be locked
  assert.equal(st0.game.host, null);
  assert.equal((await lock(true, H)).error, 'no_host');
  const { rows: [n] } = await pool.query('SELECT id FROM nights WHERE token = $1', [token]);
  await pool.query('UPDATE nights SET host_player = $2 WHERE id = $1', [n.id, mir]);

  await hold(mir, H); await hold(mic, M);
  assert.equal((await lock(true, M)).error, 'not_host', 'only the host locks');
  assert.equal((await lock(true)).error, 'not_host', 'a write with no phone is nobody');
  let r = await lock(true, H);
  assert.equal(r.status, 200);
  assert.equal(r.state.game.locked, true);
  assert.equal(JSON.stringify(r.state).includes(H), false, 'the host\'s tag never reaches the state');

  // buy-ins: host only, either way
  assert.equal((await buy(mic, M)).error, 'locked');
  assert.equal((await buy(mic, M)).status, 403);
  const b = await buy(mic, H);
  assert.equal(b.status, 200);
  assert.equal((await w({ op: 'delete', col: 'buyins', id: b.id, device: M })).error, 'locked');

  // chips: your own seat, or the host
  assert.equal((await chips(mic, 800, M)).status, 200, 'Michal writes her own');
  assert.equal((await chips(yos, 800, M)).error, 'locked', 'not Yossi\'s');
  assert.equal((await chips(yos, 900, H)).status, 200, 'the host writes anybody\'s');
  // and the rest stays open to everyone
  assert.equal((await w({ op: 'set', col: 'players', id: mic, data: { name: 'מיכלי', order: 1 }, device: M })).status, 200);
  assert.equal((await w({ op: 'add', col: 'food', data: { what: 'פיצה', amount: 90, payer: mic, eaters: [mic, yos] }, device: M })).status, 200);

  // the host seat: not taken, not let go, not deleted while locked
  assert.equal((await hold(mir, X, { take: true })).error, 'host_seat');
  assert.equal((await w({ op: 'release', col: 'players', id: mir, data: { device: H } })).error, 'host_seat');
  assert.equal((await w({ op: 'delete', col: 'players', id: mir })).error, 'host_seat');

  // a new phone with the one-time key Olma sends: once, and only once
  const key = await require('../src/store').hostKey(pool, n.id);
  assert.equal((await hold(mir, X, { key: 'wrongKeyWrongKey99' })).error, 'host_seat');
  r = await hold(mir, X, { key });
  assert.equal(r.status, 200);
  assert.equal(r.state.players[mir].held, seatTag(X));
  assert.equal((await buy(yos, X)).status, 200, 'the new phone is the host now');
  assert.equal((await buy(yos, H)).error, 'locked', 'and the old one is not');
  assert.equal((await hold(mir, H, { key, take: true })).error, 'host_seat', 'a used key is spent');

  // unlocked, everybody writes again
  assert.equal((await lock(false, X)).status, 200);
  assert.equal((await buy(yos, M)).status, 200);
});

test('whoever presses "ערב חדש" is the new night\'s host, in the same seat on the same phone', async t => {
  const { base, post } = await boot(t);
  const token = await openNight(post, { players: ['מירון', 'מיכל'] });
  const w = body => post(`/night/${token}/api/write`, body).then(r => r.json());
  const st0 = (await w({ op: 'add', col: 'log', data: { t: 'x' } })).state;
  const mic = Object.keys(st0.players).find(id => st0.players[id].name === 'מיכל');
  await w({ op: 'hold', col: 'players', id: mic, data: { device: 'michalPhone2' } });
  const res = await post(`/night/${token}/api/next`, { device: 'michalPhone2' });
  assert.equal(res.status, 201);
  const next = (await res.json()).token;
  const st = await (await post(`/night/${next}/api/write`, { op: 'update', col: 'game', data: { locked: true }, device: 'michalPhone2' })).json();
  assert.equal(st.state.game.locked, true);
  assert.equal(st.state.players[st.state.game.host].name, 'מיכל');
  assert.equal(st.state.players[st.state.game.host].held, seatTag('michalPhone2'));
  // a phone with no seat opens one with no host
  const other = await (await post(`/night/${token}/api/next`, {})).json();
  const st2 = await (await fetch(`${base}/night/${other.token}/api/state`)).json();
  assert.equal(st2.game.host, null);
});
