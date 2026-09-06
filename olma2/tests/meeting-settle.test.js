'use strict';
// How a coordination ends, after the owner's two rules of 2026-09-06:
//
//   · agreement no longer ends it on the spot — the last yes starts a minute,
//     and a mind changed inside that minute takes the whole thing back;
//   · and the person who opened it may end it by hand whatever the answers
//     say, for "everyone wants Tuesday, Dana can't make it, do it anyway".
//
// What is under test is mostly what does NOT happen: nobody is told inside the
// minute, nothing is settled on an option that stopped being unanimous, and
// nobody but the initiator can force it. The announcement is the irreversible
// part of a meeting, so every test here is really about the announcement.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const meetingFanout = require('../src/domain/meeting-fanout');
const write = require('../src/domain/user-dashboard-write');
const dash = require('../src/domain/user-dashboard');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db, ann, ben, cal;
const tx = (fn) => withTx(db.pool, fn);
const actAs = (u, action, payload) => tx((c) => write.perform(c, u.id, action, payload));
const call = (name, user, args) =>
  tx((c) => BY_NAME.get(name).handler(c, user, args || {}));

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

// A trio with two candidate times on the table, nobody having answered but the
// proposer (adding is agreeing).
async function table(title) {
  const id = Number((await tx((c) =>
    meetings.startMeeting(c, ann.id, title, [ben.id, cal.id]))).data.meeting.id);
  const a = tomorrowAt('18'); const b = tomorrowAt('20');
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־18:00', a));
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־20:00', b));
  const opts = await tx((c) => meetings.options.list(c, id));
  return { id, a: opts.find((o) => o.slotText.includes('18')), b: opts.find((o) => o.slotText.includes('20')) };
}

// The minute, spent on demand: the armed moment is pulled back and the sweep
// runs exactly as brokerd runs it, re-check of unanimity included.
async function runGrace(meetingId) {
  return tx(async (c) => {
    await c.query(
      `UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second'
        WHERE id = $1 AND settle_due_at IS NOT NULL`, [meetingId]);
    const settled = await meetings.options.settleDue(c);
    for (const s of settled) {
      await meetingFanout.afterSettled(c, s.meetingId, { ok: true, data: s }, { actor: null });
    }
    return settled;
  });
}
const told = async (meetingId) => (await db.pool.query(
  `SELECT user_id, payload FROM outbox WHERE kind = 'meeting_confirmed'
     AND (payload->>'meetingId')::bigint = $1 ORDER BY user_id`, [meetingId])).rows;
const statusOf = async (id) => (await db.pool.query(
  `SELECT status, settle_due_at, settling_option_id FROM meetings WHERE id = $1`, [id])).rows[0];

before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972531950001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972531950002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972531950003', { firstName: 'Cal' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await connect(ann, ben); await connect(ann, cal); await connect(ben, cal);
});
after(async () => { await db.teardown(); });

// ---- the minute -------------------------------------------------------------

test('the last yes arms the minute and tells nobody; the sweep ends it and tells everybody', async () => {
  const { id, a } = await table('פוקר');
  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  const last = await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });

  assert.equal(last.data.meetingStatus, 'settling');
  const armed = await statusOf(id);
  assert.equal(armed.status, 'negotiating', 'nothing is settled while the minute runs');
  assert.equal(Number(armed.settling_option_id), Number(a.id));
  assert.deepEqual(await told(id), [], 'and not one person has been told');

  const settled = await runGrace(id);
  assert.equal(settled.length, 1);
  assert.equal((await statusOf(id)).status, 'confirmed');
  assert.deepEqual((await told(id)).map((r) => Number(r.user_id)).sort((x, y) => x - y),
    [ann.id, ben.id, cal.id].map(Number).sort((x, y) => x - y),
    'the system settled it, so there is no actor mid-turn and everyone gets a row');
  assert.equal((await told(id))[0].payload.forced, undefined,
    'nobody forced this one, and the message must not say somebody did');
});

test('a mind changed inside the minute takes the whole thing back', async () => {
  const { id, a } = await table('ישיבה');
  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  assert.ok((await statusOf(id)).settle_due_at, 'armed');

  const back = await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'n' });
  assert.equal(back.data.meetingStatus, 'negotiating');
  assert.equal((await statusOf(id)).settle_due_at, null, 'the arming is gone');

  assert.deepEqual(await runGrace(id), [], 'and the minute has nothing left to settle');
  assert.equal((await statusOf(id)).status, 'negotiating');
  assert.deepEqual(await told(id), []);
});

test('the sweep re-asks the question rather than trusting the armed row', async () => {
  const { id, a } = await table('בדיקה');
  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  // A no written straight into the table, so nothing goes through tryConfirm
  // and the row stays armed on an option that is no longer unanimous.
  await db.pool.query(
    `UPDATE meeting_option_answers SET answer = 'n' WHERE option_id = $1 AND user_id = $2`,
    [a.id, cal.id]);
  assert.ok((await statusOf(id)).settle_due_at, 'still armed, wrongly');

  assert.deepEqual(await runGrace(id), [], 'the sweep asks again and declines');
  assert.equal((await statusOf(id)).status, 'negotiating');
  assert.equal((await statusOf(id)).settle_due_at, null, 'and clears the stale arming');
});

test('saying the same yes again does not push the moment away', async () => {
  const { id, a } = await table('שוב');
  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  const first = (await statusOf(id)).settle_due_at;
  await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  assert.deepEqual((await statusOf(id)).settle_due_at, first,
    'a repeated yes must not restart the clock, or one person can hold a meeting open forever');
});

// ---- the button -------------------------------------------------------------

test('only the person who opened it may settle it by hand', async () => {
  const { id, a } = await table('מי קובע');
  const no = await actAs(ben, 'settleMeeting', { meetingId: id, optionId: a.id });
  assert.equal(no.ok, false);
  assert.equal(no.error.reason, 'not_initiator');
  assert.equal((await statusOf(id)).status, 'negotiating');
  assert.deepEqual(await told(id), []);
});

test('a time nobody put on the table cannot be settled onto', async () => {
  const { id } = await table('לא על השולחן');
  const other = await table('אחרת');
  const no = await actAs(ann, 'settleMeeting', { meetingId: id, optionId: other.a.id });
  assert.equal(no.ok, false);
  assert.equal(no.error.reason, 'option_not_active');
});

test('the initiator settles without everyone, and the ones who never agreed are told so', async () => {
  const { id, a } = await table('בלי דנה');
  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  // cal never answers.
  const res = await actAs(ann, 'settleMeeting', { meetingId: id, optionId: a.id });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.meetingStatus, 'confirmed');
  assert.deepEqual(res.data.withoutYes, [Number(cal.id)]);
  assert.equal(res.data.unanimous, false);
  assert.equal((await statusOf(id)).status, 'confirmed', 'by hand is immediate — there is no minute');

  const rows = await told(id);
  const by = new Map(rows.map((r) => [Number(r.user_id), r.payload]));
  assert.equal(by.has(Number(ann.id)), false, 'the one who pressed it is mid-turn and gets a hint, not a row');
  assert.equal(by.get(Number(ben.id)).settledWithoutYou, undefined,
    'he had said yes — nothing was decided over him');
  assert.equal(by.get(Number(cal.id)).settledWithoutYou, true,
    'she never said yes and has to be told that plainly');
  assert.equal(by.get(Number(cal.id)).forced, true);
  assert.equal(by.get(Number(cal.id)).byName, 'Ann');
});

test('the two doors settle identically', async () => {
  const { id, a } = await table('מהצאט');
  const res = await call('settle_meeting', ann, { meeting_id: id, option_id: a.id });
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.meetingStatus, 'confirmed');
  assert.deepEqual(res.data.withoutYes.sort((x, y) => x - y),
    [ben.id, cal.id].map(Number).sort((x, y) => x - y));
  const { rows } = await db.pool.query(
    `SELECT event FROM audit_log WHERE (detail->>'meetingId')::bigint = $1 AND event = 'meeting.settled_by_hand'`,
    [id]);
  assert.equal(rows.length, 1, 'one trail, whichever door it came through');
});

// ---- what the page is handed -------------------------------------------------

test('the page is told how long is left, and who may end it', async () => {
  const { id, a } = await table('לדף');
  const mine = async (who) => (await tx((c) => dash.load(c, who.id)))
    .data.meetings.find((m) => Number(m.id) === id);

  assert.equal((await mine(ann)).canSettle, true, 'she opened it');
  assert.equal((await mine(ben)).canSettle, false, 'he did not');
  assert.equal((await mine(ann)).settleIn, null, 'nothing is counting down yet');

  await actAs(ben, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: a.id, answer: 'y' });
  const armed = await mine(ben);
  assert.ok(armed.settleIn > 0 && armed.settleIn <= 60, `settleIn was ${armed.settleIn}`);
  assert.equal(Number(armed.settlingOptionId), Number(a.id));
});

test('the page draws the button on the server\'s answer and sends the action', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'design', 'user-dashboard.html'), 'utf8');

  assert.match(page, /\(!LIVE \|\| m\.canSettle \? '<button class="mobtn settle" data-settle>/,
    'the live button opens on canSettle and nothing else — it used to be drawn for nobody');
  assert.match(page, /API\.send\("settleMeeting", \{meetingId:m\.id, optionId:o\.id\}/,
    'and pressing it has to reach the server rather than draw a settled card');
  assert.match(page, /settleMeeting:"settleMeeting"/, 'the action has to be on the map');
  assert.match(page, /settleIn:\(typeof m\.settleIn === "number" \? m\.settleIn : null\)/,
    'the countdown is the server\'s number, never the phone\'s clock');
  assert.match(page, /"mt\.settlingIn":"כולם יכולים — נקבע בעוד \{n\} שניות/,
    'and the minute says what it is for: you can still change it');
  // A countdown that arrives once and never moves reads as a broken page, so
  // the seconds tick locally — and when they run out the page ASKS rather
  // than deciding, because it cannot know whether the last second changed
  // somebody's mind.
  assert.match(page, /setInterval\(tickSettle, 1000\);/);
  assert.match(page, /settleAsked\[key\] = true;\n\s*\/\*[\s\S]{0,200}?\*\/\n\s*API\.reload\(\);/,
    'the end of the countdown is a re-read, never a local settle');
});
