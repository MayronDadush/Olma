'use strict';
// Ringing Olma from the personal page. The tile has drawn itself "בקרוב" since
// the page shipped and there was nothing behind it; there is now, and the whole
// point of these tests is that turning it on is a DELIBERATE act — an empty
// allowlist has to keep the button hidden and refuse the action anyway, or
// "wired but not available" is just "available".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const flags = require('../src/domain/flags');
const voice = require('../src/domain/voice');

let db, me, bridge, dialled;
const PHONE = '+972531920077';
const tx = (fn) => withTx(db.pool, fn);
const act = (action, payload = {}) => tx((c) => write.perform(c, me.id, action, payload));
const load = () => tx((c) => dash.load(c, me.id));
const setPhones = (v) => tx((c) => flags.setFlag(c, voice.PAGE_CALL_PHONES_FLAG, v));

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, PHONE, { firstName: 'Miron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  // A stand-in for the voice bridge, on a real socket. The action calls
  // `voice.requestCall` with no injection point, which is the honest shape —
  // so the test moves the URL rather than the code.
  bridge = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      dialled.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, callSid: 'CA-test' }));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  process.env.VOICE_BRIDGE_DIAL_URL = `http://127.0.0.1:${bridge.address().port}/dial`;
});
after(async () => {
  delete process.env.VOICE_BRIDGE_DIAL_URL;
  if (bridge) await new Promise((r) => bridge.close(r));
  if (db) await db.teardown();
});

test('with nobody on the list the page is not offered a call, and asking anyway is refused', async () => {
  dialled = [];
  await setPhones('');

  const page = await load();
  assert.equal(page.ok, true);
  assert.equal(page.data.available.call, false,
    'an empty allowlist must leave the tile drawing itself "בקרוב"');

  const res = await act('callMe');
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_enabled');
  assert.deepEqual(dialled, [], 'nothing may reach the bridge for somebody not on the list');
});

test('a number on the list gets the tile, and the tap reaches the bridge as that number', async () => {
  dialled = [];
  await setPhones(PHONE);

  const page = await load();
  assert.equal(page.data.available.call, true);

  const res = await act('callMe');
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.calling, true);
  assert.deepEqual(dialled, [{ phone: PHONE }],
    'the bridge is asked to dial the account it belongs to, never a number off the payload');

  const { rows } = await db.pool.query(
    `SELECT event FROM audit_log WHERE actor_id = $1 ORDER BY id`, [me.id]);
  const events = rows.map((r) => r.event);
  assert.ok(events.includes('voice.call_requested'), 'the call is on the trail');
  assert.ok(events.includes('dashboard.callMe'), 'and so is the door it came through');
});

test('somebody else on the list does not put the tile on my page', async () => {
  await setPhones('+972500000000');
  const page = await load();
  assert.equal(page.data.available.call, false);
  assert.equal((await act('callMe')).error.reason, 'not_enabled');
});

test('a paused account is refused before the bridge is ever asked', async () => {
  dialled = [];
  await setPhones(PHONE);
  await db.pool.query(`UPDATE users SET paused_at = now() WHERE id = $1`, [me.id]);
  try {
    const res = await act('callMe');
    assert.equal(res.ok, false);
    assert.equal(res.error.reason, 'paused');
    assert.deepEqual(dialled, [], 'a paused person is not rung by their own tap either');
  } finally {
    await db.pool.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [me.id]);
  }
});

test('the page keeps the tile shut until the server says otherwise', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');
  assert.match(page, /var callReady = !LIVE \|\| AVAIL\.call === true;/,
    'the live tile must open on the server\'s answer and nothing else');
  assert.match(page, /AVAIL\.call = !!\(d\.available && d\.available\.call\);/,
    'and that answer has to be read out of the payload');
  assert.match(page, /toast\.callFailed/,
    'a call that does not go through says so — nothing on screen changed to hint at it');
});
