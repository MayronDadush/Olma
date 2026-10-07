'use strict';
// 2026-10-07: two new people wrote and heard nothing, because the gateway
// dropped their first message before any session opened. The founding case is
// one of them (digits changed), replayed against stubbed gateway stores — the
// only way to say "the gateway said X" without touching the live one.
const { freshDb, makeUser } = require('./helpers');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const greet = require('../src/jobs/stranger-greet');
const guard = require('../src/jobs/config-guard');
const flags = require('../src/domain/flags');
const templates = require('../src/domain/message-templates');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await db.pool.query('DELETE FROM stranger_greetings');
  await flags.setFlag(db.pool, 'registration_open', true);
});

const MIN = 60_000;
const now = new Date('2026-10-07T19:20:00Z');
const STRANGER = '+972509990273';
const peer = (phone, firstAgoMin, lastAgoMin = firstAgoMin, extra = {}) => ({
  laneKey: '7027871769@lid', phone,
  firstAt: now.getTime() - firstAgoMin * MIN, lastAt: now.getTime() - lastAgoMin * MIN,
  events: 2, ...extra,
});

function deps(peers, seen = [], sendResult = { ok: true }) {
  const sent = [];
  return {
    sent,
    now,
    listInboundPeers: async () => peers,
    listSessions: async () => seen,
    send: async (phone, text) => { sent.push({ phone, text }); return sendResult; },
  };
}

test('a stranger whose first message was dropped gets the opening and the ask, once', async () => {
  const d = deps([peer(STRANGER, 30)]);
  const res = await greet.run(db.pool, d);
  assert.deepEqual(res, { greeted: 1, timedOut: 0, failed: 0 });
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].phone, STRANGER);
  // Hebrew, off the +972: the opening first, the missing-message line after it.
  assert.ok(d.sent[0].text.startsWith(templates.textFor('opening_he')));
  assert.ok(d.sent[0].text.endsWith(templates.textFor('lost_first_message_he')));

  const again = await greet.run(db.pool, d);
  assert.deepEqual(again, { greeted: 0 });
  assert.equal(d.sent.length, 1, 'never greeted twice');

  const { rows } = await db.pool.query('SELECT result, sent_at FROM stranger_greetings WHERE phone = $1', [STRANGER]);
  assert.equal(rows[0].result, 'sent');
  assert.ok(rows[0].sent_at);
});

test('a number outside Israel is greeted in English', async () => {
  const d = deps([peer('+447700900123', 30)]);
  await greet.run(db.pool, d);
  assert.ok(d.sent[0].text.startsWith(templates.textFor('opening_en')));
  assert.ok(d.sent[0].text.endsWith(templates.textFor('lost_first_message_en')));
});

test('silent: a peer with a session, a users row of any status, an old lane, or a lane still moving', async () => {
  await makeUser(db.pool, '+972509990001');
  await makeUser(db.pool, '+972509990002', { status: 'pending' });
  const d = deps([
    peer('+972509990000', 30), // the greeter answered them: a session
    peer('+972509990001', 30), // already a user
    peer('+972509990002', 30), // pending: we wrote first, the lane is our echo
    peer('+972509990003', 90), // first heard before the window
    peer('+972509990004', 2, 1), // still inside the settle minutes
    peer(null, 30), // a lane we cannot put a number to
  ], [{ peer: '+972509990000' }]);
  const res = await greet.run(db.pool, d);
  assert.deepEqual(res, { greeted: 0 });
  assert.equal(d.sent.length, 0);
});

test('an unreadable store is a skipped tick, never "nobody has a session"', async () => {
  const noPeers = deps(null);
  assert.match((await greet.run(db.pool, noPeers)).skipped, /ingress store unreadable/);
  const noSessions = deps([peer(STRANGER, 30)], null);
  assert.match((await greet.run(db.pool, noSessions)).skipped, /session stores unreadable/);
  assert.equal(noSessions.sent.length, 0);
});

test('registration closed: nobody is told to send it again', async () => {
  await flags.setFlag(db.pool, 'registration_open', false);
  const d = deps([peer(STRANGER, 30)]);
  assert.deepEqual(await greet.run(db.pool, d), { skipped: 'registration closed' });
  assert.equal(d.sent.length, 0);
});

test('a failed send is not retried, and the guard goes on reporting them', async () => {
  const d = deps([peer(STRANGER, 40)], [], { ok: false, error: 'refused' });
  assert.deepEqual(await greet.run(db.pool, d), { greeted: 0, timedOut: 0, failed: 1 });
  await greet.run(db.pool, d);
  assert.equal(d.sent.length, 1, 'the claim stands after a failure');

  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, {
      now: new Date(now.getTime() + 60 * MIN),
      listInboundPeers: async () => [peer(STRANGER, 40)],
      listSessions: async () => [],
    });
    assert.equal(res.violations.length, 1);
  } finally { client.release(); }
});

test('a timed-out send counts as said, and the guard stops reporting somebody greeted', async () => {
  const d = deps([peer(STRANGER, 40)], [], { ok: false, timedOut: true });
  assert.deepEqual(await greet.run(db.pool, d), { greeted: 0, timedOut: 1, failed: 0 });
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, {
      now: new Date(now.getTime() + 60 * MIN),
      listInboundPeers: async () => [peer(STRANGER, 40)],
      listSessions: async () => [],
    });
    assert.deepEqual(res.violations, []);
  } finally { client.release(); }
});

test('a claim already in the table (a restart mid-send) sends nothing', async () => {
  await db.pool.query('INSERT INTO stranger_greetings (phone) VALUES ($1)', [STRANGER]);
  const d = deps([peer(STRANGER, 30)]);
  assert.deepEqual(await greet.run(db.pool, d), { greeted: 0 });
  assert.equal(d.sent.length, 0);
});
