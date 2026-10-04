'use strict';
// A coordination that settles on a whole day or a part of one asks ONE person
// whether they want an exact hour, and anybody in it may then set one (owner,
// 2026-09-24). What is under test is mostly the "one": two people asked the
// same question can answer it two ways, which is the collision the owner
// named. A room is asked on its own "סגור" line instead (group-voice).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const meetingFanout = require('../src/domain/meeting-fanout');
const write = require('../src/domain/user-dashboard-write');
const { instructionFor } = require('../src/channels/openclaw');
const { BY_NAME } = require('../src/adapters/mcp/registry');

let db, ann, ben, cal, dan;
const tx = (fn) => withTx(db.pool, fn);
const actAs = (u, action, payload) => tx((c) => write.perform(c, u.id, action, payload));
const call = (name, user, args) => tx((c) => BY_NAME.get(name).handler(c, user, args || {}));

function tomorrowAt(hh, days = 1) {
  const d = new Date(Date.now() + days * 86400e3);
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

// Ann opens a coordination with Ben and Cal and puts one inexact time on it.
async function openWith(precision) {
  const id = Number((await tx((c) =>
    meetings.startMeeting(c, ann.id, 'ים', [ben.id, cal.id]))).data.meeting.id);
  const put = await call('propose_meeting_slot', ann, {
    meeting_id: id, slot_description: precision.allDay ? 'מחר כל היום' : 'מחר בערב',
    starts_at: tomorrowAt('12'), ...(precision.allDay ? { all_day: true } : { daypart: precision.daypart }) });
  assert.ok(put.ok, JSON.stringify(put));
  const [opt] = await tx((c) => meetings.options.list(c, id));
  return { id, opt };
}
const rows = async (kind, meetingId) => (await db.pool.query(
  `SELECT user_id, payload, hold_reason FROM outbox WHERE kind = $1
     AND (payload->>'meetingId')::bigint = $2 ORDER BY user_id, id`, [kind, meetingId])).rows;

before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972531960001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972531960002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972531960003', { firstName: 'Cal' });
  dan = await makeUser(db.pool, '+972531960004', { firstName: 'Dan' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await connect(ann, ben); await connect(ann, cal); await connect(ben, cal);
});
after(async () => { await db.teardown(); });

test('settled by hand in chat: the settler is asked in their own turn, and nobody else is', async () => {
  const { id, opt } = await openWith({ allDay: true });
  const res = await call('settle_meeting', ann, { meeting_id: id, option_id: opt.id });
  assert.ok(res.ok, JSON.stringify(res));
  assert.match(res.data.hint, /whether they want to fix an exact time/);
  assert.match(res.data.hint, new RegExp(`propose_meeting_slot meeting_id=${id}`));
  const told = await rows('meeting_confirmed', id);
  assert.equal(told.length, 2);
  assert.ok(told.every((r) => !r.payload.askExactTime), 'the others are not asked');
});

test('settled by agreement: only the person who opened it is asked', async () => {
  const { id, opt } = await openWith({ daypart: 'evening' });
  await actAs(ben, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  await actAs(cal, 'answerOption', { meetingId: id, optionId: opt.id, answer: 'y' });
  await tx(async (c) => {
    await c.query(`UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [id]);
    for (const s of await meetings.options.settleDue(c)) {
      await meetingFanout.afterSettled(c, s.meetingId, { ok: true, data: s }, { actor: null });
    }
  });
  const told = await rows('meeting_confirmed', id);
  assert.deepEqual(told.filter((r) => r.payload.askExactTime).map((r) => Number(r.user_id)), [Number(ann.id)]);
  const body = instructionFor({ kind: 'meeting_confirmed', payload: told.find((r) => r.payload.askExactTime).payload });
  assert.match(body, /Ask the user ONCE/);
  const plain = instructionFor({ kind: 'meeting_confirmed', payload: told.find((r) => !r.payload.askExactTime).payload });
  assert.doesNotMatch(plain, /exact time/);
});

test('settled from the page: there is no turn to ask in, so the settler gets the one question as a message', async () => {
  const { id, opt } = await openWith({ allDay: true });
  const res = await actAs(ben, 'settleMeeting', { meetingId: id, optionId: opt.id });
  assert.ok(res.ok, JSON.stringify(res));
  const asks = await rows('meeting_exact_time_ask', id);
  assert.deepEqual(asks.map((r) => Number(r.user_id)), [Number(ben.id)]);
  assert.ok((await rows('meeting_confirmed', id)).every((r) => !r.payload.askExactTime));
  assert.match(instructionFor({ kind: 'meeting_exact_time_ask', payload: asks[0].payload }), /Ask the user ONCE/);

  // …and anybody in it may answer: Cal sets it, and the question is withdrawn.
  const set = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: tomorrowAt('18') });
  assert.ok(set.ok, JSON.stringify(set));
  const { rows: [m] } = await db.pool.query(
    'SELECT confirmed_slot, confirmed_start_at, confirmed_all_day, time_set_at, status FROM meetings WHERE id = $1', [id]);
  assert.equal(m.status, 'confirmed');
  assert.equal(m.confirmed_all_day, false);
  assert.equal(m.confirmed_slot, 'מחר ב־18:00');
  assert.equal(new Date(m.confirmed_start_at).toISOString(), new Date(tomorrowAt('18')).toISOString());
  assert.ok(m.time_set_at);
  assert.equal((await rows('meeting_exact_time_ask', id))[0].hold_reason, 'superseded');
  // Ben settled it and had no confirmation to wait for, so he hears the hour;
  // Ann's confirmation had not gone out yet, so it says the hour itself.
  const heard = await rows('meeting_time_set', id);
  assert.deepEqual(heard.map((r) => Number(r.user_id)), [Number(ben.id)]);
  assert.match(instructionFor({ kind: 'meeting_time_set', payload: heard[0].payload }), /set the exact time/);
  const annConf = (await rows('meeting_confirmed', id)).find((r) => Number(r.user_id) === Number(ann.id));
  assert.equal(annConf.payload.slot, 'מחר ב־18:00');
});

// Saar, 2026-10-03: the confirmation and the hour were both held over Shabbat
// and went out three minutes apart — two messages about one meeting, to seven
// people. A confirmation still waiting says the hour itself.
test('the hour set while the confirmation is still waiting rides the confirmation, not a second message', async () => {
  const { id, opt } = await openWith({ allDay: true });
  await call('settle_meeting', ann, { meeting_id: id, option_id: opt.id });
  // Ben's confirmation went out; Cal's is held for the night.
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE kind = 'meeting_confirmed'
                         AND (payload->>'meetingId')::bigint = $1 AND user_id = $2`, [id, ben.id]);
  await db.pool.query(`UPDATE outbox SET hold_reason = 'night', release_after = now() + interval '8 hours'
                         WHERE kind = 'meeting_confirmed' AND (payload->>'meetingId')::bigint = $1 AND user_id = $2`, [id, cal.id]);
  const starts = tomorrowAt('18');
  assert.ok((await call('propose_meeting_slot', ann, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: starts })).ok);

  const heard = await rows('meeting_time_set', id);
  assert.deepEqual(heard.map((r) => Number(r.user_id)), [Number(ben.id)], 'only the one who already heard it settled');
  const calConf = (await rows('meeting_confirmed', id)).filter((r) => Number(r.user_id) === Number(cal.id));
  assert.equal(calConf.length, 1, 'still one row');
  const p = calConf[0].payload;
  assert.equal(p.slot, 'מחר ב־18:00');
  assert.equal(new Date(p.startsAtUtc).toISOString(), new Date(starts).toISOString());
  assert.equal(p.allDay, undefined, 'no longer a whole day');
  assert.equal(p.askExactTime, undefined);
  const body = instructionFor({ kind: 'meeting_confirmed', payload: p, timezone: 'Asia/Jerusalem' });
  assert.match(body, /מחר ב־18:00/);
  assert.doesNotMatch(body, /WHOLE-DAY|Ask the user ONCE/);
  assert.match(body, /start at exactly/, "the calendar step gets the hour, not the stand-in");
});

test('setting the hour is narrow: the same day, once, and only by somebody in it', async () => {
  const { id, opt } = await openWith({ allDay: true });
  await call('settle_meeting', ann, { meeting_id: id, option_id: opt.id });
  const otherDay = await call('propose_meeting_slot', ben, {
    meeting_id: id, slot_description: 'מחרתיים ב־18:00', starts_at: tomorrowAt('18', 2) });
  assert.equal(otherDay.ok, false);
  assert.equal(otherDay.error.reason, 'other_day');
  const outsider = await call('propose_meeting_slot', dan, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: tomorrowAt('18') });
  assert.equal(outsider.ok, false);
  const once = await call('propose_meeting_slot', ben, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: tomorrowAt('18') });
  assert.ok(once.ok, JSON.stringify(once));
  const same = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: tomorrowAt('18') });
  assert.equal(same.ok, false);
  assert.equal(same.error.reason, 'same_time');
});

// Padel Gang, 2026-10-03: settled on 18:00, the room moved it to 17:00, and the
// only door was reopening — which asked everybody again. The owner wanted the
// middle: edit the hour of a settled coordination and nothing else.
test('an exact time is MOVED, the coordination stays settled, and a second move is heard too', async () => {
  const { id, opt } = await openWith({ allDay: true });
  await call('settle_meeting', ann, { meeting_id: id, option_id: opt.id });
  assert.ok((await call('propose_meeting_slot', ben, {
    meeting_id: id, slot_description: 'מחר ב־18:00', starts_at: tomorrowAt('18') })).ok);
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE kind IN ('meeting_time_set', 'meeting_confirmed')
                         AND (payload->>'meetingId')::bigint = $1`, [id]);
  await db.pool.query('UPDATE meetings SET group_time_at = now(), group_hour_at = now() WHERE id = $1', [id]);

  const moved = await call('propose_meeting_slot', cal, {
    meeting_id: id, slot_description: 'מחר ב־17:00', starts_at: tomorrowAt('17') });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.equal(moved.data.moved, true);
  assert.match(moved.data.hints.said, /changed/);

  const { rows: [m] } = await db.pool.query(
    `SELECT status, confirmed_slot, confirmed_start_at, reopened_at, group_time_at, group_hour_at
       FROM meetings WHERE id = $1`, [id]);
  assert.equal(m.status, 'confirmed', 'never reopened');
  assert.equal(m.reopened_at, null);
  assert.equal(m.confirmed_slot, 'מחר ב־17:00');
  assert.equal(new Date(m.confirmed_start_at).toISOString(), new Date(tomorrowAt('17')).toISOString());
  assert.equal(m.group_time_at, null, 'the room hears the new hour');
  assert.equal(m.group_hour_at, null, 'the hour-before line is owed for the new hour');

  const heard = (await rows('meeting_time_set', id)).filter((r) => r.payload.moved);
  assert.deepEqual(heard.map((r) => Number(r.user_id)).sort(), [Number(ann.id), Number(ben.id)].sort(),
    'everybody but the one who moved it, despite the earlier notice under the same settling');
  assert.equal(heard[0].payload.was, 'מחר ב־18:00');
  assert.match(instructionFor({ kind: 'meeting_time_set', payload: heard[0].payload }), /changed the time of/);
  assert.equal((await rows('meeting_reopened', id)).length, 0, 'nobody is asked again');

  // A move nobody has heard yet is replaced by the next one, not said first.
  assert.ok((await call('propose_meeting_slot', ann, {
    meeting_id: id, slot_description: 'מחר ב־16:00', starts_at: tomorrowAt('16') })).ok);
  const toBen = (await rows('meeting_time_set', id)).filter((r) => Number(r.user_id) === Number(ben.id));
  assert.deepEqual(toBen.map((r) => [r.payload.slot, r.hold_reason]),
    [['מחר ב־17:00', 'superseded'], ['מחר ב־16:00', null]]);

  // A different day is still a different meeting.
  const otherDay = await call('propose_meeting_slot', ben, {
    meeting_id: id, slot_description: 'מחרתיים ב־17:00', starts_at: tomorrowAt('17', 2) });
  assert.equal(otherDay.error.reason, 'other_day');
});

test('a coordination a room started asks nobody privately — the room is asked', async () => {
  const { id, opt } = await openWith({ allDay: true });
  const { rows: [g] } = await db.pool.query(
    `INSERT INTO chat_groups (external_id, subject, state) VALUES ('120363000000000001@g.us', 'חוף', 'open') RETURNING id`);
  await db.pool.query('UPDATE meetings SET group_id = $2 WHERE id = $1', [id, g.id]);
  const res = await call('settle_meeting', ann, { meeting_id: id, option_id: opt.id });
  assert.doesNotMatch(res.data.hint, /exact time/);
  assert.ok((await rows('meeting_confirmed', id)).every((r) => !r.payload.askExactTime));
});
