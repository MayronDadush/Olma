'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');

let db, alice, bob, carol;
before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972531000001', { firstName: 'Alice' });
  bob = await makeUser(db.pool, '+972531000002', { firstName: 'Bob' });
  carol = await makeUser(db.pool, '+972531000003', { firstName: 'Carol' });
  // full meetings mesh
  const c = await db.pool.connect();
  try {
    for (const [x, y] of [[alice, bob], [alice, carol], [bob, carol]]) {
      const req = await connections.requestConnection(c, x.id, y.phone, {});
      const conn = (await connections.respondToConnection(c, y.id, req.data.connection.id, 'approve')).data.connection;
      await grants.grantFeature(c, x.id, conn.id, 'meetings');
      await grants.grantFeature(c, y.id, conn.id, 'meetings');
    }
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('meetings gate on the meetings grant, per participant', async () => {
  const dave = await makeUser(db.pool, '+972531000004', { firstName: 'Dave' });
  await withClient(async (c) => {
    const res = await meetings.startMeeting(c, alice.id, 'x', [dave.id]);
    assert.equal(res.ok, false);
    assert.equal(res.error.reason, 'not_connected');
    assert.equal(res.error.participantId, dave.id);
  });
});

test('confirm requires EVERY active participant on the identical slot', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'trio', [bob.id, carol.id])).data.meeting;

    await meetings.proposeSlot(c, alice.id, m.id, 'Tuesday 17:00, video call');
    // alice (proposer) is confirmed_current; bob accepts — still not confirmed
    let r = await meetings.respondToSlot(c, bob.id, m.id, true);
    assert.equal(r.data.meetingStatus, 'negotiating');

    // carol declines with a counter → new slot, everyone else resets to awaiting
    r = await meetings.respondToSlot(c, carol.id, m.id, false, 'Wednesday 18:00, phone');
    assert.equal(r.ok, true);
    const st = await meetings.getStatus(c, alice.id, m.id);
    assert.equal(st.data.meeting.proposed_slot, 'Wednesday 18:00, phone');
    const states = Object.fromEntries(st.data.participants.map((p) => [p.user_id, p.state]));
    assert.equal(states[carol.id], 'confirmed_current'); // counter-proposer agrees to her own slot
    assert.equal(states[alice.id], 'awaiting');
    assert.equal(states[bob.id], 'awaiting');

    // both remaining accept → NOW it confirms, to the exact slot
    await meetings.respondToSlot(c, alice.id, m.id, true);
    r = await meetings.respondToSlot(c, bob.id, m.id, true);
    assert.equal(r.data.meetingStatus, 'confirmed');
    const done = await meetings.getStatus(c, alice.id, m.id);
    assert.equal(done.data.meeting.status, 'confirmed');
    assert.equal(done.data.meeting.confirmed_slot, 'Wednesday 18:00, phone');
  });
});

test('a meeting of one cannot confirm; initiator cannot opt out; opt-out can close no_match', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'duo', [bob.id])).data.meeting;
    await meetings.proposeSlot(c, alice.id, m.id, 'Sunday 10:00, office');

    const initiatorExit = await meetings.optOut(c, alice.id, m.id);
    assert.equal(initiatorExit.ok, false); // must cancel instead

    const r = await meetings.optOut(c, bob.id, m.id);
    assert.equal(r.data.meetingStatus, 'no_match'); // alice alone cannot confirm
  });
});

test('opt-out of a third participant can complete the confirmation gate', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'trio2', [bob.id, carol.id])).data.meeting;
    await meetings.proposeSlot(c, alice.id, m.id, 'Monday 09:00, zoom');
    await meetings.respondToSlot(c, bob.id, m.id, true);
    // carol is the lone holdout; her opting out leaves alice+bob who both agreed
    const r = await meetings.optOut(c, carol.id, m.id);
    assert.equal(r.data.meetingStatus, 'confirmed');
  });
});

test('cancel is initiator-only; closed meetings reject all moves', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'to-cancel', [bob.id])).data.meeting;
    const notInitiator = await meetings.cancelMeeting(c, bob.id, m.id);
    assert.equal(notInitiator.ok, false);
    const cancelled = await meetings.cancelMeeting(c, alice.id, m.id);
    assert.equal(cancelled.ok, true);
    const late = await meetings.proposeSlot(c, alice.id, m.id, 'whenever');
    assert.equal(late.ok, false);
  });
});

test('constraints accumulate; pendingMeetingFor feeds the checkin ladder', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'ladder', [bob.id])).data.meeting;
    await meetings.recordConstraint(c, bob.id, m.id, 'not Fridays');
    await meetings.recordConstraint(c, bob.id, m.id, 'after 17:00 only');
    const st = await meetings.getStatus(c, bob.id, m.id);
    const bobRow = st.data.participants.find((p) => p.user_id === bob.id);
    assert.deepEqual(bobRow.constraints, ['not Fridays', 'after 17:00 only']);

    // no slot proposed yet → bob is awaiting but NOT nudge-worthy
    let pend = await meetings.pendingMeetingFor(c, bob.id);
    assert.equal(pend.data.pending, null);
    await meetings.proposeSlot(c, alice.id, m.id, 'Thursday 18:00, cafe');
    pend = await meetings.pendingMeetingFor(c, bob.id);
    assert.equal(pend.data.pending.id, m.id);
  });
});

test('non-participant cannot see or touch a meeting', async () => {
  const eve = await makeUser(db.pool, '+972531000005', { firstName: 'Eve' });
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'private', [bob.id])).data.meeting;
    for (const fn of [
      () => meetings.getStatus(c, eve.id, m.id),
      () => meetings.respondToSlot(c, eve.id, m.id, true),
      () => meetings.recordConstraint(c, eve.id, m.id, 'x'),
      () => meetings.optOut(c, eve.id, m.id),
    ]) {
      const r = await fn();
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'not_found');
    }
  });
});
