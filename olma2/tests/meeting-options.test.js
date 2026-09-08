'use strict';
// Several candidate times per meeting (2026-09-05, revised 2026-09-09): anyone
// in the meeting adds up to five and anyone in it may take one off, whoever
// put it there; a sixth is refused to everybody and the refusal names the five,
// which `swap` answers in one transaction; adding is agreeing; the meeting
// confirms when ONE option is unanimous among the people still in it.
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
// Unanimity arms a minute; the sweep spends it. Tests that care about the END
// of a negotiation run the minute out rather than waiting for it — and pulling
// `settle_due_at` back is the honest way, because it leaves `settleDue`'s own
// re-check of unanimity exactly where production has it.
async function runGrace(c, meetingId) {
  await c.query(
    `UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [meetingId]);
  return opts.settleDue(c);
}
async function trio(c, title) {
  return Number((await meetings.startMeeting(c, ann.id, title, [ben.id, cal.id])).data.meeting.id);
}
async function kinds(userId, meetingId) {
  const { rows } = await db.pool.query(
    `SELECT kind, payload FROM outbox WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2 ORDER BY id`, [userId, meetingId]);
  return rows.map((r) => r.kind);
}

test('five options, added by anybody; a sixth is refused to everybody and names the five', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'חמש');
    for (let i = 1; i <= 5; i++) {
      const r = await opts.add(c, i % 2 ? ann.id : ben.id, m, `option ${i}`, at(24 * i));
      assert.equal(r.ok, true, JSON.stringify(r.error));
    }
    const table = await opts.list(c, m);
    assert.equal(table.length, 5);
    // adding is agreeing: each adder answered yes to their own
    assert.equal(table.find((o) => o.slotText === 'option 1').answers[String(ann.id)], 'y');
    assert.equal(table.find((o) => o.slotText === 'option 2').answers[String(ben.id)], 'y');

    // The wall is the same wall for the person who opened it and for everybody
    // else — and it hands back the table, because the caller's next question is
    // which one goes.
    for (const who of [ann, cal]) {
      const wall = await opts.add(c, who.id, m, 'option 6', at(24 * 6));
      assert.equal(wall.ok, false);
      assert.equal(wall.error.reason, 'options_full');
      assert.equal(wall.error.options.length, 5);
      assert.equal(wall.error.options.some((o) => o.slotText === 'option 3'), true);
    }
    assert.equal((await opts.list(c, m)).length, 5, 'and nothing was written');

    // The answer to the wall: this one instead of that one, in one call, from
    // somebody who did not open the coordination.
    const out = (await opts.list(c, m)).find((o) => o.slotText === 'option 1');
    const sw = await opts.swap(c, cal.id, m, out.id, 'option 6', at(24 * 6));
    assert.equal(sw.ok, true, JSON.stringify(sw.error));
    assert.equal(sw.data.replacedSlot, 'option 1');
    const after = await opts.list(c, m);
    assert.equal(after.length, 5);
    assert.equal(after.some((o) => o.slotText === 'option 1'), false);
    assert.equal(after.find((o) => o.slotText === 'option 6').answers[String(cal.id)], 'y',
      'the swapper agreed to what they put up, like any other adder');
  });
});

test('anyone in the coordination removes any option, and the people who answered it are told', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'מחיקה');
    const a = (await opts.add(c, ann.id, m, 'A', at(24))).data.option;
    const b = (await opts.add(c, ann.id, m, 'B', at(48))).data.option;
    assert.equal((await opts.answer(c, cal.id, m, a.id, 'y')).ok, true);
    assert.equal((await opts.answer(c, ben.id, m, a.id, 'n')).ok, true);

    // ben did not add it and did not open the coordination, and removes it all
    // the same. Ann answered it by adding it and cal by voting: both are told.
    const gone = await opts.remove(c, ben.id, m, a.id);
    assert.equal(gone.ok, true, JSON.stringify(gone.error));
    assert.equal(gone.data.slot, 'A');
    assert.equal(gone.data.optionsLeft, 1);
    assert.deepEqual(gone.data.hadAnswered.sort(), [Number(ann.id), Number(cal.id)].sort());
    const table = await opts.list(c, m);
    assert.deepEqual(table.map((o) => o.slotText), ['B']);
    // the mirror followed it: the single-slot columns are B now, not A
    assert.equal((await c.query('SELECT proposed_slot FROM meetings WHERE id = $1', [m])).rows[0].proposed_slot, 'B');
    // removing it twice is not a second removal
    assert.equal((await opts.remove(c, ben.id, m, a.id)).error.reason, 'option_not_active');
    // and the answers to it stopped counting: ann and ben each said yes to
    // exactly one option, and A is not on the table to make anything unanimous
    assert.equal((await c.query('SELECT settle_due_at FROM meetings WHERE id = $1', [m])).rows[0].settle_due_at, null);
    // the last one may go too — a table with nothing on it is where every
    // coordination starts, and anybody may put something back on it
    assert.equal((await opts.remove(c, cal.id, m, b.id)).data.optionsLeft, 0);
    assert.equal((await opts.list(c, m)).length, 0);
    assert.equal((await opts.add(c, cal.id, m, 'C', at(72))).ok, true);
  });
});

test('removing the option a grace was running on takes the arming back', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'ביטול הספירה');
    const a = (await opts.add(c, ann.id, m, 'A', at(26))).data.option;
    await opts.answer(c, ben.id, m, a.id, 'y');
    const armed = await opts.answer(c, cal.id, m, a.id, 'y');
    assert.equal(armed.data.meetingStatus, 'settling');
    const gone = await opts.remove(c, ben.id, m, a.id);
    assert.equal(gone.ok, true);
    assert.equal(gone.data.meetingStatus, 'negotiating');
    assert.equal((await c.query('SELECT settle_due_at, settling_option_id FROM meetings WHERE id = $1', [m])).rows[0].settle_due_at, null);
    // and the minute running out on a meeting with nothing on the table
    // closes nothing
    assert.deepEqual(await runGrace(c, m), []);
    assert.equal((await c.query('SELECT status FROM meetings WHERE id = $1', [m])).rows[0].status, 'negotiating');
  });
});

test('removing the first of two unanimous options arms the other', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'שתיים פה אחד');
    const a = (await opts.add(c, ann.id, m, 'A', at(28))).data.option;
    const b = (await opts.add(c, ann.id, m, 'B', at(52))).data.option;
    for (const o of [a, b]) {
      await opts.answer(c, ben.id, m, o.id, 'y');
      await opts.answer(c, cal.id, m, o.id, 'y');
    }
    // A armed first (lowest id wins the tie), so taking A away leaves B
    // holding everybody's yes — and this is the path that notices.
    const gone = await opts.remove(c, cal.id, m, a.id);
    assert.equal(gone.data.meetingStatus, 'settling');
    assert.equal(gone.data.settlingSlot, 'B');
    assert.equal((await runGrace(c, m)).length, 1);
    assert.equal((await c.query('SELECT confirmed_slot FROM meetings WHERE id = $1', [m])).rows[0].confirmed_slot, 'B');
  });
});

test('a stranger to the coordination cannot touch its table, and a settled one is closed', async () => {
  await withClient(async (c) => {
    const dee = await makeUser(db.pool, '+972532000004', { firstName: 'Dee' });
    const m = await trio(c, 'זר');
    const a = (await opts.add(c, ann.id, m, 'A', at(30))).data.option;
    assert.equal((await opts.remove(c, dee.id, m, a.id)).error.code, 'not_found');
    assert.equal((await opts.swap(c, dee.id, m, a.id, 'B', at(54))).error.code, 'not_found');
    // somebody who left is out of it too
    await meetings.optOut(c, cal.id, m);
    assert.equal((await opts.remove(c, cal.id, m, a.id)).ok, false);
    // and once it is confirmed the table is history
    await opts.answer(c, ben.id, m, a.id, 'y');
    await runGrace(c, m);
    assert.equal((await opts.remove(c, ben.id, m, a.id)).error.reason, 'not_negotiating');
  });
});

test('the swap that anyone may make; a participant is refused only when they are not in it', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'החלפה');
    for (let i = 1; i <= 4; i++) await opts.add(c, ann.id, m, `s${i}`, at(24 * i));
    const s2 = (await opts.list(c, m)).find((o) => o.slotText === 's2');
    const sw = await opts.swap(c, ben.id, m, s2.id, 'new s2', at(24 * 9));
    assert.equal(sw.ok, true, JSON.stringify(sw.error));
    assert.equal(sw.data.replacedSlot, 's2');
    const table = await opts.list(c, m);
    assert.equal(table.length, 4);
    assert.equal(table.some((o) => o.slotText === 's2'), false);
    await fanout.afterOptionAdded(c, ben, m, sw);
    assert.deepEqual(await kinds(ann.id, m), ['meeting_slot_proposed']);
  });
});

test('the removal reaches only the people who had answered, and takes the queued question with it', async () => {
  await withClient(async (c) => {
    const m = await trio(c, 'למי מספרים');
    const a = (await opts.add(c, ann.id, m, 'A', at(32)));
    // everyone was asked about A
    await fanout.afterOptionAdded(c, ann, m, a);
    assert.deepEqual(await kinds(ben.id, m), ['meeting_slot_proposed']);
    assert.deepEqual(await kinds(cal.id, m), ['meeting_slot_proposed']);
    // cal answered it; ben never did
    await opts.answer(c, cal.id, m, a.data.option.id, 'n');
    const gone = await opts.remove(c, ann.id, m, a.data.option.id);
    await fanout.afterOptionRemoved(c, ann, m, gone);
    assert.deepEqual(await kinds(cal.id, m), ['meeting_slot_proposed', 'meeting_option_removed'],
      'the person whose answer went with it is told');
    assert.deepEqual(await kinds(ben.id, m), ['meeting_slot_proposed'],
      'and the person who never answered hears nothing new');
    // ben's copy of the question is a question about a time nobody can answer
    const { rows } = await c.query(
      `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'meeting_slot_proposed'
        AND (payload->>'meetingId')::bigint = $2`, [ben.id, m]);
    assert.deepEqual(rows.map((r) => r.hold_reason), ['superseded']);
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
    assert.equal(done.data.meetingStatus, 'settling',
      'the last yes arms the minute — it does not end the meeting');
    assert.equal((await c.query(`SELECT status FROM meetings WHERE id = $1`, [m])).rows[0].status,
      'negotiating', 'and nothing is confirmed while the minute is still running');
    assert.equal((await runGrace(c, m)).length, 1);
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
    // cal leaves; ann and ben's yes is now everyone → the minute starts
    assert.equal((await meetings.optOut(c, cal.id, m)).data.meetingStatus, 'settling',
      'an exit that completes the gate arms it, through the same gate');
    assert.equal((await runGrace(c, m)).length, 1, 'and the minute closes it');
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
