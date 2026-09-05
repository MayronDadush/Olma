'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
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

    const tue = slotStart('Tuesday 17:00, video call');
    await meetings.proposeSlot(c, alice.id, m.id, 'Tuesday 17:00, video call', tue);
    // alice (proposer) is confirmed_current; bob accepts — still not confirmed
    let r = await meetings.respondToSlot(c, bob.id, m.id, true, null, null, tue);
    assert.equal(r.data.meetingStatus, 'negotiating');

    // carol declines with a counter → new slot, everyone else resets to awaiting
    const wed = slotStart('Wednesday 18:00, phone', { hours: 72 });
    r = await meetings.respondToSlot(c, carol.id, m.id, false, 'Wednesday 18:00, phone', wed);
    assert.equal(r.ok, true);
    const st = await meetings.getStatus(c, alice.id, m.id);
    assert.equal(st.data.meeting.proposed_slot, 'Wednesday 18:00, phone');
    const states = Object.fromEntries(st.data.participants.map((p) => [p.user_id, p.state]));
    assert.equal(states[carol.id], 'confirmed_current'); // counter-proposer agrees to her own slot
    assert.equal(states[alice.id], 'awaiting');
    assert.equal(states[bob.id], 'awaiting');

    // both remaining accept → NOW it confirms, to the exact slot
    await meetings.respondToSlot(c, alice.id, m.id, true, null, null, wed);
    r = await meetings.respondToSlot(c, bob.id, m.id, true, null, null, wed);
    assert.equal(r.data.meetingStatus, 'confirmed');
    const done = await meetings.getStatus(c, alice.id, m.id);
    assert.equal(done.data.meeting.status, 'confirmed');
    assert.equal(done.data.meeting.confirmed_slot, 'Wednesday 18:00, phone');
  });
});

// A "כן" answers the slot the person was SHOWN, not whatever is current. In a
// live meeting three proposals crossed within eight seconds, and one user's
// yes to Sunday 9:00 was recorded as accepting Tuesday 10:00 — a slot whose
// notification reached him two minutes after he had "agreed" to it.
test('an accept is pinned to the slot the user saw; a stale one is refused clean', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'race', [bob.id, carol.id])).data.meeting;
    const monday = slotStart('יום שני 20:00');
    await meetings.proposeSlot(c, alice.id, m.id, 'יום שני 20:00', monday);
    const tuesday = slotStart('יום שלישי 20:00', { hours: 72 });
    await meetings.proposeSlot(c, alice.id, m.id, 'יום שלישי 20:00', tuesday);

    // bob's user said yes to Monday; the meeting has moved on
    const stale = await meetings.respondToSlot(c, bob.id, m.id, true, null, null, monday);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.reason, 'slot_changed');
    assert.ok(stale.error.message.includes('יום שלישי 20:00'), 'the refusal shows the current slot');

    // no accepted_starts_at at all is refused too — and neither refusal
    // may leave an acceptance behind
    const missing = await meetings.respondToSlot(c, bob.id, m.id, true);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.reason, 'accepted_starts_at_required');
    const st = await meetings.getStatus(c, bob.id, m.id);
    assert.equal(st.data.participants.find((p) => p.user_id === bob.id).state, 'awaiting');

    // the yes to the slot actually on the table goes through
    const good = await meetings.respondToSlot(c, bob.id, m.id, true, null, null, tuesday);
    assert.equal(good.ok, true);
    assert.equal(good.data.yourState, 'confirmed_current');
  });
});

test('accept binding: a legacy row with no machine time still accepts', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'legacy', [bob.id])).data.meeting;
    await meetings.proposeSlot(c, alice.id, m.id, 'שישי 20:00', slotStart('שישי 20:00'));
    // a row proposed before slots carried a start time cannot be validated —
    // requiring the parameter there would wedge every such negotiation
    await c.query(`UPDATE meetings SET proposed_start_at = NULL WHERE id = $1`, [m.id]);
    const r = await meetings.respondToSlot(c, bob.id, m.id, true);
    assert.equal(r.ok, true);
    assert.equal(r.data.meetingStatus, 'confirmed');
  });
});

test('a meeting of one cannot confirm; initiator cannot opt out; opt-out can close no_match', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'duo', [bob.id])).data.meeting;
    await meetings.proposeSlot(c, alice.id, m.id, 'Sunday 10:00, office', slotStart('Sunday 10:00, office'));

    const initiatorExit = await meetings.optOut(c, alice.id, m.id);
    assert.equal(initiatorExit.ok, false); // must cancel instead

    const r = await meetings.optOut(c, bob.id, m.id);
    assert.equal(r.data.meetingStatus, 'no_match'); // alice alone cannot confirm
  });
});

test('opt-out of a third participant can complete the confirmation gate', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'trio2', [bob.id, carol.id])).data.meeting;
    const mon = slotStart('Monday 09:00, zoom');
    await meetings.proposeSlot(c, alice.id, m.id, 'Monday 09:00, zoom', mon);
    await meetings.respondToSlot(c, bob.id, m.id, true, null, null, mon);
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
    const late = await meetings.proposeSlot(c, alice.id, m.id, 'whenever', slotStart('whenever'));
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
    await meetings.proposeSlot(c, alice.id, m.id, 'Thursday 18:00, cafe', slotStart('Thursday 18:00, cafe'));
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

async function pair(phoneA, phoneB, extra = {}) {
  const connections = require('../src/domain/connections');
  const grants = require('../src/domain/grants');
  const a = await makeUser(db.pool, phoneA, { firstName: 'A', ...extra });
  const b = await makeUser(db.pool, phoneB, { firstName: 'B', ...extra });
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

    const good = await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00 אצל דני', slotStart('יום שישי 20:00 אצל דני'));
    assert.equal(good.ok, true);
    const { rows } = await c.query(`SELECT proposed_start_at FROM meetings WHERE id = $1`, [m.id]);
    assert.ok(rows[0].proposed_start_at, 'the machine half is stored alongside the text');
  });
});

test('a slot that has passed stops being something to nudge about', async () => {
  const { a, b } = await pair('+972571000003', '+972571000004');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', slotStart('יום שישי 20:00'));

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
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', slotStart('יום שישי 20:00'));
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
    await meetings.proposeSlot(c, a.id, dead.id, 'שישי 20:00', slotStart('שישי 20:00'));
    await c.query(`UPDATE meetings SET proposed_start_at = now() - interval '13 hours' WHERE id = $1`, [dead.id]);

    // still ahead — must be left alone
    const live = (await meetings.startMeeting(c, c2.id, 'קפה', [d2.id])).data.meeting;
    await meetings.proposeSlot(c, c2.id, live.id, 'מחר 10:00', slotStart('מחר 10:00'));

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
    await meetings.proposeSlot(c, a.id, m.id, 'הערב 20:00', slotStart('הערב 20:00'));
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
    await meetings.proposeSlot(c, a.id, m.id, 'שישי 20:00', slotStart('שישי 20:00'));
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
    await meetings.proposeSlot(c, a.id, m.id, 'יום שישי 20:00', slotStart('יום שישי 20:00'));
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
    assert.equal(Number(closed.data.meeting.initiator_id), Number(a.id));
    // both sides come back — the one waiting for an answer is very often not
    // the one who asked the question, and they deserve to be told too.
    assert.deepEqual(closed.data.participantIds.map(Number).sort(),
      [Number(a.id), Number(b.id)].sort());

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

test('expireOne drops an opted-out participant but keeps everyone still on it', async () => {
  const { a, b } = await pair('+972571000017', '+972571000018');
  const c3 = await makeUser(db.pool, '+972571000019', { firstName: 'C' });
  await withClient(async (cl) => {
    const connections = require('../src/domain/connections');
    const grants = require('../src/domain/grants');
    const req = await connections.requestConnection(cl, a.id, c3.phone, {});
    const conn = (await connections.respondToConnection(cl, c3.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(cl, a.id, conn.id, 'meetings');
    await grants.grantFeature(cl, c3.id, conn.id, 'meetings');

    const m = (await meetings.startMeeting(cl, a.id, 'פוקר', [b.id, c3.id])).data.meeting;
    await meetings.proposeSlot(cl, a.id, m.id, 'יום שישי 20:00', slotStart('יום שישי 20:00'));
    await meetings.optOut(cl, c3.id, m.id);

    const closed = await meetings.expireOne(cl, m.id);
    assert.deepEqual(closed.data.participantIds.map(Number).sort(),
      [Number(a.id), Number(b.id)].sort(),
      'someone who already left on their own does not need to be told it ended');
  });
});

// ---- reasons ---------------------------------------------------------------
// Two people traded four dead slots for one poker game, each explaining
// themselves to their own Olma and neither hearing the other: one was "בצילומים
// ומסיים מאוחר", the other just "לא ביום שני". The reason existed in the row
// the whole time and simply never travelled.

test('a reason is shareable by default and reaches the other side', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'poker', [bob.id])).data.meeting;
    await meetings.recordConstraint(c, alice.id, m.id, 'בצילומים ומסיים מאוחר — פנוי בשלישי');

    const shared = await meetings.shareableConstraints(c, m.id, alice.id);
    assert.deepEqual(shared, ['בצילומים ומסיים מאוחר — פנוי בשלישי']);

    // and Bob sees it on the status board, because that is the point
    const st = await meetings.getStatus(c, bob.id, m.id);
    const aliceRow = st.data.participants.find((p) => p.user_id === alice.id);
    assert.deepEqual(aliceRow.constraints, ['בצילומים ומסיים מאוחר — פנוי בשלישי']);
  });
});

test('private is honoured on the way OUT, not just on the way in', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'private reason', [bob.id])).data.meeting;
    await meetings.recordConstraint(c, alice.id, m.id, 'not Monday');
    await meetings.recordConstraint(c, alice.id, m.id, 'therapy that evening', true);

    // Alice still sees everything she said.
    const mine = await meetings.getStatus(c, alice.id, m.id);
    assert.deepEqual(mine.data.participants.find((p) => p.user_id === alice.id).constraints,
      ['not Monday', 'therapy that evening']);

    // Bob sees the scheduling fact and never the reason behind it. A flag the
    // writer sets and the reader ignores would be worse than no flag at all.
    const theirs = await meetings.getStatus(c, bob.id, m.id);
    assert.deepEqual(theirs.data.participants.find((p) => p.user_id === alice.id).constraints,
      ['not Monday']);
    assert.deepEqual(await meetings.shareableConstraints(c, m.id, alice.id), ['not Monday']);
  });
});

test('constraints written before reasons could travel still read as shareable', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'legacy', [bob.id])).data.meeting;
    // exactly the shape already in production: a bare jsonb array of strings
    await c.query(
      `UPDATE meeting_participants SET constraints = $3::jsonb WHERE meeting_id = $1 AND user_id = $2`,
      [m.id, alice.id, JSON.stringify(['רק שלישי וחמישי'])]);
    assert.deepEqual(await meetings.shareableConstraints(c, m.id, alice.id), ['רק שלישי וחמישי']);
    const st = await meetings.getStatus(c, bob.id, m.id);
    assert.deepEqual(st.data.participants.find((p) => p.user_id === alice.id).constraints,
      ['רק שלישי וחמישי']);
  });
});

test('a reason is bounded — it lands inside another user\'s agent turn', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'bounds', [bob.id])).data.meeting;
    await meetings.recordConstraint(c, alice.id, m.id, 'x'.repeat(500));
    for (const t of ['one', 'two', 'three', 'four']) {
      await meetings.recordConstraint(c, alice.id, m.id, t);
    }
    const shared = await meetings.shareableConstraints(c, m.id, alice.id);
    assert.ok(shared.length <= meetings.MAX_SHARED_REASONS, 'capped in count');
    for (const s of shared) {
      assert.ok(s.length <= meetings.CONSTRAINT_MAX_CHARS, 'capped in length');
    }
  });
});

// A slot has two halves — the words a person reads and the moment everything
// else acts on — and nothing checked that they named the same day. Meeting #4
// ("פוקר") stored "יום שני 20:00" as a Tuesday while both participants spent
// the afternoon negotiating about Monday.
test('a slot whose words and timestamp name different days is refused', async () => {
  const { a, b } = await pair('+972572000001', '+972572000002');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    const monday = slotStart('יום שני 20:00'); // the next real Monday

    const wrong = await meetings.proposeSlot(c, a.id, m.id, 'יום שלישי 20:00', monday);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.reason, 'weekday_mismatch');
    assert.match(wrong.error.message, /Tuesday/);
    assert.match(wrong.error.message, /Monday/);

    const english = await meetings.proposeSlot(c, a.id, m.id, 'Tuesday 20:00, cafe', monday);
    assert.equal(english.ok, false, 'English names are checked the same way');
    assert.equal(english.error.reason, 'weekday_mismatch');

    // Nothing was written on the way to the refusal.
    const { rows } = await c.query(`SELECT proposed_slot, proposed_start_at FROM meetings WHERE id = $1`, [m.id]);
    assert.equal(rows[0].proposed_slot, null);
    assert.equal(rows[0].proposed_start_at, null);

    const right = await meetings.proposeSlot(c, a.id, m.id, 'יום שני 20:00 אצל דני', monday);
    assert.equal(right.ok, true, 'the two halves agreeing is the whole requirement');
  });
});

test('a slot naming no weekday is stored exactly as before', async () => {
  const { a, b } = await pair('+972572000003', '+972572000004');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'קפה', [b.id])).data.meeting;
    for (const text of ['מחר ב-20:00', 'הערב 20:00', 'whenever suits you']) {
      const res = await meetings.proposeSlot(c, a.id, m.id, text, slotStart(text));
      assert.equal(res.ok, true, `${text} names no day, so there is nothing to check`);
    }
  });
});

// The counter-proposal path is where the live bug actually did its damage:
// four slots in one afternoon, each a decline carrying the next one.
test('a counter-proposal is held to the same rule — and refused before the decline lands', async () => {
  const { a, b } = await pair('+972572000005', '+972572000006');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'פוקר', [b.id])).data.meeting;
    await meetings.proposeSlot(c, a.id, m.id, 'יום שני 20:00', slotStart('יום שני 20:00'));

    const bad = await meetings.respondToSlot(c, b.id, m.id, false,
      'יום רביעי 20:00', slotStart('יום חמישי 20:00'));
    assert.equal(bad.ok, false);
    assert.equal(bad.error.reason, 'weekday_mismatch');
    assert.match(bad.error.message, /counter_proposal/);

    // The refusal is total: he is not left declined with nothing proposed.
    const st = await meetings.getStatus(c, b.id, m.id);
    const states = Object.fromEntries(st.data.participants.map((p) => [p.user_id, p.state]));
    assert.equal(states[b.id], 'awaiting');
    assert.equal(st.data.meeting.proposed_slot, 'יום שני 20:00');

    const good = await meetings.respondToSlot(c, b.id, m.id, false,
      'יום רביעי 20:00', slotStart('יום רביעי 20:00'));
    assert.equal(good.ok, true);
    assert.equal((await meetings.getStatus(c, b.id, m.id)).data.meeting.proposed_slot, 'יום רביעי 20:00');
  });
});

// The words are the proposer's, so they are judged where the proposer lives —
// the same reasoning that made a NULL users.timezone a three-hour bug.
test('the weekday is judged in the proposer own timezone', async () => {
  const { a, b } = await pair('+972572000007', '+972572000008', { timezone: 'Asia/Jerusalem' });
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, a.id, 'לילה', [b.id])).data.meeting;
    // Monday 17:00 UTC → still Monday in Israel; +5h is Tuesday 01:00 there.
    const mondayUtc = new Date(slotStart('יום שני')).getTime();
    const stillMonday = new Date(mondayUtc).toISOString().replace(/\.\d+Z$/, '+00:00');
    const alreadyTuesday = new Date(mondayUtc + 5 * 3600_000).toISOString().replace(/\.\d+Z$/, '+00:00');

    assert.equal((await meetings.proposeSlot(c, a.id, m.id, 'יום שני 20:00', stillMonday)).ok, true);
    const late = await meetings.proposeSlot(c, a.id, m.id, 'יום שני 23:00', alreadyTuesday);
    assert.equal(late.ok, false, 'past midnight in Israel it is Tuesday, whatever UTC says');
    assert.equal(late.error.reason, 'weekday_mismatch');
    assert.match(late.error.message, /Asia\/Jerusalem/);
  });
});

// ---- cancellation and withdrawal after confirmation -------------------------
// "תבטל את הפגישה" and "אני לא יכול להגיע" are different things: the first is
// the initiator calling it off for everyone (and it must work on a CONFIRMED
// meeting — a live initiator asked exactly that and was refused); the second
// is one person bowing out while the meeting stays on for the rest.

async function confirmedMeeting(c, initiator, others, slotText = 'Tuesday 17:00, phone') {
  const m = (await meetings.startMeeting(c, initiator.id, 'סגורה', others.map((u) => u.id))).data.meeting;
  const when = slotStart(slotText);
  await meetings.proposeSlot(c, initiator.id, m.id, slotText, when);
  for (const u of others) {
    const r = await meetings.respondToSlot(c, u.id, m.id, true, null, null, when);
    assert.ok(r.ok, JSON.stringify(r.error || {}));
  }
  const st = await c.query(`SELECT status FROM meetings WHERE id = $1`, [m.id]);
  assert.equal(st.rows[0].status, 'confirmed', 'fixture must reach confirmed');
  return Number(m.id);
}

test('the initiator can cancel a CONFIRMED meeting until it starts', async () => {
  await withClient(async (c) => {
    const id = await confirmedMeeting(c, alice, [bob]);

    // not the initiator → refused, same answer as "no such meeting"
    const notMine = await meetings.cancelMeeting(c, bob.id, id);
    assert.equal(notMine.ok, false);

    const res = await meetings.cancelMeeting(c, alice.id, id);
    assert.equal(res.ok, true, JSON.stringify(res.error || {}));
    assert.equal(res.data.meetingStatus, 'cancelled');
    assert.equal(res.data.wasConfirmed, true, 'the caller must know a calendar may need cleaning');

    // idempotence: a second cancel finds nothing open
    const again = await meetings.cancelMeeting(c, alice.id, id);
    assert.equal(again.ok, false);
  });
});

test('a meeting that already started cannot be cancelled', async () => {
  await withClient(async (c) => {
    const id = await confirmedMeeting(c, alice, [bob]);
    await c.query(`UPDATE meetings SET confirmed_start_at = now() - interval '2 hours' WHERE id = $1`, [id]);
    const res = await meetings.cancelMeeting(c, alice.id, id);
    assert.equal(res.ok, false);
    assert.match(res.error.message, /already started/);
    const st = await c.query(`SELECT status FROM meetings WHERE id = $1`, [id]);
    assert.equal(st.rows[0].status, 'confirmed', 'the row must be untouched');
  });
});

test('a participant withdrawing from a confirmed trio leaves the meeting ON', async () => {
  await withClient(async (c) => {
    const id = await confirmedMeeting(c, alice, [bob, carol]);

    // the initiator is pointed at cancel_meeting instead
    const initiatorTry = await meetings.optOut(c, alice.id, id);
    assert.equal(initiatorTry.ok, false);
    assert.match(initiatorTry.error.message, /cancel/);

    const res = await meetings.optOut(c, bob.id, id);
    assert.equal(res.ok, true, JSON.stringify(res.error || {}));
    assert.equal(res.data.withdrew, true);
    assert.equal(res.data.meetingStatus, 'confirmed', 'two people remain — still on');

    const st = await meetings.getStatus(c, alice.id, id);
    const states = Object.fromEntries(st.data.participants.map((p) => [p.user_id, p.state]));
    assert.equal(states[bob.id], 'opted_out');
    assert.equal(st.data.meeting.status, 'confirmed');
  });
});

test('withdrawing that leaves one person cascades into cancellation', async () => {
  await withClient(async (c) => {
    const id = await confirmedMeeting(c, alice, [bob]);
    const res = await meetings.optOut(c, bob.id, id);
    assert.equal(res.ok, true);
    assert.equal(res.data.cascadeCancelled, true);
    assert.equal(res.data.meetingStatus, 'cancelled');
    const st = await c.query(`SELECT status FROM meetings WHERE id = $1`, [id]);
    assert.equal(st.rows[0].status, 'cancelled');
  });
});

test('withdrawal after the meeting started is refused', async () => {
  await withClient(async (c) => {
    const id = await confirmedMeeting(c, alice, [bob, carol]);
    await c.query(`UPDATE meetings SET confirmed_start_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    const res = await meetings.optOut(c, bob.id, id);
    assert.equal(res.ok, false);
    assert.match(res.error.message, /already started/);
  });
});

// ---- titles -----------------------------------------------------------------

test('an unnamed meeting is named after its people, and the initiator can rename it', async () => {
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, '   ', [bob.id])).data.meeting;
    assert.match(m.title, /Alice/);
    assert.match(m.title, /Bob/);

    const renamed = await meetings.setTitle(c, alice.id, m.id, 'שיחה על הפרויקט');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.data.title, 'שיחה על הפרויקט');

    const notMine = await meetings.setTitle(c, bob.id, m.id, 'hijack');
    assert.equal(notMine.ok, false);

    const st = await meetings.getStatus(c, alice.id, m.id);
    assert.equal(st.data.meeting.title, 'שיחה על הפרויקט');
  });
});

// ---- what the digest can see ------------------------------------------------

// Sarah proposed lunch, confirmed her own side, was told "I'll let you know
// when he answers" — and heard nothing for three days, because every digest
// she got asked only "what do I owe an answer on". A meeting waiting on the
// OTHER person could not appear in it at all. Being owed an answer is exactly
// as much news as owing one, and the silence reads as nothing happening.
test('a meeting waiting on the other person shows up in the digest of the one waiting', async () => {
  const digest = require('../src/domain/digest');
  await withClient(async (c) => {
    const m = (await meetings.startMeeting(c, alice.id, 'Lunch', [bob.id])).data.meeting;
    const slot = 'Thursday at 14:00';
    const startsAt = slotStart(slot);
    await meetings.proposeSlot(c, alice.id, m.id, slot, startsAt);

    const hers = (await digest.assemble(c, alice.id, 'summary')).data.crossUser;
    assert.ok(!hers.pendingMeetings.some((x) => Number(x.id) === Number(m.id)),
      'she owes no answer on THIS one — she already proposed it');
    const waiting = hers.awaitingOthers.find((x) => Number(x.id) === Number(m.id));
    assert.ok(waiting, 'and yet she is waiting on somebody — that is the news');
    assert.deepEqual(waiting.waiting_on, ['Bob']);
    assert.equal(waiting.proposed_slot, slot);

    // Bob's own digest still says the opposite thing: HE owes the answer.
    const his = (await digest.assemble(c, bob.id, 'summary')).data.crossUser;
    assert.ok(his.pendingMeetings.some((x) => Number(x.id) === Number(m.id)));
    assert.ok(!his.awaitingOthers.some((x) => Number(x.id) === Number(m.id)),
      'nobody is waiting on anybody else here — only on him');

    // once he answers, it stops being news for either of them
    await meetings.respondToSlot(c, bob.id, m.id, true, null, null, startsAt);
    for (const who of [alice, bob]) {
      const cu = (await digest.assemble(c, who.id, 'summary')).data.crossUser;
      assert.ok(!cu.awaitingOthers.some((x) => Number(x.id) === Number(m.id)));
      assert.ok(!cu.pendingMeetings.some((x) => Number(x.id) === Number(m.id)));
    }
  });
});
