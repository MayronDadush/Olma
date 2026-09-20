'use strict';
// The session remembers the question it asked and nothing tells it the
// answer arrived. Kapish was asked about a Saturday slot at 11:11, answered
// from the page at 12:31, the meeting closed on Thursday at 13:30, and at
// 13:51 his "?" got the Saturday slot again, from memory; Miron said "סימנתי"
// and was asked "מה נוח לך?" (2026-09-20). turn_start now carries where every
// coordination they heard about in the last day stands NOW.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const connections = require('../src/domain/connections');
const { enqueue } = require('../src/outbox/enqueue');

let db, broker, ann, ben;
before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool });
  ann = await makeUser(db.pool, '+972509100001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972509100002', { firstName: 'Ben' });
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, ann.id, ben.phone, {});
    // Approval auto-grants every feature for both sides.
    await connections.respondToConnection(c, ben.id, req.data.connection.id, 'approve');
  });
});
after(async () => { if (db) await db.teardown(); });

async function turnStart(user) {
  const res = await broker.dispatch(
    { id: 1, method: 'tool_call', params: { name: 'turn_start', args: { olma_identity: user.identity_token } } },
    { opened: false, counted: false });
  assert.equal(res.ok, true, res.text);
  return JSON.parse(res.text.replace(/^OK /, ''));
}

test('a coordination they heard about carries its status, their answers, and the closed slot', async () => {
  const none = await turnStart(ben);
  assert.equal(none.recentMeetings, undefined, 'nothing heard, nothing said');

  const m = (await withTx(db.pool, (c) => meetings.startMeeting(c, ann.id, 'פוקר', [ben.id]))).data.meeting;
  const when = slotStart('בערב', { hours: 72 });
  const optionId = (await withTx(db.pool, (c) => options.add(c, ann.id, m.id, 'בערב אצל יוסי', when))).data.option.id;
  // A message about it REACHED Ben (a dropped one would not count).
  await withTx(db.pool, (c) => enqueue(c, { userId: ben.id, kind: 'meeting_invite', payload: { meetingId: Number(m.id) }, urgency: 'urgent' }));
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '5 minutes' WHERE user_id = $1 AND kind = 'meeting_invite'`, [ben.id]);

  const heard = await turnStart(ben);
  assert.equal(heard.recentMeetings.length, 1);
  const [rm] = heard.recentMeetings;
  assert.equal(rm.meetingId, Number(m.id));
  assert.equal(rm.title, '<<<פוקר>>>', 'another person\'s text, fenced');
  assert.equal(rm.status, 'negotiating');
  assert.deepEqual([rm.onTable, rm.answered, rm.answeredAt], [1, 0, undefined]);
  assert.match(heard.hints.recentMeetings, /never re-offer a time from it/);

  // He answers from the page: the turn says so, with when.
  await withTx(db.pool, (c) => options.answer(c, ben.id, m.id, optionId, 'y'));
  const answered = await turnStart(ben);
  assert.equal(answered.recentMeetings[0].answered, 1);
  assert.ok(answered.recentMeetings[0].answeredAt);

  // Unanimous → the minute → closed: the turn carries the confirmed slot.
  await db.pool.query(`UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [m.id]);
  await withTx(db.pool, (c) => options.settleDue(c));
  const closed = await turnStart(ben);
  assert.equal(closed.recentMeetings[0].status, 'confirmed');
  assert.equal(closed.recentMeetings[0].confirmedSlot, '<<<בערב אצל יוסי>>>');

  // Ann never heard a message about it (she started it): nothing on her turn.
  const annTurn = await turnStart(ann);
  assert.equal(annTurn.recentMeetings, undefined);
});
