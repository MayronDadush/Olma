'use strict';
// Several candidate times per meeting (2026-09-05, the owner's rules): anyone
// in the meeting adds up to four; a fifth from a non-initiator waits for the
// initiator; the initiator swaps when it is full; adding is agreeing; the
// meeting confirms when ONE option is unanimous among the people still in it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const fanout = require('../src/domain/meeting-fanout');
const opts = meetings.options;

let db, ann, ben, cal;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972532000001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972532000002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972532000003', { firstName: 'Cal' });
  const c = await db.pool.connect();
  try {
    for (const [x, y] of [[ann, ben], [ann, cal], [ben, cal]]) {
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
const at = (h) => slotStart('', { hours: h });
async function trio(c, title) {
  return Number((await meetings.startMeeting(c, ann.id, title, [ben.id, cal.id])).data.meeting.id);
}
async function kinds(userId, meetingId) {
  const { rows } = await db.pool.query(
    `SELECT kind, payload FROM outbox WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2 ORDER BY id`, [userId, meetingId]);
  return rows.map((r) => r.kind);
}

test('up to four options; the initiator hits a wall, a participant\'s fifth waits for approval', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'ארבע');
    for (let i = 1; i <= 4; i++) {
      const r = await opts.add(c, i % 2 ? ann.id : ben.id, m, `option ${i}`, at(24 * i));
      assert.equal(r.ok, true, JSON.stringify(r.error));
      assert.equal(r.data.pending, false);
    }
    const table = await opts.list(c, m);
    assert.equal(table.filter((o) => o.status === 'active').length, 4);
    // adding is agreeing: each adder answered yes to their own
    assert.equal(table.find((o) => o.slotText === 'option 1').answers[String(ann.id)], 'y');
    assert.equal(table.find((o) => o.slotText === 'option 2').answers[String(ben.id)], 'y');

    const wall = await opts.add(c, ann.id, m, 'option 5 by initiator', at(24 * 5));
    assert.equal(wall.ok, false);
    assert.equal(wall.error.reason, 'options_full');

    const fifth = await opts.add(c, cal.id, m, 'option 5 by cal', at(24 * 6));
    assert.equal(fifth.ok, true);
    assert.equal(fifth.data.pending, true, 'a fifth from a participant waits for the initiator');
    assert.equal(fifth.data.initiatorId, Number(ann.id));
    assert.equal((await opts.list(c, m)).filter((o) => o.status === 'active').length, 4, 'not on the table yet');
    // the single-slot mirror is the newest ACTIVE option, never the pending one
    const st = await meetings.getStatus(c, ann.id, m);
    assert.equal(st.data.meeting.proposed_slot, 'option 4');
    assert.equal(st.data.options.length, 5);
    assert.equal(st.data.options.filter((o) => o.status === 'pending').length, 1);

    // only the initiator decides; approving at a full table must name the one it replaces
    const pendingId = fifth.data.option.id;
    const notYou = await opts.approve(c, ben.id, m, pendingId);
    assert.equal(notYou.ok, false);
    assert.equal(notYou.error.code, 'forbidden');
    const noRoom = await opts.approve(c, ann.id, m, pendingId);
    assert.equal(noRoom.ok, false);
    assert.equal(noRoom.error.reason, 'replace_required');
    const out = (await opts.list(c, m)).find((o) => o.slotText === 'option 1');
    const ok = await opts.approve(c, ann.id, m, pendingId, out.id);
    assert.equal(ok.ok, true);
    const after = await opts.list(c, m);
    assert.equal(after.filter((o) => o.status === 'active').length, 4);
    assert.equal(after.some((o) => o.slotText === 'option 1'), false, 'the replaced one is off the table');
    assert.equal(after.find((o) => o.slotText === 'option 5 by cal').status, 'active');
    assert.equal(after.find((o) => o.slotText === 'option 5 by cal').answers[String(cal.id)], 'y', 'the proposer\'s yes travelled with it');
  });
});

test('the initiator turns a fifth down, and only its proposer is told', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'לא הפעם');
    for (let i = 1; i <= 4; i++) await opts.add(c, ann.id, m, `o${i}`, at(24 * i));
    const fifth = await opts.add(c, ben.id, m, 'ben fifth', at(24 * 7));
    assert.equal(fifth.data.pending, true);
    await fanout.afterOptionAdded(c, ben, m, fifth);
    assert.deepEqual(await kinds(ann.id, m), ['meeting_option_pending'], 'the initiator hears about the fifth');
    assert.deepEqual(await kinds(cal.id, m), [], 'nobody else does');

    const no = await opts.reject(c, ann.id, m, fifth.data.option.id);
    assert.equal(no.ok, true);
    await fanout.afterOptionDecision(c, ann, m, no, { approved: false });
    assert.deepEqual(await kinds(ben.id, m), ['meeting_option_rejected']);
    assert.equal((await opts.list(c, m)).length, 4, 'a rejected option is gone from the table and the queue');
  });
});

test('the initiator swaps an option; the others hear the new one as a proposal', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'החלפה');
    for (let i = 1; i <= 4; i++) await opts.add(c, ann.id, m, `s${i}`, at(24 * i));
    const s2 = (await opts.list(c, m)).find((o) => o.slotText === 's2');
    const notYou = await opts.swap(c, ben.id, m, s2.id, 'ben swap', at(24 * 9));
    assert.equal(notYou.ok, false);
    const sw = await opts.swap(c, ann.id, m, s2.id, 'new s2', at(24 * 9));
    assert.equal(sw.ok, true);
    assert.equal(sw.data.replacedSlot, 's2');
    const table = (await opts.list(c, m)).filter((o) => o.status === 'active');
    assert.equal(table.length, 4);
    assert.equal(table.some((o) => o.slotText === 's2'), false);
    await fanout.afterOptionAdded(c, ann, m, sw);
    assert.deepEqual(await kinds(ben.id, m), ['meeting_slot_proposed']);
  });
});

test('a yes to any option counts for THAT option; the first unanimous one confirms', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'הסכמה');
    const a = (await opts.add(c, ann.id, m, 'A', at(24))).data.option;
    const b = (await opts.add(c, ben.id, m, 'B', at(48))).data.option;
    // ben says no to A, cal says yes to A → A is 2 of 3
    assert.equal((await opts.answer(c, ben.id, m, a.id, 'n')).ok, true);
    assert.equal((await opts.answer(c, cal.id, m, a.id, 'y')).data.meetingStatus, 'negotiating');
    // ann and cal say yes to B → B is unanimous → confirmed to B
    assert.equal((await opts.answer(c, ann.id, m, b.id, 'y')).data.meetingStatus, 'negotiating');
    const done = await opts.answer(c, cal.id, m, b.id, 'y');
    assert.equal(done.data.meetingStatus, 'confirmed');
    assert.equal(done.data.slot, 'B');
    const st = await meetings.getStatus(c, ann.id, m);
    assert.equal(st.data.meeting.status, 'confirmed');
    assert.equal(st.data.meeting.confirmed_slot, 'B');
    // nothing more can be added or answered
    assert.equal((await opts.add(c, ann.id, m, 'C', at(72))).ok, false);
  });
});

test('someone who left is not counted; the same moment twice is one option', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'שניים');
    const when = at(30);
    const a = (await opts.add(c, ann.id, m, 'A', when)).data.option;
    const again = await opts.add(c, ben.id, m, 'A again', when);
    assert.equal(again.data.duplicate, true);
    assert.equal(again.data.option.id, a.id, 'the second person to name the moment agreed to it');
    assert.equal((await opts.list(c, m)).length, 1);
    // cal leaves; ann and ben's yes is now everyone → confirmed
    assert.equal((await meetings.optOut(c, cal.id, m)).data.meetingStatus, 'confirmed',
      'an exit that completes the gate confirms, through the same gate');
  });
});

test('the migration carries a negotiation in flight over as one option with its answers', async () => {
  // Rows written by the old code path: proposed_slot on the meeting, states on
  // the participants, no option rows. The backfill in 039 is what turned them
  // into options on the box; here the same SQL is exercised on a fresh row.
  await withClient(async (c) => {
    const m = await trio(c, 'ישן');
    const when = at(40);
    await c.query(`UPDATE meetings SET proposed_slot = 'old style', proposed_start_at = $2 WHERE id = $1`, [m, when]);
    await c.query(`UPDATE meeting_participants SET state = CASE WHEN user_id = $2 THEN 'confirmed_current' WHEN user_id = $3 THEN 'declined_current' ELSE 'awaiting' END WHERE meeting_id = $1`, [m, ann.id, ben.id]);
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '039-meeting-options.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO meeting_options'));
    await c.query(backfill);
    const table = await opts.list(c, m);
    assert.equal(table.length, 1);
    assert.equal(table[0].slotText, 'old style');
    assert.deepEqual(table[0].answers, { [String(ann.id)]: 'y', [String(ben.id)]: 'n' });
  });
});
