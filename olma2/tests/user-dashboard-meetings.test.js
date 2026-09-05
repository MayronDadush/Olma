'use strict';
// Answering a coordination with a tap. The point of this file is that it goes
// through the SAME domain call and the same fan-out as the chat tool: a yes
// given on the page and a yes given in a conversation have to leave identical
// rows, or the two faces of the system slowly tell different people different
// things about one meeting.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const meetings = require('../src/domain/meetings');

let db, me, gali, ron;
const tx = (fn) => withTx(db.pool, fn);
const actAs = (u, action, payload) => tx((c) => write.perform(c, u.id, action, payload));

// Tomorrow at 17:00 Israel time, stated the way the tools require it.
function tomorrowAt(hh) {
  const d = new Date(Date.now() + 86400e3);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${day}T${hh}:00:00+03:00`;
}

// A live connection with meetings enabled on BOTH sides — which is what
// approving a request does in the real flow (respond_to_connection_request
// grants all three categories for both people).
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

async function coordination(initiator, others, title) {
  const res = await tx((c) => meetings.startMeeting(c, initiator.id, title, others.map((u) => u.id)));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  return Number(res.data.meeting.id);
}

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531940001', { firstName: 'Miron' });
  gali = await makeUser(db.pool, '+972531940002', { firstName: 'Gali' });
  ron = await makeUser(db.pool, '+972531940003', { firstName: 'Ron' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await connect(me, gali);
  await connect(me, ron);
  await connect(gali, ron);
});
after(async () => { if (db) await db.teardown(); });

test('a coordination reaches the page with a slot, and every answer state', async () => {
  const id = await coordination(gali, [me, ron], 'קפה');
  const when = tomorrowAt('17');
  assert.equal((await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־17:00', when))).ok, true);
  assert.equal((await tx((c) => meetings.respondToSlot(c, ron.id, id, true, null, null, when))).ok, true);

  const page = await tx((c) => dash.load(c, me.id));
  const m = page.data.meetings.find((x) => Number(x.id) === id);
  assert.equal(m.mine, false);
  assert.equal(Number(m.initiatorId), Number(gali.id));
  assert.equal(m.proposedDay, 1, 'the slot did not land on tomorrow in their own zone');
  assert.equal(m.proposedTime, '17:00');
  const byId = Object.fromEntries(m.participants.map((p) => [String(p.id), p]));
  assert.equal(byId[String(ron.id)].answer, 'y');
  assert.equal(byId[String(me.id)].answer, '', 'silence was folded into a refusal');
  assert.equal(byId[String(gali.id)].answer, 'y', 'proposing is agreeing to it');
});

test('a yes from the page confirms the meeting and tells everybody else', async () => {
  const id = await coordination(gali, [me, ron], 'פוקר');
  const when = tomorrowAt('20');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־20:00', when));
  await tx((c) => meetings.respondToSlot(c, ron.id, id, true, null, null, when));

  const r = await actAs(me, 'respondToMeeting', { meetingId: id, accept: true, acceptedStartAt: when });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  assert.equal(r.data.meetingStatus, 'confirmed');

  const { rows } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_confirmed'
       AND (payload->>'meetingId')::bigint = $1`, [id]);
  const told = rows.map((x) => Number(x.user_id)).sort();
  assert.deepEqual(told, [gali.id, ron.id].map(Number).sort(),
    'a tap confirmed the meeting and nobody else was told');
  assert.equal(told.includes(Number(me.id)), false,
    'the person who tapped was sent a notification about their own tap');
});

test('a no from the page is a decline, and the initiator hears it', async () => {
  const id = await coordination(gali, [me, ron], 'ישיבה');
  const when = tomorrowAt('11');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־11:00', when));

  const r = await actAs(me, 'respondToMeeting', { meetingId: id, accept: false });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_slot_declined'
       AND (payload->>'meetingId')::bigint = $1`, [id]);
  assert.deepEqual(rows.map((x) => Number(x.user_id)), [Number(gali.id)]);
});

// Since options (2026-09-05) a newer proposal does not replace the one the
// page showed — both are on the table. A yes carrying the older moment is a
// real yes to THAT option, and never a yes to the newer one; a yes carrying a
// moment that is not on the table at all is refused.
test('a yes from a page that sat open lands on the option it saw, never on the newer one', async () => {
  const id = await coordination(gali, [me, ron], 'שינוי');
  const seen = tomorrowAt('12');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־12:00', seen));
  const newer = tomorrowAt('15');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־15:00', newer));

  const r = await actAs(me, 'respondToMeeting', { meetingId: id, accept: true, acceptedStartAt: seen });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const st = await tx((c) => meetings.getStatus(c, me.id, id));
  const opt = (iso) => st.data.options.find((o) => new Date(o.startsAt).getTime() === new Date(iso).getTime());
  assert.equal(opt(seen).answers[String(me.id)], 'y');
  assert.equal(opt(newer).answers[String(me.id)], undefined, 'the newer option was never answered by this person');
  assert.equal(st.data.meeting.status, 'negotiating', 'ron has not answered anything');

  const nowhere = await actAs(me, 'respondToMeeting', { meetingId: id, accept: true, acceptedStartAt: tomorrowAt('18') });
  assert.equal(nowhere.ok, false, 'a moment that is not on the table is refused');
});

test('leaving from the page removes them and tells the initiator', async () => {
  const id = await coordination(gali, [me, ron], 'יציאה');
  const r = await actAs(me, 'leaveMeeting', { meetingId: id });
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
  const { rows } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [id, me.id]);
  assert.equal(rows[0].state, 'opted_out');
  const told = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind IN ('meeting_opt_out','meeting_no_match')
       AND (payload->>'meetingId')::bigint = $1`, [id]);
  assert.equal(told.rows.length >= 1, true, 'somebody left and nobody was told');
});

test('a meeting somebody left still shows the person, counted in nothing', async () => {
  const id = await coordination(gali, [me, ron], 'מי נשאר');
  await actAs(ron, 'leaveMeeting', { meetingId: id });
  const page = await tx((c) => dash.load(c, me.id));
  const m = page.data.meetings.find((x) => Number(x.id) === id);
  const gone = m.participants.find((p) => Number(p.id) === Number(ron.id));
  assert.equal(Boolean(gone), true, 'the tally dropped and the screen cannot say why');
  assert.equal(gone.left, true);
});

test('a meeting this person is not in cannot be answered or left', async () => {
  const id = await coordination(gali, [ron], 'לא שלי');
  const when = tomorrowAt('09');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־9:00', when));
  const stranger = await makeUser(db.pool, '+972531940009');
  assert.equal((await actAs(stranger, 'respondToMeeting', { meetingId: id, accept: true, acceptedStartAt: when })).ok, false);
  assert.equal((await actAs(stranger, 'leaveMeeting', { meetingId: id })).ok, false);
});

test('a meeting the person left is off the answerable list', async () => {
  const id = await coordination(gali, [me, ron], 'נעלם');
  await actAs(me, 'leaveMeeting', { meetingId: id });
  const page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.meetings.some((x) => Number(x.id) === id), false);
  // It is in the archive now rather than gone — see the archive block below.
  // This assertion used to be "off their page entirely", which was the whole
  // problem: a mis-tap was unrecoverable because nothing survived it.
});

// ---------------------------------------------------------------- the archive
//
// Leaving used to remove a coordination from this payload for good, so the
// page had nothing to draw a way back from. The archive is that missing half.

test('a coordination you left leaves the active list and lands in the archive', async () => {
  const id = await coordination(gali, [me, ron], 'ארוחה');
  assert.equal((await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־19:00', tomorrowAt('19')))).ok, true);

  const before = await tx((c) => dash.load(c, me.id));
  assert.ok(before.data.meetings.some((x) => Number(x.id) === id));
  assert.equal(before.data.meetingsLeft.some((x) => x.id === id), false);

  assert.equal((await actAs(me, 'leaveMeeting', { meetingId: id })).ok, true);

  const after = await tx((c) => dash.load(c, me.id));
  assert.equal(after.data.meetings.some((x) => Number(x.id) === id), false,
    'it must not still be answerable');
  const arc = after.data.meetingsLeft.find((x) => x.id === id);
  assert.ok(arc, 'and it must not have vanished either');
  assert.equal(arc.title, 'ארוחה');
  assert.equal(arc.youLeft, true);
});

// 2026-09-05: a meeting settled on 2026-08-20 — its slot only in words, from
// before slots carried a start time — sat on a user's ACTIVE list reading "no
// time proposed yet". Settled and happened is the archive, with the words.
test('a settled meeting that has happened leaves the active list and lands in the archive, with its slot', async () => {
  const past = await coordination(gali, [me, ron], 'פוקר');
  const when = new Date(Date.now() - 2 * 86400_000).toISOString();
  await db.pool.query(`UPDATE meetings SET status = 'confirmed', confirmed_slot = 'יום שלישי 21:00', confirmed_start_at = $2, updated_at = now() - interval '2 days' WHERE id = $1`, [past, when]);
  const legacy = await coordination(gali, [me, ron], 'banana');
  await db.pool.query(`UPDATE meetings SET status = 'confirmed', confirmed_slot = 'שבת 08:30 בבננה', confirmed_start_at = NULL, updated_at = now() - interval '16 days' WHERE id = $1`, [legacy]);
  const soon = await coordination(gali, [me, ron], 'קפה מחר');
  await db.pool.query(`UPDATE meetings SET status = 'confirmed', confirmed_slot = 'מחר 17:00', confirmed_start_at = $2 WHERE id = $1`, [soon, tomorrowAt('17')]);

  const page = await tx((c) => dash.load(c, me.id));
  const active = new Set(page.data.meetings.map((x) => Number(x.id)));
  assert.equal(active.has(soon), true, 'a settled meeting still ahead stays where it can be seen');
  assert.equal(active.has(past), false, 'one that happened is not active');
  assert.equal(active.has(legacy), false, 'one settled long ago in words only is not active either');
  const arcPast = page.data.meetingsLeft.find((x) => x.id === past);
  const arcLegacy = page.data.meetingsLeft.find((x) => x.id === legacy);
  assert.deepEqual(arcPast, { id: past, title: 'פוקר', youLeft: false, settled: true, slot: 'יום שלישי 21:00' });
  assert.deepEqual(arcLegacy, { id: legacy, title: 'banana', youLeft: false, settled: true, slot: 'שבת 08:30 בבננה' });
  assert.equal(page.data.meetingsLeft.some((x) => x.id === soon), false);
});

test('the archive carries a title and an id, and nothing about the negotiation', async () => {
  // Watching the others answer a coordination you stepped out of is not a
  // feature. The archive row is what "put me back in" needs and no more.
  const id = await coordination(gali, [me, ron], 'סוד');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־20:00', tomorrowAt('20')));
  await actAs(me, 'leaveMeeting', { meetingId: id });
  await tx((c) => meetings.respondToSlot(c, ron.id, id, true, null, null, tomorrowAt('20')));

  const page = await tx((c) => dash.load(c, me.id));
  const arc = page.data.meetingsLeft.find((x) => x.id === id);
  assert.deepEqual(Object.keys(arc).sort(), ['id', 'title', 'youLeft']);
});

test('putting yourself back in is a real rejoin, and the others are told', async () => {
  const id = await coordination(gali, [me, ron], 'חזרה');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־21:00', tomorrowAt('21')));
  await actAs(me, 'leaveMeeting', { meetingId: id });

  const res = await actAs(me, 'rejoinMeeting', { meetingId: id });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));

  const page = await tx((c) => dash.load(c, me.id));
  assert.ok(page.data.meetings.some((x) => Number(x.id) === id), 'back on the active list');
  assert.equal(page.data.meetingsLeft.some((x) => x.id === id), false, 'and out of the archive');

  // The others were told they left; they are told they are back, or everyone
  // is holding a tally that is quietly wrong.
  const { rows } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_rejoined'
       AND (payload->>'meetingId')::bigint = $1 ORDER BY user_id`, [id]);
  assert.deepEqual(rows.map((r) => Number(r.user_id)).sort(), [gali.id, ron.id].sort());
});

test('the archive never offers a way back into something already closed', async () => {
  // Two people: one leaving takes it below two, so it closes for both. The row
  // must not sit in the archive wearing a button the server would refuse.
  const id = await coordination(gali, [me], 'זוג');
  await tx((c) => meetings.proposeSlot(c, gali.id, id, 'מחר ב־22:00', tomorrowAt('22')));
  await actAs(me, 'leaveMeeting', { meetingId: id });

  const page = await tx((c) => dash.load(c, me.id));
  assert.equal(page.data.meetingsLeft.some((x) => x.id === id), false);
  const res = await actAs(me, 'rejoinMeeting', { meetingId: id });
  assert.equal(res.ok, false);
});
