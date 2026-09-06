'use strict';
// מעיין wrote to Olma on 2026-09-05 at 23:06 Israel time and waited a day,
// because nothing in this system could see her: the gateway accepted her
// message and dropped it 21ms later, so she never got a session and never
// became a user row — and every other check starts from `users`.
//
// The founding case is replayed first, end to end, exactly as it happened.
// The two cases that must stay SILENT matter just as much: a detector that
// goes red whenever registration is closed is a detector somebody turns off.
const { freshDb, makeUser } = require('./helpers');
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const guard = require('../src/jobs/config-guard');
const sessions = require('../src/channels/sessions');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const HOUR = 3600_000;
const now = new Date('2026-09-06T18:00:00Z');
const yesterday = Date.parse('2026-09-05T20:06:11Z'); // her real timestamp

// Drives the check with the gateway's two stores stubbed, which is the only
// way to write down "the gateway said X" without a gateway.
function withPeers(peers, seen = []) {
  return {
    now,
    listInboundPeers: async () => peers,
    listSessions: async () => seen,
  };
}
const peer = (phone, lastAt = yesterday, extra = {}) => ({
  laneKey: '70278717694032@lid', phone, firstAt: lastAt, lastAt, events: 1, ...extra,
});

test('the stranger whose message was dropped is named, with her number', async () => {
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, withPeers([peer('+972502200581')]));
    assert.equal(res.skipped, null);
    assert.equal(res.violations.length, 1);
    assert.match(res.violations[0], /\+972502200581/);
    assert.match(res.violations[0], /no session and no user row/);
  } finally { client.release(); }
});

test('the title does not move when the person writes again', async () => {
  // It is the dedup key (fileViolations keys on title). A "last seen" stamp or
  // a message count in it closes the open row and files a fresh one every time
  // the person sends another message — turning one waiting stranger into a
  // stream of issues, which is exactly the noise this guard exists to avoid.
  const client = await db.pool.connect();
  try {
    const first = await guard.checkUnansweredStrangers(client, withPeers(
      [peer('+972502200581', yesterday, { events: 1, firstAt: yesterday })]));
    const again = await guard.checkUnansweredStrangers(client, withPeers(
      [peer('+972502200581', now.getTime() - HOUR, { events: 4, firstAt: yesterday })]));
    assert.deepEqual(again.violations, first.violations,
      'same person waiting = same row, however many times they wrote');
  } finally { client.release(); }
});

test('a person who became a user is not reported', async () => {
  const client = await db.pool.connect();
  try {
    await makeUser(db.pool, '+972502200581', { firstName: 'מעיין' });
    const res = await guard.checkUnansweredStrangers(client, withPeers([peer('+972502200581')]));
    assert.deepEqual(res.violations, [],
      'onboarding them is the fix, so the row must close on its own');
  } finally { client.release(); }
});

test('a stranger the intake greeter answered is NOT reported', async () => {
  // Registration closed: strangers get a reply and deliberately no user row.
  // Without this test the check would be permanently red whenever the door is
  // shut, which is how an alert list dies.
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, withPeers(
      [peer('+972599111222')],
      [{ agentId: 'intake', peer: '+972599111222' }]));
    assert.deepEqual(res.violations, [], 'a session means somebody saw them');
  } finally { client.release(); }
});

test('someone who wrote seconds ago is given time to be picked up', async () => {
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, withPeers(
      [peer('+972599111333', now.getTime() - 60_000)]));
    assert.deepEqual(res.violations, [], 'the intake sweep has not had its tick yet');
    const later = await guard.checkUnansweredStrangers(client, withPeers(
      [peer('+972599111333', now.getTime() - 2 * HOUR)]));
    assert.equal(later.violations.length, 1, 'and is reported once the grace passes');
  } finally { client.release(); }
});

test('an unreadable gateway store declines to judge, and says so', async () => {
  // "A thing that could not be READ is never a thing in trouble" — and
  // "a check that goes quiet is indistinguishable from one that passes", so
  // it has to report the silence too.
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, withPeers(null));
    assert.deepEqual(res.violations, []);
    assert.match(res.skipped, /unreadable/);
  } finally { client.release(); }
});

test('read-but-empty is not the same value as could-not-read', async () => {
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client, withPeers([]));
    assert.deepEqual(res.violations, []);
    assert.equal(res.skipped, null, 'nothing to report is not a check that declined');
  } finally { client.release(); }
});

test('a lane nobody can resolve to a number is still reported', async () => {
  const client = await db.pool.connect();
  try {
    const res = await guard.checkUnansweredStrangers(client,
      withPeers([peer(null)]));
    assert.equal(res.violations.length, 1);
    assert.match(res.violations[0], /cannot be resolved to a phone number/);
  } finally { client.release(); }
});

// ---- the reader itself, against a real sqlite file --------------------------

test('listInboundPeers reads lanes, resolves LIDs and drops groups and self', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-gw-'));
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  const creds = path.join(base, 'credentials', 'whatsapp', 'default');
  fs.mkdirSync(creds, { recursive: true });

  const gw = new DatabaseSync(path.join(base, 'state', 'openclaw.sqlite'));
  gw.exec(`CREATE TABLE channel_ingress_events (
    lane_key TEXT, received_at INTEGER, status TEXT)`);
  const add = (lane, at) => gw.prepare(
    'INSERT INTO channel_ingress_events (lane_key, received_at, status) VALUES (?, ?, ?)'
  ).run(lane, at, 'completed');
  add('70278717694032@lid', yesterday);          // a stranger, by LID
  add('70278717694032@lid', yesterday + 1000);   // twice
  add('972544000111@s.whatsapp.net', yesterday); // a stranger, by phone JID
  add('232040725262501@lid', yesterday);         // Olma's own LID (self-chat)
  add('972526269826-1441911253@g.us', yesterday); // a group, not a person
  gw.close();

  fs.writeFileSync(path.join(creds, 'lid-mapping-70278717694032_reverse.json'),
    JSON.stringify('972502200581'));
  fs.writeFileSync(path.join(creds, 'creds.json'), JSON.stringify({
    me: { id: '972559347282:3@s.whatsapp.net', lid: '232040725262501:3@lid' },
    // A real creds.json is full of key material; none of it may ever leave.
    noiseKeys: { signedIdentityKey: 'MUST NOT LEAK' },
  }));

  const peers = sessions.listInboundPeers(base);
  const byPhone = Object.fromEntries(peers.map((p) => [p.phone, p]));
  assert.deepEqual(Object.keys(byPhone).sort(), ['+972502200581', '+972544000111'],
    'self-chat and the group must both be gone');
  assert.equal(byPhone['+972502200581'].events, 2, 'both of her events counted');
  assert.equal(byPhone['+972502200581'].lastAt, yesterday + 1000);
  assert.ok(!JSON.stringify(peers).includes('MUST NOT LEAK'),
    'nothing but me.id/me.lid may be read out of creds.json');

  fs.rmSync(base, { recursive: true, force: true });
});

test('listInboundPeers returns null — not [] — when there is no gateway store', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-gw-empty-'));
  assert.equal(sessions.listInboundPeers(base), null,
    'could-not-read must never collapse into found-nothing');
  fs.rmSync(base, { recursive: true, force: true });
});

test('listInboundPeers returns null when the gateway renames the table', () => {
  // The table belongs to the gateway, not to us. A version bump that drops it
  // must read as "cannot judge", never as "nobody has ever written to Olma".
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-gw-moved-'));
  fs.mkdirSync(path.join(base, 'state'), { recursive: true });
  const gw = new DatabaseSync(path.join(base, 'state', 'openclaw.sqlite'));
  gw.exec('CREATE TABLE something_else (x INTEGER)');
  gw.close();
  assert.equal(sessions.listInboundPeers(base), null);
  fs.rmSync(base, { recursive: true, force: true });
});
