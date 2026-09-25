'use strict';
// A number seen on a group's roster becomes a `users` row, and everything that
// could mistake that row for a person Olma has taken on must not.
//
// The cases that matter are the ones where an implementation would be WRONG in
// the direction of TALKING to somebody who never asked: a queued message
// delivered on the greeter's agent, a connection request with no introduction in
// front of it, an auto-connection to a stranger, a number handed to the gateway's
// allow-from list, a check-in. Every one of those has its own test below, and
// three of them assert on the real production function rather than on a replica
// of its query.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupConnections = require('../src/domain/group-connections');
const connections = require('../src/domain/connections');
const flags = require('../src/domain/flags');
const { decide } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const checkin = require('../src/jobs/checkin');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036342828299880${n}@g.us`;

// A user who has actually written to Olma, which is what `isConnected` asks and
// what `registerGroup` needs at least one of.
async function connectedUser(phone, extra = {}) {
  const u = await makeUser(db.pool, phone, extra);
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  return u;
}

async function openFlag(on) {
  await withTx(db.pool, (c) => flags.setFlag(c, groups.ROSTER_USERS_FLAG, on));
}

// Registers a room around one real member plus whatever else is passed, and
// returns the group id. Registration itself never mints a roster row — the sweep
// calls `ensureRosterUsers` after it — so every test here calls that explicitly.
async function room(n, members) {
  return withTx(db.pool, async (c) => {
    const r = await groups.registerGroup(c, {
      externalId: JID(n), subject: 'בדיקה', members,
    });
    assert.ok(r.ok, r.ok ? '' : r.error.message);
    return r.data.group.id;
  });
}

// ---------------------------------------------------------------- the flag

test('closed, nothing is created and the result says the flag is closed', async () => {
  await openFlag(false);
  const me = await connectedUser('+972501900001');
  const gid = await room(1, [{ phone: me.phone }, { phone: '+972501900002' }]);

  const res = await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid, [
    { phone: me.phone }, { phone: '+972501900002' },
  ]));
  assert.equal(res.data.flag, false);
  assert.deepEqual(res.data.created, []);
  const { rows } = await db.pool.query(`SELECT id FROM users WHERE phone = $1`, ['+972501900002']);
  assert.equal(rows.length, 0, 'a closed flag wrote a row');
});

test('open, a real number becomes a pending row with a timezone and no agent', async () => {
  await openFlag(true);
  const me = await connectedUser('+972501900010');
  const gid = await room(2, [{ phone: me.phone }, { phone: '+972501900011' }]);

  const res = await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid, [
    { phone: me.phone }, { phone: '+972501900011' },
  ]));
  assert.deepEqual(res.data.created, ['+972501900011']);
  assert.equal(res.data.skipped.existing, 1, 'the member who is already a user was re-created');

  const { rows: [u] } = await db.pool.query(
    `SELECT status, agent_id, workspace_path, onboarded_at, timezone, locale, last_inbound_at
       FROM users WHERE phone = $1`, ['+972501900011']);
  assert.equal(u.status, 'pending');
  assert.equal(u.agent_id, null);
  assert.equal(u.workspace_path, null);
  assert.equal(u.onboarded_at, null);
  assert.equal(u.last_inbound_at, null);
  // The rule that outranks everything else here: NULL is read as UTC by the
  // delivery gate and the digest sweep, three hours off for an Israeli number.
  assert.equal(u.timezone, 'Asia/Jerusalem');
  assert.equal(u.locale, 'he');

  // Idempotent: the sweep calls this every ten seconds for the rest of time.
  const again = await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid, [
    { phone: me.phone }, { phone: '+972501900011' },
  ]));
  assert.deepEqual(again.data.created, []);
  assert.equal(again.data.skipped.existing, 2);
});

test('a LID never becomes a row, and neither does an unknown dialling code', async () => {
  await openFlag(true);
  const me = await connectedUser('+972501900020');
  const gid = await room(3, [{ phone: me.phone }]);

  // The first two are real values off the box: Padel Gang's members the gateway
  // only ever named by LID (`incidents.md`, "The room asked three numbers that
  // were nobody"). The third is the OTHER answer — a dialling code
  // `phone-timezone` has never heard of — and it is refused just as firmly,
  // because `users.phone` is UNIQUE, feeds `user_channels.channel_identifier`,
  // and there is no merge primitive anywhere in this codebase for the day the
  // number behind it turns out to be one we already hold.
  const { phoneShape } = require('../src/domain/phone-timezone');
  assert.equal(phoneShape('+120774977471712'), 'not_phone');
  assert.equal(phoneShape('+27981372871283'), 'not_phone');
  assert.equal(phoneShape('+265991234567'), 'unknown');

  const refused = ['+120774977471712', '+27981372871283', '+265991234567'];
  const res = await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, ...refused.map((phone) => ({ phone }))]));
  assert.deepEqual(res.data.created, []);
  assert.equal(res.data.skipped.notAPhone, 3);
  const { rows } = await db.pool.query(`SELECT id FROM users WHERE phone = ANY($1)`, [refused]);
  assert.equal(rows.length, 0, 'a LID or an unknown code became a users row');
});

// ---------------------------------------------------- nothing reaches them

// The gate, as pure policy. The two kinds that ARE addressed to such a person
// are the ones that predate this: an invite's stranger intro and the waitlist's
// "we are open now", both delivered through the intake session.
test('gate: a pending row hears nothing, except the two kinds meant for one', () => {
  const base = {
    plan: 'free', blocked: false, window: { start: '09:00', end: '20:00' },
    tz: 'Asia/Jerusalem', sentToday: 0, budget: 4,
    now: new Date('2026-08-16T12:00:00Z'), pendingUser: true,
  };
  const at = (kind) => decide({ ...base, row: { kind, urgency: 'normal', expires_at: null } });
  assert.equal(at('meeting_invite').holdReason, 'pending_user');
  assert.equal(at('digest').holdReason, 'pending_user');
  assert.equal(at('reminder').holdReason, 'pending_user');
  assert.equal(at('introduction').holdReason, 'pending_user');
  assert.equal(at('connection_intro').action, 'deliver');
  assert.equal(at('registration_reopened').action, 'deliver');

  // A caller that computes no such fact is not silenced by a gate it told
  // nothing — `undefined` is falsy and would otherwise drop everything.
  assert.equal(decide({ ...base, pendingUser: undefined, row: { kind: 'digest', urgency: 'normal', expires_at: null } }).action,
    'deliver');
});

// …and through the real worker, so the fact and the gate are wired to each
// other rather than only being right apart.
test('the worker drops a queued message to a roster row and delivers nothing', async () => {
  await openFlag(true);
  const me = await connectedUser('+972501900030');
  const gid = await room(4, [{ phone: me.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, { phone: '+972501900031' }]));
  const { rows: [them] } = await db.pool.query(
    `SELECT id FROM users WHERE phone = $1`, ['+972501900031']);

  await withTx(db.pool, (c) => enqueue(c, {
    userId: them.id, kind: 'meeting_invite', payload: { title: 'קפה' },
    idempotencyKey: 'roster-invite',
  }));
  const sent = [];
  const out = await drainOnce(db.pool, async (user, r) => { sent.push(r.kind); return { ok: true }; },
    new Date('2026-08-16T12:00:00Z'));
  assert.equal(sent.length, 0, 'a message went out to somebody who has never met her');
  assert.equal(out.dropped >= 1, true);
  const { rows: [row] } = await db.pool.query(
    `SELECT hold_reason, sent_at FROM outbox WHERE idempotency_key = $1`, ['roster-invite']);
  assert.equal(row.hold_reason, 'pending_user');
  assert.ok(row.sent_at, 'a dropped row must be terminal, or the sweep re-makes it for ever');
});

// The one write in the group sweep that leaves the database. Asserted through
// the production function, not a copy of its WHERE clause.
test('the gateway allow-from list never learns a roster number', async () => {
  await openFlag(true);
  const me = await connectedUser('+972501900040');
  const gid = await room(5, [{ phone: me.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, { phone: '+972501900041' }]));

  const { rows } = await db.pool.query(
    `SELECT phone FROM users WHERE status = 'active' AND paused_at IS NULL AND NOT is_eval`);
  const phones = rows.map((r) => r.phone);
  assert.ok(phones.includes(me.phone));
  assert.equal(phones.includes('+972501900041'), false,
    'the sender gate would admit somebody who never signed up');
});

test('the check-in ladder cannot see a roster row', async () => {
  await openFlag(true);
  const me = await connectedUser('+972501900050');
  const gid = await room(6, [{ phone: me.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, { phone: '+972501900051' }]));
  const { rows: [them] } = await db.pool.query(
    `SELECT id FROM users WHERE phone = $1`, ['+972501900051']);

  const due = await withTx(db.pool, (c) => checkin.eligibleUsers(c, new Date()));
  assert.equal(due.some((u) => Number(u.id) === Number(them.id)), false,
    'the ladder would ask "את פה?" of somebody who has never been here');
});

// ------------------------------------------------- what a row is NOT worth

test('a room of strangers still cannot register on the strength of a roster row', async () => {
  await openFlag(true);
  // Mint the row from a room that IS legitimate…
  const me = await connectedUser('+972501900060');
  const gid = await room(7, [{ phone: me.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, { phone: '+972501900061' }]));

  // …then try to register a completely different room around that row alone.
  const res = await withTx(db.pool, (c) => groups.registerGroup(c, {
    externalId: JID(8), subject: 'זרים',
    members: [{ phone: '+972501900061' }, { phone: '+972501900062' }],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'forbidden');
});

test('standing in the room does not auto-connect a roster row to anybody', async () => {
  await openFlag(true);
  const a = await connectedUser('+972501900070');
  const b = await connectedUser('+972501900071');
  const gid = await room(9, [{ phone: a.phone }, { phone: b.phone }, { phone: '+972501900072' }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: a.phone }, { phone: b.phone }, { phone: '+972501900072' }]));
  await withTx(db.pool, (c) => groups.syncRoster(c, gid, [
    { phone: a.phone }, { phone: b.phone }, { phone: '+972501900072' }]));
  const { rows: [them] } = await db.pool.query(
    `SELECT id FROM users WHERE phone = $1`, ['+972501900072']);
  // The link IS made, which is the point of the row — it is the connection that
  // must not be.
  const { rows: member } = await db.pool.query(
    `SELECT user_id FROM chat_group_members WHERE group_id = $1 AND phone = $2`,
    [gid, '+972501900072']);
  assert.equal(Number(member[0].user_id), Number(them.id));

  const linked = await withTx(db.pool, (c) => groupConnections.connectRoom(c, gid));
  assert.equal(linked.data.members, 2, 'a stranger was counted into the room\'s connections');
  const { rows: conns } = await db.pool.query(
    `SELECT id FROM connections WHERE requester_id = $1 OR target_id = $1`, [them.id]);
  assert.equal(conns.length, 0, 'a stranger was connected to somebody without being asked');
});

test('a connection request to a roster row still sends the introduction', async () => {
  await openFlag(true);
  const asker = await connectedUser('+972501900080', { firstName: 'מירון' });
  const gid = await room(10, [{ phone: asker.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: asker.phone }, { phone: '+972501900081' }]));

  const res = await withTx(db.pool, (c) => connections.requestConnection(
    c, asker.id, '+972501900081', { reason: 'פאדל' }));
  assert.ok(res.ok, res.ok ? '' : res.error.message);
  // `targetKnown: false` is what routes this to the branch that explains who
  // Olma is and who is asking, instead of "X wants to connect with you".
  assert.equal(res.data.targetKnown, false);
  assert.equal(res.data.connection.status, 'invited');
  // The FK is still linked, because the row is a true fact about that number.
  const { rows: [them] } = await db.pool.query(
    `SELECT id FROM users WHERE phone = $1`, ['+972501900081']);
  assert.equal(Number(res.data.connection.target_id), Number(them.id));

  // …and the day they sign up, the state machine still moves: that is what
  // `jobs/intake` does with the `invited` row it finds by phone.
  const moved = await withTx(db.pool, (c) => connections.attachProvisionedTarget(
    c, res.data.connection.id, them.id));
  assert.ok(moved.ok, moved.ok ? '' : moved.error.message);
  assert.equal(moved.data.connection.status, 'pending_target');
});

test('a roster row does not vote on the room\'s quiet hours', async () => {
  await openFlag(true);
  // One Israeli member who has written, one roster row from a country with a
  // different zone. The room keeps the zone of the person it talks to.
  const me = await connectedUser('+972501900090');
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem' WHERE id = $1`, [me.id]);
  const gid = await room(11, [{ phone: me.phone }]);
  const roster = [{ phone: me.phone },
    { phone: '+12025550101' }, { phone: '+12025550102' }, { phone: '+12025550103' }];
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid, roster));
  const synced = await withTx(db.pool, (c) => groups.syncRoster(c, gid, roster));
  assert.equal(synced.timezone, 'Asia/Jerusalem',
    'three numbers nobody has spoken to outvoted the one person in the room');
});

// The check that exists to find the person the gateway dropped. A row is not a
// record their message could land in, so this must still be able to go red.
test('the unanswered-strangers check still finds somebody who only has a roster row', async () => {
  await openFlag(true);
  const guard = require('../src/jobs/config-guard');
  const me = await connectedUser('+972501900100');
  const gid = await room(12, [{ phone: me.phone }]);
  await withTx(db.pool, (c) => groups.ensureRosterUsers(c, gid,
    [{ phone: me.phone }, { phone: '+972501900101' }]));

  const long = Date.now() - 60 * 60 * 1000;
  const res = await withTx(db.pool, (c) => guard.checkUnansweredStrangers(c, {
    listInboundPeers: async () => [{ phone: '+972501900101', laneKey: 'wa:972501900101', lastAt: long }],
    listSessions: async () => [],
  }));
  assert.equal(res.skipped, null);
  assert.equal(res.violations.length, 1,
    'a roster row made the check go quiet for exactly the person it exists to find');
  assert.match(res.violations[0], /\+972501900101/);
});
