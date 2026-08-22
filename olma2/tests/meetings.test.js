'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');

// Every proposal now carries the machine half of its slot. Tests that only
// care about negotiation state use a time comfortably in the future, so the
// slot never expires mid-test.
const soon = (hours = 48) =>
  new Date(Date.now() + hours * 3600_000).toISOString().replace(/\.\d+Z$/, '+00:00');

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

    await meetings.proposeSlot(c, alice.id, m.id, 'Tuesday 17:00, video call', soon());
    // alice (proposer) is confirmed_current; bob accepts — still not confirmed
    let r = await meetings.respondToSlot(c, bob.id, m.id, true);
    assert.equal(r.data.meetingStatus, 'negotiating');

    // carol declines with a counter → new slot, everyone else resets to awaiting
    r = await meetings.respondToSlot(c, carol.id, m.id, false, 'Wednesday 18:00, phone', soon(72));
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
    await meetings.proposeSlot(c, alice.id, m.id, 'Sunday 10:00, office', soon());

    const initiatorExit = await meetings.optOut(c, alice.id, m.id);
    assert.equal(initiatorExit.ok, false); // must cancel instead

    const r = await meetings.optOut(c, bob.id, m.id);
    assert.equal(r.data.meetingStatus, 'no_match'); // alice alone cannot confirm
  });
});

test('opt-out of a third participant can complete the confirmation gate', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'trio2', [bob.id, carol.id])).data.meeting;
    await meetings.proposeSlot(c, alice.id, m.id, 'Monday 09:00, zoom', soon());
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
    const late = await meetings.proposeSlot(c, alice.id, m.id, 'whenever', soon());
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
    await meetings.proposeSlot(c, alice.id, m.id, 'Thursday 18:00, cafe', soon());
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

// ---- the Saturday poker nudge ----------------------------------------------
//
// A real one. A slot was proposed for Friday 20:00, nobody answered, and on
// Saturday morning the check-in ladder asked whether it worked. Three things
// were wrong at once: a slot had no machine-readable time, so nothing could
// ask whether it had passed; nothing ever closed a negotiation; and the nudge
// query tested only `proposed_slot IS NOT NULL`. Since stuck_meeting is the
// ladder's TOP rung, that dead meeting also shadowed every other check-in.

async function pair(phoneA, phoneB) {
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const a = await makeUser(db.pool, phoneA, { firstName: 'A' });
  const b = await makeUser(db.pool, phoneB, { firstName: 'B' });
  await withClient(async (c) => {
    const req = await connections.requestConnection(c, a.id, b.phone, {});
    const conn = (await connections.respondToConnection(c, b.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, a.id, conn.id, 'meetings');
    await grants.grantFeature(c, b.id, conn.id, 'meetings');
  });
  return { a, b };
}

test('a slot must carry a real time, and it cannot already be in the past', async () => {
  const { a, b } = await pair('+972571000001', '+972571000002');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;

    const noTime = await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00');
    assert.equal(noTime.ok, false);
    assert.equal(noTime.error.reason, 'missing_offset');

    const bare = await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', '2026-08-21T20:00');
    assert.equal(bare.ok, false, 'a bare local time is refused, never guessed at');
    assert.equal(bare.error.reason, 'missing_offset');

    const past = await meetings.proposeSlot(c, a.id, m.id, 'אתמול', '2020-01-01T20:00:00+03:00');
    assert.equal(past.ok, false, 'caught before it reaches anyone else\'s phone');
    assert.equal(past.error.reason, 'slot_in_past');

    const good = await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00 אצל דני', soon());
    assert.equal(good.ok, true);
    const { rows } = await c.query(`SELECT proposed_start_at FROM meetings WHERE id = $1`, [m.id]);
    assert.ok(rows[0].proposed_start_at, 'the machine half is stored alongside the text');
  });
});

test('a slot that has passed stops being something to nudge about', async () => {
  const { a, b } = await pair('+972571000003', '+972571000004');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', soon());

    assert.equal(Number((await meetings.pendingMeetingFor(c, b.id)).data.pending.id), Number(m.id),
      'while it is still ahead, the nudge is right');

    // Friday came and went; nobody answered.
    await c.query(`UPDATE meetings SET proposed_start_at = now() - interval '13 hours' WHERE id = $1`, [m.id]);
    assert.equal((await meetings.pendingMeetingFor(c, b.id)).data.pending, null,
      'Saturday morning: there is nothing left to agree to');
  });
});

test('a legacy slot with no start time is never nudged about — it cannot be dated', async () => {
  const { a, b } = await pair('+972571000005', '+972571000006');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', soon());
    // exactly the shape of every row proposed before this migration
    await c.query(`UPDATE meetings SET proposed_start_at = NULL WHERE id = $1`, [m.id]);

    assert.equal((await meetings.pendingMeetingFor(c, b.id)).data.pending, null,
      'the system cannot tell whether it passed, so it must not ask');
  });
});

test('expireStaleMeetings closes what nothing else ever closed', async () => {
  const { a, b } = await pair('+972571000007', '+972571000008');
  const { a: c2, b: d2 } = await pair('+972571000009', '+972571000010');
  await withClient(async (c) => {
    // passed its moment, still open
    const dead = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, dead.id, 'שישי 20:00', soon());
    await c.query(`UPDATE meetings SET proposed_start_at = now() - interval '13 hours' WHERE id = $1`, [dead.id]);

    // still ahead — must be left alone
    const live = (await meetings.startMeeting(c, c2.id, 'קפה', [d2.id])).data.meeting;
    await meetings.proposeSlot(c, c2.id, live.id, 'מחר 10:00', soon());

    const closed = await meetings.expireStaleMeetings(c);
    const ids = closed.map((m) => Number(m.id));
    assert.ok(ids.includes(Number(dead.id)), 'the moment passed with nobody agreeing');
    assert.ok(!ids.includes(Number(live.id)), 'a future slot is not stale');

    const { rows } = await c.query(`SELECT status, closed_at FROM meetings WHERE id = $1`, [dead.id]);
    assert.equal(rows[0].status, 'expired', 'expired, not no_match — nobody disagreed');
    assert.ok(rows[0].closed_at);

    // and it is idempotent: a second sweep has nothing left to close
    assert.equal((await meetings.expireStaleMeetings(c)).map((m) => Number(m.id)).includes(Number(dead.id)), false);
  });
});

test('a slot within the grace window is not closed out from under the people at it', async () => {
  const { a, b } = await pair('+972571000011', '+972571000012');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'הערב 20:00', soon());
    // started two hours ago — it may well still be happening
    await c.query(`UPDATE meetings SET proposed_start_at = now() - interval '2 hours' WHERE id = $1`, [m.id]);
    const closed = await meetings.expireStaleMeetings(c);
    assert.ok(!closed.map((x) => Number(x.id)).includes(Number(m.id)),
      'closing a meeting early is worse than closing it late');
  });
});

test('legacy rows are closed on abandonment rather than left negotiating forever', async () => {
  const { a, b } = await pair('+972571000013', '+972571000014');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'שישי 20:00', soon());
    await c.query(
      `UPDATE meetings SET proposed_start_at = NULL, updated_at = now() - interval '5 days' WHERE id = $1`,
      [m.id]);
    const closed = await meetings.expireStaleMeetings(c);
    assert.ok(closed.map((x) => Number(x.id)).includes(Number(m.id)));
  });
});

test('expireOne closes a single dead negotiation and refuses anything else', async () => {
  const { a, b } = await pair('+972571000015', '+972571000016');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', soon());
    // the shape of the live row: no start time, so no sweep can date it
    await c.query(`UPDATE meetings SET proposed_start_at = NULL WHERE id = $1`, [m.id]);

    const listed = await meetings.listNegotiating(c, b.id);
    assert.equal(listed.data.meetings.length, 1, 'the operator can see what to close');
    assert.equal(listed.data.meetings[0].proposed_start_at, null);
    assert.match(listed.data.meetings[0].participants, /\[awaiting\]/,
      'the listing carries who is stuck, so the operator never needs to already know');

    // and with no user at all — finding the dead meeting must not require
    // already knowing whose phone number it is
    const everyone = await meetings.listNegotiating(c);
    assert.ok(everyone.data.meetings.some((x) => Number(x.id) === Number(m.id)));

    const closed = await meetings.expireOne(c, m.id);
    assert.equal(closed.ok, true);
    assert.equal(Number(closed.data.meeting.initiator_id), Number(a.id),
      'the initiator is who gets told');

    const { rows } = await c.query(`SELECT status FROM meetings WHERE id = $1`, [m.id]);
    assert.equal(rows[0].status, 'expired');
    assert.equal((await meetings.listNegotiating(c, b.id)).data.meetings.length, 0);

    // closing it twice is a clean refusal, not a second close
    assert.equal((await meetings.expireOne(c, m.id)).error.code, 'not_found');

    const { rows: log } = await c.query(
      `SELECT event FROM audit_log WHERE event = 'admin.meeting.expired' AND actor_id = $1`, [a.id]);
    assert.equal(log.length, 1, 'an operator close is on the record like any other admin edit');
  });
});
