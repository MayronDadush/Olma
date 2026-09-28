'use strict';
// The number the room-coordination policy is held to (owner, 2026-09-28), and
// the timeline it is read from. Every moment is relative to one fixed base, so
// nothing depends on the hour the suite runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { scoreCoordination, touchEffects } = require('../src/domain/coordination-score');

const H = 3600_000;
const T0 = Date.UTC(2030, 0, 6, 9, 0, 0);
const at = (hours) => new Date(T0 + hours * H).toISOString();

// A room of four, two times on the table, a game in three days.
function room(over = {}) {
  return {
    meetingId: 1, groupId: 9, initiatorId: 1, status: 'confirmed',
    startedAt: at(0), closedAt: at(6), settledAt: at(6), settledByHand: false, undoneAt: [],
    confirmedOptionId: 11, confirmedStartAt: at(72), earliestStartAt: at(48),
    roomSize: 4, target: null, legacy: false,
    participants: [1, 2, 3, 4].map((userId) => ({ userId, state: 'awaiting' })),
    answers: [
      { optionId: 11, userId: 1, answer: 'y', at: at(0), byAdding: true },
      { optionId: 11, userId: 2, answer: 'y', at: at(1) },
      { optionId: 11, userId: 3, answer: 'y', at: at(2) },
      { optionId: 11, userId: 4, answer: 'y', at: at(5) },
    ],
    touches: [
      { at: at(0), channel: 'room', kind: 'started', userIds: [] },
      { at: at(0.5), channel: 'private', kind: 'meeting_invite', userIds: [2] },
      { at: at(4), channel: 'room', kind: 'chase', userIds: [] },
    ],
    exits: [],
    ...over,
  };
}

test('a quick, whole-room yes well before the game is a success, and the pieces say why', () => {
  const s = scoreCoordination(room());
  assert.equal(s.outcome, 'confirmed');
  assert.equal(s.success, true);
  assert.ok(s.total >= 0.9, `total ${s.total}`);
  assert.equal(s.breadth.yes, 4);
  assert.equal(s.answerRate.answered, 3, "the initiator's own proposal is not an answer to anything we did");
  assert.ok(Math.abs(s.speed.value - (1 - 6 / 72)) < 1e-9);
});

test('closing an hour before the thing is worth less than closing days before it', () => {
  const early = scoreCoordination(room());
  const late = scoreCoordination(room({ closedAt: at(71), settledAt: at(71) }));
  assert.ok(late.total < early.total);
});

test('coordination 57: a room that agreed WITHOUT tagging her is counted by the room, against the four it needed', () => {
  const tl = room({
    roomSize: 7, target: 4, settledByHand: true,
    participants: [1, 2, 3, 4, 5].map((userId) => ({ userId, state: userId === 5 ? 'opted_out' : 'awaiting' })),
    answers: [{ optionId: 11, userId: 1, answer: 'y', at: at(6), byAdding: true }],
  });
  const s = scoreCoordination(tl);
  assert.equal(s.breadth.breadthFrom, 'room_talk');
  assert.deepEqual([s.breadth.yes, s.breadth.of], [4, 4], 'the three other members are not a shortfall in a game for four');

  // The same data outside a room is ONE yes: a private hand-settle says nothing about anybody else.
  const priv = scoreCoordination({ ...tl, groupId: null });
  assert.equal(priv.breadth.yes, 1);
  // And somebody who declined that very time is never counted in by the talk.
  const declined = scoreCoordination({ ...tl, answers: [...tl.answers, { optionId: 11, userId: 2, answer: 'n', at: at(5) }] });
  assert.equal(declined.breadth.yes, 3);
});

test('an end that FOLLOWED our offer to drop it is a graceful exit and a success; a silent expiry is neither', () => {
  const touches = [...room().touches, { at: at(20), channel: 'room', kind: 'drop_offer', userIds: [] }];
  const graceful = scoreCoordination(room({ status: 'no_match', closedAt: at(24), confirmedOptionId: null, confirmedStartAt: null, touches }));
  assert.equal(graceful.outcome, 'graceful_exit');
  assert.equal(graceful.success, true);
  assert.equal(graceful.total, 0.6);

  const silent = scoreCoordination(room({ status: 'expired', closedAt: at(24), confirmedOptionId: null, confirmedStartAt: null }));
  assert.deepEqual([silent.outcome, silent.success, silent.total], ['expired', false, 0]);
  // An offer made AFTER it had already ended offered nothing.
  const tooLate = scoreCoordination(room({ status: 'expired', closedAt: at(10), confirmedOptionId: null, confirmedStartAt: null, touches }));
  assert.equal(tooLate.outcome, 'expired');
});

test('leaving within twelve hours of a touch that reached them is irritation, and costs the success', () => {
  const s = scoreCoordination(room({ exits: [{ userId: 3, at: at(8) }] }));
  assert.equal(s.irritation.length, 1);
  assert.equal(s.irritation[0].afterKind, 'chase');
  assert.equal(s.success, false);
  // A private message to somebody ELSE did not reach them, and a day later is not caused by it.
  const other = room({ touches: [{ at: at(0.5), channel: 'private', kind: 'meeting_invite', userIds: [2] }] });
  assert.equal(scoreCoordination({ ...other, exits: [{ userId: 3, at: at(1) }] }).irritation.length, 0);
  assert.equal(scoreCoordination(room({ exits: [{ userId: 3, at: at(30) }] })).irritation.length, 0);
});

test('pausing OLMA is a person lost, not irritation at this coordination — it is kept, and it does not cancel the success', () => {
  const s = scoreCoordination(room({ exits: [{ userId: 3, at: at(8), cause: 'paused_by_request' }] }));
  assert.equal(s.irritation.length, 0);
  assert.deepEqual(s.lost.map((x) => x.userId), [3]);
  assert.equal(s.success, true);
  // Leaving the coordination itself, the same hours later, is still irritation.
  assert.equal(scoreCoordination(room({ exits: [{ userId: 3, at: at(8), cause: 'user_choice' }] })).irritation.length, 1);
});

test('a settle undone within a day was not a settle', () => {
  const s = scoreCoordination(room({ undoneAt: [at(10)] }));
  assert.equal(s.unstable, true);
  assert.equal(s.success, false);
});

test('an open coordination has no score yet — not a zero', () => {
  const s = scoreCoordination(room({ status: 'negotiating', closedAt: null }));
  assert.deepEqual([s.outcome, s.total, s.success], ['open', null, false]);
});

test('a touch is credited with answers inside two hours: anybody for a room line, only its addressee for a private one', () => {
  const fx = touchEffects(room());
  const [started, invite, chase] = fx;
  assert.equal(started.answeredBy, 2, 'users 2 and 3 answered within two hours of the start');
  assert.equal(invite.answeredBy, 1, 'user 3 answering is not the invite to user 2 working');
  assert.equal(chase.answeredBy, 1);
  assert.equal(chase.firstAnswerMinutes, 60);
  // The proposer's own yes, written as the time is added, moves nothing.
  const own = touchEffects(room({ answers: [{ optionId: 11, userId: 1, answer: 'y', at: at(0.1), byAdding: true }] }));
  assert.equal(own[0].answeredBy, 0);
});

// ---- the timeline, through the database ----------------------------------------

const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const fanout = require('../src/domain/meeting-fanout');
const { timelineFor, coordinationIds } = require('../src/domain/coordination-timeline');

let db, a, b;
before(async () => {
  db = await freshDb();
  a = await makeUser(db.pool, '+972535000001', { firstName: 'א' });
  b = await makeUser(db.pool, '+972535000002', { firstName: 'ב' });
  const c = await db.pool.connect();
  try {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    const conn = (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, a.id, conn.id, 'meetings');
    await grants.grantFeature(c, b.id, conn.id, 'meetings');
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

test('the timeline reads the rows the real calls leave, and only a SENT message is a touch', async () => {
  const c = await db.pool.connect();
  try {
    const m = Number((await meetings.startMeeting(c, a.id, 'קפה', [b.id])).data.meeting.id);
    const startsAt = new Date(Date.now() + 3 * 24 * H).toISOString();
    const added = await meetings.options.add(c, a.id, m, 'option 1', startsAt);
    assert.ok(added.ok, JSON.stringify(added));
    const optionId = added.data.option.id;
    await fanout.afterOptionAdded(c, a, m, added);
    await meetings.options.answer(c, b.id, m, optionId, 'y');

    let tl = await timelineFor(c, m);
    assert.equal(tl.status, 'negotiating');
    const byUser = Object.fromEntries(tl.answers.map((x) => [x.userId, x]));
    assert.equal(byUser[a.id].byAdding, true, "the proposer's yes is written as the time is added");
    assert.equal(byUser[b.id].byAdding, false);
    assert.equal(tl.touches.filter((t) => t.channel === 'private').length, 0, 'nothing has been SENT yet');

    // The worker's step: a row that went out.
    await c.query(`UPDATE outbox SET sent_at = now() WHERE (payload->>'meetingId')::bigint = $1 AND user_id = $2`, [m, b.id]);
    tl = await timelineFor(c, m);
    assert.ok(tl.touches.some((t) => t.channel === 'private' && t.userIds[0] === b.id));
    assert.equal(scoreCoordination(tl).outcome, 'open');

    assert.ok((await coordinationIds(c)).includes(m));
    assert.ok(!(await coordinationIds(c, { roomsOnly: true })).includes(m), 'a private coordination is not a room');
    assert.equal(await timelineFor(c, 999999), null);
  } finally { c.release(); }
});
