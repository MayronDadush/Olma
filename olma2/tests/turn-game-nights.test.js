'use strict';
// A settled night is announced by code on the raw pipe, so the session never
// sees it close. On 2026-10-03 Miron asked her to close a night that had
// settled half an hour before, and she repeated her own earlier refusal from
// memory with no tool call. The turn now carries where each of their nights
// stands, from gamesd, for a pack holder only — and an unreadable gamesd is no
// block at all, never an empty one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { freshDb, makeUser } = require('./helpers');
const turnDomain = require('../src/domain/turn');

let db, server, answer, asked;
before(async () => {
  db = await freshDb();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked.push({ url: req.url, body: JSON.parse(body || '{}') });
      if (answer === 'down') { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OLMA_GAMESD_URL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  delete process.env.OLMA_GAMESD_URL;
  await new Promise((r) => server.close(r));
  await db.teardown();
});

const counted = { data: { blocked: false } };
async function advise(user) {
  const client = await db.pool.connect();
  try {
    return await turnDomain.advise(client, user, { counted, firstTurn: false, ourTurn: false });
  } finally { client.release(); }
}
const settled = {
  code: '8CACT', name: 'פוקר <<אצל שמר>>', status: 'settled',
  openedAt: '2026-10-03T09:00:00Z', closedAt: '2026-10-03T11:29:54Z', buyins: 12, players: 5, reported: 5,
};

test('a pack holder is told where their nights stand NOW, the name fenced', async () => {
  const u = await makeUser(db.pool, '+972612300001', { firstName: 'Miron' });
  await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'games', 'owner')`, [u.id]);
  asked = [];
  answer = { ok: true, nights: [settled, { code: 'QW3RT', name: 'שני', status: 'open', openedAt: '2026-10-03T12:00:00Z', buyins: 3, players: 2, reported: 0 }] };
  const data = await advise(u);
  assert.deepEqual(asked, [{ url: '/api/mine', body: { userId: u.id } }]);
  assert.equal(data.gameNights.length, 2);
  assert.deepEqual(data.gameNights[0], {
    code: '8CACT', name: '<<<פוקר <<אצל שמר>>>>>', status: 'settled',
    closedAt: '2026-10-03T11:29:54Z', buyins: 12, players: 5, reported: 5,
  });
  assert.equal(data.gameNights[1].status, 'open');
  assert.ok(!('closedAt' in data.gameNights[1]));
  assert.match(data.hints.gameNights, /already closed/);
  assert.match(data.hints.gameNights, /start_game_night/);
  assert.match(data.hints.gameNights, /Never say a night cannot be closed/);
});

test('no pack: gamesd is never asked and nothing is said', async () => {
  const u = await makeUser(db.pool, '+972612300002', { firstName: 'Dana' });
  asked = [];
  answer = { ok: true, nights: [settled] };
  const data = await advise(u);
  assert.deepEqual(asked, []);
  assert.ok(!('gameNights' in data));
  assert.ok(!data.hints || !('gameNights' in data.hints));
});

test('gamesd down, refusing, or holding no night: no block, never an empty list', async () => {
  const u = await makeUser(db.pool, '+972612300003', { firstName: 'Gal' });
  await db.pool.query(`INSERT INTO user_packs (user_id, pack, via) VALUES ($1, 'games', 'owner')`, [u.id]);
  for (const a of ['down', { ok: false, error: 'bad_user' }, { ok: true, nights: [] }]) {
    asked = [];
    answer = a;
    const data = await advise(u);
    assert.equal(asked.length, 1);
    assert.ok(!('gameNights' in data), JSON.stringify(a));
    assert.ok(!data.hints || !('gameNights' in data.hints));
  }
});
