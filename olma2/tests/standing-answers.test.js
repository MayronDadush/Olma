'use strict';
// An answer somebody gave before the time it answers existed (owner,
// 2026-09-28). The founding case is Padel Gang's coordination 57: גיא said he
// could not make it that week before any time was up, and was asked about every
// time that followed; מירון said any evening from 18:00, and none of the times
// after 18:00 carried his yes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const fanout = require('../src/domain/meeting-fanout');
const standing = require('../src/domain/standing-answers');
const opts = meetings.options;

// Every moment here is on UTC and computed ONCE, relative to now, so nothing
// depends on the hour or the weekday the suite runs.
const DAY = 24 * 3600_000;
const dayStart = (() => { const d = new Date(Date.now() + 2 * DAY); d.setUTCHours(0, 0, 0, 0); return d.getTime(); })();
const iso = (ms) => new Date(ms).toISOString();
const at = (days, hour) => iso(dayStart + days * DAY + hour * 3600_000);
const WEEK = { from: iso(dayStart - DAY), to: iso(dayStart + 6 * DAY) };

// ---- the pure half -------------------------------------------------------------

test('a window keeps what it can prove and drops the rest, by name', () => {
  assert.deepEqual(standing.validWindow({ answer: 'n', ...WEEK }).window, { answer: 'n', ...WEEK });
  assert.match(standing.validWindow({ answer: 'maybe', ...WEEK }).reason, /y or n/);
  assert.match(standing.validWindow({ answer: 'y', from: '2026-10-01T18:00:00', to: WEEK.to }).reason, /offset/,
    'a time crossing the tool boundary needs its offset');
  assert.match(standing.validWindow({ answer: 'y', from: WEEK.to, to: WEEK.from }).reason, /after/);
  assert.match(standing.validWindow({ answer: 'y', from: WEEK.from, to: iso(dayStart + 30 * DAY) }).reason, /preference/,
    'a month is a standing rule about their life, not an answer about one meeting');
  assert.match(standing.validWindow({ answer: 'y', ...WEEK, after: '6pm' }).reason, /HH:MM/);
  assert.match(standing.validWindow({ answer: 'y', ...WEEK, days: [7] }).reason, /0 \(Sunday\) to 6/);
});

test('a window covers a time on THEIR clock, inside its hours and days, never a whole day', () => {
  const evenings = { answer: 'y', ...WEEK, after: '18:00' };
  assert.equal(standing.covers(evenings, { startsAt: at(1, 19) }, 'Etc/UTC'), true);
  assert.equal(standing.covers(evenings, { startsAt: at(1, 12) }, 'Etc/UTC'), false, 'noon is not an evening');
  assert.equal(standing.covers(evenings, { startsAt: at(1, 10) }, 'Asia/Tokyo'), true,
    '10:00 UTC is 19:00 in Tokyo: an evening on THEIR clock');
  assert.equal(standing.covers(evenings, { startsAt: at(1, 19) }, 'Asia/Tokyo'), false,
    '19:00 UTC is 04:00 in Tokyo: not an evening, whatever it is in London');
  assert.equal(standing.covers(evenings, { startsAt: at(9, 19) }, 'Etc/UTC'), false, 'outside the week');
  assert.equal(standing.covers(evenings, { startsAt: at(1, 19), allDay: true }, 'Etc/UTC'), false,
    'a whole day sits on a stand-in hour no window can judge');
  const day = new Date(at(1, 19)).getUTCDay();
  assert.equal(standing.covers({ ...evenings, days: [day] }, { startsAt: at(1, 19) }, 'Etc/UTC'), true);
  assert.equal(standing.covers({ ...evenings, days: [(day + 1) % 7] }, { startsAt: at(1, 19) }, 'Etc/UTC'), false);
});

test('the most recently SAID window wins, and carries the words it came from', () => {
  const said = [
    { text: 'כל ערב מ-18', windows: [{ answer: 'y', ...WEEK, after: '18:00' }] },
    { text: 'דווקא ביום הזה לא', windows: [{ answer: 'n', from: at(1, 0), to: at(2, 0) }] },
  ];
  assert.deepEqual(standing.verdictFor(said, { startsAt: at(1, 19) }, 'Etc/UTC'), { answer: 'n', because: 'דווקא ביום הזה לא' });
  assert.deepEqual(standing.verdictFor(said, { startsAt: at(3, 19) }, 'Etc/UTC'), { answer: 'y', because: 'כל ערב מ-18' });
  assert.equal(standing.verdictFor(said, { startsAt: at(3, 10) }, 'Etc/UTC'), null, 'nothing said about a morning');
});

// ---- through the database ------------------------------------------------------

let db, miron, yuval, guy, sharon;
before(async () => {
  db = await freshDb();
  miron = await makeUser(db.pool, '+972534000001', { firstName: 'מירון' });
  yuval = await makeUser(db.pool, '+972534000002', { firstName: 'יובל' });
  guy = await makeUser(db.pool, '+972534000003', { firstName: 'גיא' });
  sharon = await makeUser(db.pool, '+972534000004', { firstName: 'שרון' });
  const people = [miron, yuval, guy, sharon];
  await db.pool.query(`UPDATE users SET timezone = 'Etc/UTC' WHERE id = ANY($1)`, [people.map((u) => u.id)]);
  const c = await db.pool.connect();
  try {
    for (let i = 0; i < people.length; i++) {
      for (let j = i + 1; j < people.length; j++) {
        const req = await connections.requestConnection(c, people[i].id, people[j].phone, {});
        const conn = (await connections.respondToConnection(c, people[j].id, req.data.connection.id, 'approve')).data.connection;
        await grants.grantFeature(c, people[i].id, conn.id, 'meetings');
        await grants.grantFeature(c, people[j].id, conn.id, 'meetings');
      }
    }
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}
async function answerOf(optionId, userId) {
  const { rows } = await db.pool.query(
    'SELECT answer FROM meeting_option_answers WHERE option_id = $1 AND user_id = $2', [optionId, userId]);
  return rows[0] ? rows[0].answer : null;
}
async function rowsFor(userId, meetingId) {
  const { rows } = await db.pool.query(
    `SELECT kind, payload FROM outbox WHERE user_id = $1 AND (payload->>'meetingId')::bigint = $2 ORDER BY id`, [userId, meetingId]);
  return rows;
}
// A time goes on the table the way every door puts one there: add, then the fan-out.
async function addTime(c, who, meetingId, slot, startsAt) {
  const res = await opts.add(c, who.id, meetingId, slot, startsAt);
  assert.ok(res.ok, JSON.stringify(res));
  await fanout.afterOptionAdded(c, who, meetingId, res);
  return res.data.option.id;
}

test('coordination 57: a time put up later is answered for whoever already answered it, and they are TOLD', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, miron.id, 'פאדל', [yuval.id, guy.id, sharon.id])).data.meeting.id);
    await meetings.recordConstraint(c, guy.id, m, 'לא יכול השבוע — טס לחול', false,
      { windows: [{ answer: 'n', ...WEEK }] });
    await meetings.recordConstraint(c, miron.id, m, 'אני יכול כל יום השבוע מ18 בערב', false,
      { windows: [{ answer: 'y', ...WEEK, after: '18:00' }] });

    const evening = await addTime(c, yuval, m, 'option A 19:00', at(1, 19));
    assert.equal(await answerOf(evening, guy.id), 'n', 'abroad all week: declined, not asked');
    assert.equal(await answerOf(evening, miron.id), 'y', 'any evening from 18: a yes');
    assert.equal(await answerOf(evening, sharon.id), null, 'said nothing: still asked');

    const kindsOf = async (u) => (await rowsFor(u.id, m)).map((r) => r.kind);
    assert.ok((await kindsOf(sharon)).some((k) => k === 'meeting_slot_proposed' || k === 'meeting_invite'), 'Sharon is asked');
    assert.ok(!(await kindsOf(guy)).includes('meeting_slot_proposed'), 'Guy is not asked about a time he answered');
    const notice = (await rowsFor(guy.id, m)).find((r) => r.kind === 'meeting_auto_answered');
    assert.ok(notice, 'and he is told privately what was marked');
    assert.deepEqual(notice.payload.answers.map((x) => [x.answer, x.because]), [['n', 'לא יכול השבוע — טס לחול']]);

    // A morning is outside Miron's window: he is asked about it like anybody.
    const noon = await addTime(c, yuval, m, 'option B 12:00', at(2, 12));
    assert.equal(await answerOf(noon, miron.id), null);
    assert.equal(await answerOf(noon, guy.id), 'n');

    // A burst is ONE notice: Guy's second answer joined the unsent row.
    const notices = (await rowsFor(guy.id, m)).filter((r) => r.kind === 'meeting_auto_answered');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].payload.answers.length, 2);

    const { rows: trail } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE event = 'meeting.auto_answered' AND (detail->>'meetingId')::bigint = $1`, [m]);
    assert.equal(trail[0].n, 3, 'every automatic answer is on the trail, where it can be measured');
  });
});

test('their own word on a time beats a window, and a whole day is never answered for them', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, miron.id, 'ערב', [yuval.id, guy.id])).data.meeting.id);
    const first = await addTime(c, miron, m, 'option C 20:00', at(1, 20));
    await opts.answer(c, guy.id, m, first, 'y');
    await meetings.recordConstraint(c, guy.id, m, 'השבוע לא', false, { windows: [{ answer: 'n', ...WEEK }] });
    await standing.applyToTable(c, m, guy.id);
    assert.equal(await answerOf(first, guy.id), 'y', 'he said yes to this one himself');

    const res = await opts.add(c, miron.id, m, 'option D all day', at(2, 9), { allDay: true });
    assert.ok(res.ok, JSON.stringify(res));
    await fanout.afterOptionAdded(c, miron, m, res);
    assert.equal(await answerOf(res.data.option.id, guy.id), null);
  });
});

test('the same sentence said again keeps the window the first copy carried', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, miron.id, 'חוזר', [guy.id])).data.meeting.id);
    await meetings.recordConstraint(c, guy.id, m, 'השבוע לא', false, { windows: [{ answer: 'n', ...WEEK }] });
    await meetings.recordConstraint(c, guy.id, m, 'השבוע לא');
    const { rows } = await c.query(
      `SELECT constraints FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [m, guy.id]);
    assert.equal(rows[0].constraints.length, 1);
    assert.deepEqual(rows[0].constraints[0].windows, [{ answer: 'n', ...WEEK }]);
  });
});

test('said with times already up, the window answers them at once, and the RESULT says so', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, miron.id, 'ריצה', [yuval.id, sharon.id])).data.meeting.id);
    const evening = await addTime(c, miron, m, 'option E 19:30', at(3, 19.5));
    const morning = await addTime(c, miron, m, 'option F 08:00', at(3, 8));
    const tool = require('../src/adapters/mcp/tools/meetings').find((t) => t.name === 'record_meeting_constraint');
    const out = await tool.handler(c, sharon, {
      meeting_id: m, constraint: 'רק בערבים השבוע',
      windows: [{ answer: 'y', ...WEEK, after: '18:00' }, { answer: 'n', ...WEEK, before: '12:00' }],
    });
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepEqual(out.data.autoAnswered.map((x) => [x.optionId, x.answer]).sort(), [[evening, 'y'], [morning, 'n']].sort());
    assert.match(out.data.hints.autoAnswered, /ONE clause/);
    assert.equal((await rowsFor(sharon.id, m)).filter((r) => r.kind === 'meeting_auto_answered').length, 0,
      'she is in the conversation: told in the reply, not queued a second message');
  });
});
