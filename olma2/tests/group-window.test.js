'use strict';
// The room is the conversation too (owner's rule, 2026-09-08).
//
// The founding case is the first real group coordination. מירון asked her, in
// the room, to arrange something for the three of them; she said in the room
// that she was asking everyone privately; and the private invites reached
// nobody. עמית's was dropped as `quiet` — the check-in ladder had asked him
// something days earlier and got no answer — and מירון's was held as `night`.
// Both of them were writing in that room at the time.
//
// So a message in the room opens the same fifteen-minute window a DM opens,
// for the coordination that room is running and for nothing else. What the
// window does NOT do is reopen the person: their ladder, their reminders and
// their pause stand exactly where they stood.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide, CONVERSATION_GRACE_MS, weekdayInTz } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const groups = require('../src/domain/groups');
const groupContext = require('../src/domain/group-context');
const meetings = require('../src/domain/meetings');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const HOUR = 3600_000;
const NOW = new Date('2026-09-08T09:00:00Z'); // 12:00 in Jerusalem: daytime, so the night rule is beside the point
const base = {
  plan: 'free', blocked: false, window: { start: '09:00', end: '21:00' }, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: NOW,
};
const invite = { kind: 'meeting_invite', urgency: 'normal', payload: { meetingId: 18 } };
const justWrote = new Date(NOW.getTime() - 60_000);

test('gate: somebody who spoke in the room hears about that room\'s coordination', () => {
  // עמית, exactly as he was that evening.
  const quiet = { ...base, checkinMisses: 1, row: invite };
  assert.equal(decide(quiet).holdReason, 'quiet', 'the founding failure, still true when he is silent');
  assert.equal(decide({ ...quiet, groupWroteAt: justWrote }).action, 'deliver');

  // מירון: 02:00 local, and the room is awake.
  const night = { ...base, now: new Date('2026-09-07T23:00:00Z'), row: invite };
  assert.equal(decide(night).holdReason, 'night');
  assert.equal(decide({
    ...night, groupWroteAt: new Date(night.now.getTime() - 60_000),
  }).action, 'deliver');
});

test('gate: the window is fifteen minutes and it is about the room, not the person', () => {
  const quiet = { ...base, checkinMisses: 1, row: invite };
  const late = new Date(NOW.getTime() - CONVERSATION_GRACE_MS - 1000);
  assert.equal(decide({ ...quiet, groupWroteAt: late }).holdReason, 'quiet',
    'sixteen minutes ago is not mid-conversation');

  // The fact reaches the gate ONLY on a row about that coordination — the
  // worker is what decides that, and it is the whole scoping. But even if a
  // future caller passed it wrongly, nothing that is about the PERSON may ride
  // on it: their ladder is still theirs.
  assert.equal(decide({
    ...base, checkinMisses: 1, groupWroteAt: justWrote,
    row: { kind: 'reminder', urgency: 'normal', payload: { rung: 2, auto: true } },
  }).action, 'deliver', 'the gate cannot tell the kinds apart — see the worker test below');
});

test('gate: a pause is still a pause, and is read before any of this', () => {
  assert.equal(decide({
    ...base, paused: true, checkinMisses: 1, groupWroteAt: justWrote, row: invite,
  }).holdReason, 'paused');
  assert.equal(decide({
    ...base, evalUser: true, groupWroteAt: justWrote, row: invite,
  }).holdReason, 'eval_user');
});

// Owner, 2026-09-12: somebody who wrote in the room since the coordination
// started is available and probably interested, so a meeting row is the one
// kind that should not wait for their quiet day to end — the opposite of the
// rule one test up ("gate: a quiet day holds everything Olma decided to
// say"), which still stands for a digest, an automatic reminder, or anything
// else that never carries a meetingId and so can never earn groupWroteAt.
test('gate: a quiet day still holds a meeting row, unless the room heard from them', () => {
  const saturdayNoon = new Date('2026-08-15T09:00:00Z'); // noon in Jerusalem
  const sat = weekdayInTz(base.tz, saturdayNoon);
  const shabbat = { ...base, now: saturdayNoon, quietDays: [sat], row: invite };

  assert.equal(decide(shabbat).holdReason, 'quiet_day', 'the day off still applies by default');
  assert.equal(
    decide({ ...shabbat, groupWroteAt: new Date(saturdayNoon.getTime() - 60_000) }).action,
    'deliver', 'but not to somebody the room just heard from');

  // Sixteen minutes ago is not mid-conversation for the day rule either —
  // same window as the night rule, same reason.
  const late = new Date(saturdayNoon.getTime() - CONVERSATION_GRACE_MS - 1000);
  assert.equal(decide({ ...shabbat, groupWroteAt: late }).holdReason, 'quiet_day');
});

// ---------------- the stamp -------------------------------------------------

async function room(client, { jid, members }) {
  const reg = await groups.registerGroup(client, { externalId: jid, members });
  assert.ok(reg.ok);
  const { rows } = await client.query(
    `UPDATE chat_groups SET state = 'open', agent_id = $2 WHERE id = $1 RETURNING *`,
    [reg.data.group.id, `g-${reg.data.group.id}`]);
  return rows[0];
}

test('a member who wrote is stamped, and a stranger who wrote is not', async () => {
  const amit = await makeUser(db.pool, '+972606000001');
  const g = await withTx(db.pool, (c) => room(c, {
    jid: '120363000000001@g.us', members: [{ phone: amit.phone }],
  }));

  const wrote = await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: `whatsapp:${g.external_id}`, senderE164: amit.phone, at: justWrote,
  }));
  assert.equal(wrote, true);
  const stamp = async () => (await db.pool.query(
    `SELECT last_wrote_at FROM chat_group_members WHERE group_id = $1 AND phone = $2`,
    [g.id, amit.phone])).rows[0].last_wrote_at;
  assert.equal(new Date(await stamp()).getTime(), justWrote.getTime());

  // A number that is not in this room stamps nothing at all — including hers.
  assert.equal(await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: g.external_id, senderE164: '+972559347282', at: NOW,
  })), false);
  assert.equal(await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: g.external_id, senderE164: 'not a number', at: NOW,
  })), false);

  // A turn that arrives late must not move the window backwards.
  await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: g.external_id, senderE164: amit.phone, at: new Date(NOW.getTime() - HOUR),
  }));
  assert.equal(new Date(await stamp()).getTime(), justWrote.getTime(), 'the newest write wins');
});

// ---------------- end to end ------------------------------------------------

test('the invite reaches the man who was talking in the room, and nothing else does', async () => {
  const miron = await makeUser(db.pool, '+972606000010');
  const amit = await makeUser(db.pool, '+972606000011');
  for (const u of [miron, amit]) {
    await db.pool.query(
      `UPDATE users SET timezone = 'Asia/Jerusalem', checkin_misses = 1 WHERE id = $1`, [u.id]);
  }
  const g = await withTx(db.pool, (c) => room(c, {
    jid: '120363000000002@g.us', members: [{ phone: miron.phone }, { phone: amit.phone }],
  }));

  const started = await withTx(db.pool, (c) => meetings.startMeeting(
    c, miron.id, 'פאדל', [amit.id], { groupId: g.id }));
  assert.ok(started.ok, 'the coordination started');
  const meetingId = Number(started.data.meeting.id);

  // Both are owed an invite; the room is what they have been answering in.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: amit.id, kind: 'meeting_invite', payload: { meetingId, title: 'פאדל' },
    idempotencyKey: `minvite:${meetingId}:${amit.id}`,
  }));
  // And something that is NOT about this room at all, for the same man.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: amit.id, kind: 'connection_request', payload: { from: 'someone' },
    idempotencyKey: `conn:${amit.id}`,
  }));

  const sent = [];
  const send = async (row) => { sent.push(row); return { ok: true }; };

  // Nobody has said anything in the room yet: the ladder holds both.
  await drainOnce(db.pool, send);
  assert.deepEqual(sent, []);
  const held = async (kind) => (await db.pool.query(
    `SELECT hold_reason, sent_at FROM outbox WHERE user_id = $1 AND kind = $2`,
    [amit.id, kind])).rows[0];
  assert.equal((await held('meeting_invite')).hold_reason, 'quiet');

  // A row the gate DROPPED is terminal, so the founding case needs the state
  // it was actually in: the invite still owed, and then he speaks.
  await db.pool.query(
    `UPDATE outbox SET sent_at = NULL, hold_reason = NULL WHERE user_id = $1`, [amit.id]);
  await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: g.external_id, senderE164: amit.phone, at: new Date(),
  }));

  await drainOnce(db.pool, send);
  assert.equal(sent.length, 1, 'the coordination, and only the coordination');
  assert.equal(sent[0].kind, 'meeting_invite');
  assert.equal((await held('connection_request')).hold_reason, 'quiet',
    'somebody else\'s request is not what he answered');
});

test('a word said before the coordination started does not open a window on it', async () => {
  const dana = await makeUser(db.pool, '+972606000020');
  const yael = await makeUser(db.pool, '+972606000021');
  await db.pool.query(`UPDATE users SET checkin_misses = 1 WHERE id = $1`, [yael.id]);
  const g = await withTx(db.pool, (c) => room(c, {
    jid: '120363000000003@g.us', members: [{ phone: dana.phone }, { phone: yael.phone }],
  }));

  // She spoke in the room, and only afterwards did anybody start arranging
  // anything. Her "🙌" an hour ago is not an answer to a question nobody had
  // asked yet — the owner's wording is "after the coordination started".
  await withTx(db.pool, (c) => groupContext.noteMemberWrote(c, {
    chatId: g.external_id, senderE164: yael.phone, at: new Date(Date.now() - 60_000),
  }));
  const started = await withTx(db.pool, (c) => meetings.startMeeting(
    c, dana.id, 'קפה', [yael.id], { groupId: g.id }));
  const meetingId = Number(started.data.meeting.id);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: yael.id, kind: 'meeting_invite', payload: { meetingId, title: 'קפה' },
    idempotencyKey: `minvite:${meetingId}:${yael.id}`,
  }));

  const sent = [];
  await drainOnce(db.pool, async (row) => { sent.push(row); return { ok: true }; });
  assert.deepEqual(sent, []);
});
