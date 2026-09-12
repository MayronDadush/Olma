'use strict';
// The minimum a coordination calls enough, and the row that draws it.
//
// Two things are being held open here, and they are easy to confuse:
//
//   · the minimum is COPIED off the group when a coordination opens and is its
//     own from that instant. Read through at render time instead, a poker room
//     with a minimum of 4 could never host an ordinary coffee out of the same
//     room, and changing the room's number would move a threshold people are
//     already voting against.
//   · reaching it settles NOTHING. Unanimity arms the minute; "enough people"
//     only earns a mark, because enough is a judgement and somebody still has
//     to press the ✓. Every assertion about arming below is really about that
//     line.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');

let db, ann, ben, cal;
const tx = (fn) => withTx(db.pool, fn);
const actAs = (u, action, payload) => tx((c) => write.perform(c, u.id, action, payload));

function tomorrowAt(hh) {
  const d = new Date(Date.now() + 86400e3);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${day}T${hh}:00:00+03:00`;
}

async function connect(a, b) {
  const { rows } = await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [a.id, b.id, b.phone]);
  for (const grantor of [a, b]) {
    for (const feature of ['sharing', 'meetings', 'messages']) {
      await db.pool.query(
        `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature)
         VALUES ($1, $2, $3)`, [rows[0].id, grantor.id, feature]);
    }
  }
}

const quorumOf = async (id) => (await db.pool.query(
  `SELECT quorum_min FROM meetings WHERE id = $1`, [id])).rows[0].quorum_min;

before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972531960001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972531960002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972531960003', { firstName: 'Cal' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await connect(ann, ben); await connect(ann, cal); await connect(ben, cal);
});
after(async () => { await db.teardown(); });

const start = async (title) => Number((await tx((c) =>
  meetings.startMeeting(c, ann.id, title, [ben.id, cal.id]))).data.meeting.id);

// ---- the copy ---------------------------------------------------------------

test('a coordination with no group behind it starts with no minimum', async () => {
  assert.equal(await quorumOf(await start('קפה')), null);
});

test('a room\'s minimum is copied in at the start, and stops being the room\'s', async () => {
  const { rows } = await db.pool.query(
    `INSERT INTO chat_groups (channel, external_id, subject, quorum_min)
     VALUES ('whatsapp', 'g-quorum-1@g.us', 'פוקר', 4) RETURNING id`);
  const groupId = Number(rows[0].id);
  const id = Number((await tx((c) =>
    meetings.startMeeting(c, ann.id, 'ערב פוקר', [ben.id, cal.id], { groupId }))).data.meeting.id);
  assert.equal(await quorumOf(id), 4);

  // The room changes its mind two months later. A number people are already
  // voting against does not move under them.
  await db.pool.query(`UPDATE chat_groups SET quorum_min = 6 WHERE id = $1`, [groupId]);
  assert.equal(await quorumOf(id), 4);

  // And the copy can be cleared for THIS coordination, which is the case a
  // read-through could never express: the same room hosting an ordinary coffee.
  assert.ok((await actAs(ann, 'setQuorum', { meetingId: id, min: null })).ok);
  assert.equal(await quorumOf(id), null);
  assert.equal((await db.pool.query(
    `SELECT quorum_min FROM chat_groups WHERE id = $1`, [groupId])).rows[0].quorum_min, 6);
});

// ---- who may set it, and to what -------------------------------------------

test('anybody in the coordination may set it, and a stranger may not', async () => {
  const id = await start('שולחן');
  assert.ok((await actAs(ben, 'setQuorum', { meetingId: id, min: 2 })).ok);
  assert.equal(await quorumOf(id), 2);

  const dan = await makeUser(db.pool, '+972531960004', { firstName: 'Dan' });
  const no = await actAs(dan, 'setQuorum', { meetingId: id, min: 3 });
  assert.equal(no.ok, false);
  assert.equal(no.error.code, 'not_found');
  assert.equal(await quorumOf(id), 2);
});

test('a minimum of one is not a minimum, and neither is a fraction', async () => {
  const id = await start('בדיקה');
  for (const bad of [1, 0, -2, 2.5, 'שלוש']) {
    const res = await actAs(ann, 'setQuorum', { meetingId: id, min: bad });
    assert.equal(res.ok, false, `${bad} should be refused`);
    assert.equal(res.error.code, 'invalid');
  }
  assert.equal(await quorumOf(id), null);
});

test('a number larger than today\'s table is allowed — people get added', async () => {
  const id = await start('גדול');
  assert.ok((await actAs(ann, 'setQuorum', { meetingId: id, min: 9 })).ok);
  assert.equal(await quorumOf(id), 9);
});

// ---- what it does NOT do ----------------------------------------------------

test('reaching the minimum arms nothing — only unanimity starts the minute', async () => {
  const id = await start('מניין');
  await actAs(ann, 'setQuorum', { meetingId: id, min: 2 });
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־18:00', tomorrowAt('18')));
  const opt = (await tx((c) => meetings.options.list(c, id)))[0];

  // Ann proposed, so Ann has already agreed. Ben makes two of a table of three,
  // which is the stated minimum — and the meeting must still be negotiating
  // with no minute running.
  const second = await actAs(ben, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  assert.ok(second.ok);
  const row = (await db.pool.query(
    `SELECT status, settle_due_at FROM meetings WHERE id = $1`, [id])).rows[0];
  assert.equal(row.status, 'negotiating');
  assert.equal(row.settle_due_at, null, 'enough people is not everybody');

  // The third yes is unanimity, and that is what arms it.
  await actAs(cal, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  assert.notEqual((await db.pool.query(
    `SELECT settle_due_at FROM meetings WHERE id = $1`, [id])).rows[0].settle_due_at, null);
});

test('a settled coordination will not take a new minimum', async () => {
  const id = await start('סגור');
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־20:00', tomorrowAt('20')));
  const opt = (await tx((c) => meetings.options.list(c, id)))[0];
  await actAs(ann, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  await actAs(ben, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  await tx((c) => meetings.settleNow(c, ann.id, id, opt.id));

  const res = await actAs(ann, 'setQuorum', { meetingId: id, min: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_found');
});

// ---- the page ---------------------------------------------------------------

test('the number reaches the page, and null stays null', async () => {
  const id = await start('לדף');
  const rowFor = async () => {
    const page = await tx((c) => dash.load(c, ann.id));
    assert.ok(page.ok, 'the page loaded');
    return page.data.meetings.find((m) => Number(m.id) === id);
  };
  const unset = await rowFor();
  assert.equal(unset.quorumMin, null, 'no minimum is null, never 0 and never a head count');

  await actAs(ann, 'setQuorum', { meetingId: id, min: 3 });
  assert.equal((await rowFor()).quorumMin, 3);
});

// ---- the row ----------------------------------------------------------------
//
// The page is served as one file, so these are the only thing standing between
// a row design and the rules it is supposed to encode. Each assertion is a
// rule, not a look.
test('the row draws the rules the design decided', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

  // Gold is unanimity and green is the minimum, in that order and exclusive:
  // everybody is also above any minimum, and two marks on one row says nothing.
  assert.match(page, /if\(y === total\) return "full";\s*\n\s*if\(m\.quorumMin && y >= m\.quorumMin\) return "min";/,
    'unanimity outranks the minimum, and no minimum means no green ever');

  // Silence is the gap in the ring. An arc for it would make "has not got to
  // it yet" look like a third opinion.
  assert.match(page, /arc\("yes", yLen, 0\) \+ arc\("no", nLen, yLen\)/,
    'two arcs and a gap — the gap is the people who have not answered');

  // A settled time is not deletable on either surface: ending something
  // everybody was told about is cancelling the coordination.
  assert.match(page, /settled \? " locked" : ""/, 'a settled row locks the swipe');
  assert.match(page, /settled \? "" : '<button class="mtback" data-del-confirm/,
    'and carries no red underneath it at all');

  // Two presses to delete, on both surfaces, and the swipe is the first of
  // them on a phone.
  assert.match(page, /if\(mtArmedDel === o\.id\)\{ mtRemove\(o\); return; \}/,
    'the desktop trash arms before it deletes');
  assert.match(page, /mtSwiped = moved > SWIPE_OPEN \* LATCH/,
    'and the swipe has to travel before it latches');

  // Nothing is drawn as gone before the server agrees.
  assert.match(page, /API\.send\("removeOption", \{meetingId:m\.id, optionId:o\.id\}/,
    'a removal is a call, not a local splice');

  // The minimum is cyclable all the way back to unset — a copied-in group
  // number is exactly the one somebody needs to clear.
  assert.match(page, /m\.quorumMin \+ 1 > people \? null : m\.quorumMin \+ 1/,
    'past the top it returns to no minimum');
});

// Leaving is opting OUT; the initiator's only door is cancel_meeting, and
// that is chat-only (see the swipe-shell CSS comment above). The server has
// always refused a leave from them — what was missing is the page ever
// finding that out: it offered the button anyway, appeared to remove the
// row, and then watched it come back on the next reload with nothing said.
// tests/user-dashboard-meetings.test.js pins the server side of this; these
// pin that the served page actually stopped offering the doomed call.
test('the page never offers a leave it knows the server will refuse', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

  // The sheet's leave button is hidden for the coordination's own initiator,
  // with an explanation drawn in its place rather than nothing at all.
  assert.match(page, /var own = m\.by === 0;/, 'the sheet knows whose row this is');
  assert.match(page, /\$\("#mtLeave"\)\.hidden = own;/, 'and hides the doomed button for them');
  assert.match(page, /\$\("#mtOwnNote"\)\.hidden = !own;/, 'replacing it with a reason, not silence');

  // The row's quick-leave X is never drawn at all for a coordination this
  // person started — there is nothing on the list screen that would open the
  // confirm-and-fail loop.
  assert.match(page, /m\.by === 0 \? "" :\s*\n\s*'<button class="mtx" data-mtleave=/,
    'the row omits its own X rather than wiring one that always fails');

  // Belt and suspenders: even if something still calls it, leaving your own
  // coordination is a no-op rather than an optimistic remove that a reload
  // then undoes.
  assert.match(page, /function mtLeave\(m\)\{\s*\n(?:[^\n]*\n)*?\s*if\(m\.by === 0\) return;/,
    'mtLeave refuses to touch a row you initiated');
});
