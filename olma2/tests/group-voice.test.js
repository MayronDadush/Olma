'use strict';
// The three sentences a room hears without asking. Most of what matters here
// is what it does NOT say: not twice, not about a plan that is already set,
// not at two in the morning, and not to somebody who answered and said no.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupVoice = require('../src/domain/group-voice');
const options = require('../src/domain/meeting-options');
const groupsJob = require('../src/jobs/groups');
const groupOutbox = require('../src/domain/group-outbox');
const flags = require('../src/domain/flags');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// Since migration 055 a line is DECIDED in one pass and DELIVERED by another,
// so a line this file's earlier tests decided and the hour then held is still
// owed when a later test drains the queue at a daytime `now` — and it goes out
// into that test's recorder, about another test's room. Two chase lines
// arrived in the middle of the reminder story that way. Each test's story is
// its own room and its own queue.
beforeEach(async () => {
  await db.pool.query(`DELETE FROM group_outbox WHERE sent_at IS NULL`);
});

const JID = (n) => `12036322222222${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);

async function room(n, { subject = 'פאדל' } = {}) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726077${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: JID(n), subject, members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`, [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people };
}

// A pass with a recording sender, at an hour inside the group's window.
// Both halves, in brokerd's order: the sweep decides and writes a row, the
// sender drains it (migration 055). What the room HEARS is `sent`.
//
// `onlyJid` keeps a test's `sent` array to its OWN room. Every room every
// earlier test in this file built is still in the database, and this sweep
// visits all of them: a pass told a `now` far enough ahead makes those older
// coordinations due for their chase line, which then lands in this test's
// array and is counted as one of its own messages. That is not flakiness — the
// sweep is behaving correctly and the collection was too wide.
async function pass(sent, at = null, onlyJid = null) {
  const now = at || (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();
  const decided = await withTx(db.pool, (c) => groupsJob.sweepGroupVoice(c, { now }));
  const drained = await groupOutbox.drainOnce(db.pool, {
    now,
    // No channel restart in flight — see group-sweep.test.js's `pass`.
    channelWrittenAt: () => null,
    send: async (jid, body) => {
      if (!onlyJid || jid === onlyJid) sent.push({ jid, body });
      return 'sent';
    },
  });
  return { ...decided, ...drained };
}

// The room may say that people have not answered only once she has actually
// written to them (`group-meetings.statusOf`'s `asked`, 2026-09-22), and the
// outbox worker is what makes that true. No worker runs in this file, so a test
// about what the room SAYS marks this coordination's invites delivered by hand
// — which is also the state production is in by the time a base or a chase line
// is due.
async function deliverInvites(meetingId) {
  await db.pool.query(
    `UPDATE outbox SET sent_at = coalesce(sent_at, now()), hold_reason = NULL, release_after = NULL
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1`, [meetingId]);
}

test('a room hears "there is a direction" once, when two people can make the same time', async () => {
  const { group, people } = await room(1);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('שלישי', { hours: 72 });

  await deliverInvites(meetingId);
  // Since 2026-09-22 the room hears that she has STARTED before it hears
  // anything else, so that line is spent here with a real pass rather than
  // stamped by hand — a fixture that writes the column cannot notice the column
  // is only ever reached this way.
  const opening = [];
  await pass(opening, null, group.external_id);
  assert.equal(opening.length, 1);
  assert.match(opening[0].body, /מתחילה לתאם \*פאדל\*/);

  // One yes — the proposer's own — is not a direction.
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'שלישי 20:00', when)).data.option.id);
  let sent = [];
  await pass(sent, null, group.external_id);
  assert.deepEqual(sent, [], 'one person agreeing with themselves is not news');

  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /יש כיוון/);
  assert.match(sent[0].body, /שלישי 20:00/);
  assert.equal(sent[0].jid, group.external_id);

  // Said once, ever, for this coordination.
  sent = [];
  await pass(sent, null, group.external_id);
  assert.deepEqual(sent, [], 'the second pass has nothing new to say');
});

test('the base of a game is its own minimum, not two people', async () => {
  const { group, people } = await room(2);
  const [a, b, c3] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'game', min: 3 }, a.id));
  const when = slotStart('רביעי', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'רביעי 20:00', when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  // Spend the opening line first — see the test above.
  await pass([], null, group.external_id);

  let sent = [];
  await pass(sent, null, group.external_id);
  assert.deepEqual(sent, [], 'two of the three this game needs is not a base');

  // The third yes reaches the game's minimum — and, in a room of three, is
  // also everybody. That is not a base to announce (there is nobody left to
  // wait for, and the settle minute is running): the room's next line is
  // "סגור", once the minute is out (owner, 2026-09-20; "מחכה ל 🤞" to an
  // empty list is what this replaced).
  await withTx(db.pool, (c) => options.answer(c, c3.id, meetingId, optionId, 'y'));
  sent = [];
  await pass(sent, null, group.external_id);
  assert.deepEqual(sent, [], 'unanimous: no base line for nobody');
  await db.pool.query(`UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [meetingId]);
  await withTx(db.pool, (c) => options.settleDue(c));
  sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /סגור: \*רביעי 20:00\* 🎉 כולם בפנים/);
});

test('a settled coordination is announced, and nothing else about it is', async () => {
  const { group, people } = await room(3);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'ארוחה'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('חמישי', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'חמישי 19:00', when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  const fresh = await withTx(db.pool, (c) => groups.getById(c, group.id));
  await withTx(db.pool, (c) => groupMeetings.settle(c, fresh, a, optionId));

  const sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1, 'one line, not "there is a direction" and "it is set"');
  assert.match(sent[0].body, /סגור/);
  assert.match(sent[0].body, /חמישי 19:00/);
  // Who can make it (owner, 2026-09-20): a and b said yes, the third never
  // answered — so the two are tagged, and "כולם" is not said.
  assert.match(sent[0].body, new RegExp(`בפנים: @${a.phone.replace('+', '\\+')} @${b.phone.replace('+', '\\+')}`));
  assert.doesNotMatch(sent[0].body, /כולם/);
  // Nobody said where: the done line asks, once, in the same message.
  assert.match(sent[0].body, /איפה נפגשים\? תכתבו לי ואני אוסיף ליומן/);

  const after2 = [];
  await pass(after2);
  assert.deepEqual(after2, []);

  // A shared calendar event appears (only createSharedMeetingEvent writes
  // this column): the room hears it once, and never a second time.
  await db.pool.query(`UPDATE meetings SET calendar_event_id = 'evt_1' WHERE id = $1`, [meetingId]);
  const cal = [];
  await pass(cal, null, group.external_id);
  assert.equal(cal.length, 1);
  assert.match(cal[0].body, /📅 ביומן/);
  assert.match(cal[0].body, /מי שחיבר יומן קיבל הזמנה/);
  const again = [];
  await pass(again, null, group.external_id);
  assert.deepEqual(again, []);
});

test('when everybody said yes the done line says so, and no calendar line without a shared event', async () => {
  const { group, people } = await room(11);
  const [a, b, c] = people;
  const started = await withTx(db.pool, (c2) => groupMeetings.startCoordination(c2, group, a, 'ערב משחקים', { where: 'אצל דני' }));
  assert.equal(started.data.meeting.location, 'אצל דני', 'the place the room said, on the meeting');
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('בערב', { hours: 96 });
  const optionId = await withTx(db.pool, async (c2) =>
    (await options.add(c2, a.id, meetingId, 'בערב אצל דני', when)).data.option.id);
  await withTx(db.pool, (c2) => options.answer(c2, b.id, meetingId, optionId, 'y'));
  await withTx(db.pool, (c2) => options.answer(c2, c.id, meetingId, optionId, 'y'));
  // Unanimity arms the minute; run it out so the sweep sees `confirmed`.
  await db.pool.query(`UPDATE meetings SET settle_due_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [meetingId]);
  await withTx(db.pool, (c2) => options.settleDue(c2));

  const sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.match(sent[0].body, /סגור: \*בערב אצל דני\* 🎉 כולם בפנים/);
  assert.doesNotMatch(sent[0].body, /איפה נפגשים/, 'the room already said where');
  const nothing = [];
  await pass(nothing, null, group.external_id);
  assert.deepEqual(nothing, [], 'no calendar event, no calendar line');
});

// "מחכה ל 🤞" went out to nobody: Yuval's yes made it unanimous, the settle
// minute was running, and the base line named an empty list twelve seconds
// later (coordination 37, 2026-09-20). Pure: the decision, not the sweep.
test('no base line for nobody — everybody agreed, or the settle minute is already running', () => {
  const p = (n) => ({ name: `p${n}`, phone: `+97250000000${n}`, tag: `@+97250000000${n}` });
  const co = (over) => ({
    status: 'negotiating', participants: 2, silent: [], settleDueAt: null,
    options: [{ optionId: 1, slot: 'שישי בבוקר', startsAt: new Date(Date.now() + 86400e3).toISOString(),
      yes: [p(1), p(2)], no: [], missing: [], quorum: { known: false } }],
    ...over,
  });
  assert.equal(groupVoice.decideGroupLine(co(), { saidStarted: true, nowMs: Date.now() }).kind, 'none', 'nobody to wait for');
  const three = co({ participants: 3, options: [{ ...co().options[0], missing: [p(3)] }] });
  assert.equal(groupVoice.decideGroupLine(three, { saidStarted: true, nowMs: Date.now() }).kind, 'base', 'somebody still owed');
  assert.equal(groupVoice.decideGroupLine({ ...three, settleDueAt: new Date().toISOString() }, { saidStarted: true, nowMs: Date.now() }).kind, 'none',
    'the minute is running — the next thing the room hears is סגור');
  // whoIsIn: all, some, unknown.
  assert.deepEqual(groupVoice.whoIsIn({ participants: 2, confirmedOption: { yes: [p(1), p(2)] } }), { all: true, phones: [] });
  assert.deepEqual(groupVoice.whoIsIn({ participants: 3, confirmedOption: { yes: [p(1)] } }), { all: false, phones: ['+972500000001'] });
  assert.equal(groupVoice.whoIsIn({ participants: 3, confirmedOption: null }), null);
});

test('nothing proactive goes out in the middle of the night', async () => {
  const { group, people } = await room(4);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('שלישי', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'שלישי 20:00', when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  await deliverInvites(meetingId);

  const night = new Date();
  night.setUTCHours(1, 0, 0, 0);
  const sent = [];
  const held = await pass(sent, night, group.external_id);
  assert.deepEqual(sent, []);
  assert.equal(held.held, 1, 'held, not dropped — nothing was stamped');

  const morning = [];
  await pass(morning);
  assert.equal(morning.length, 1, 'and it goes out in the morning');
});

// The 01:12 line. Group "5 Percent (Maprinter)" heard about its coordination
// at 01:12 local on 2026-09-08 with the window supposedly shut, because
// `mayAnnounce` took its grace from `chat_groups.last_mention_at` — a column
// the sweep rewrites on every pass (a room has several gateway sessions and
// one watermark column), and which Olma's own sends move, since the raw pipe
// speaks as `main`. Fresh here, exactly as it was that night; nobody has
// written in the room; the line still waits for the morning.
test('a stamp Olma herself moved does not open the room at night', async () => {
  const { group, people } = await room(9);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('שלישי', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'שלישי 20:00', when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  await deliverInvites(meetingId);

  const night = new Date();
  night.setUTCHours(1, 0, 0, 0);
  // What the broken sweep left behind: a mention stamped a minute ago, and a
  // room whose people last spoke in the evening.
  await db.pool.query(`UPDATE chat_groups SET last_mention_at = $2 WHERE id = $1`,
    [group.id, new Date(night.getTime() - 60_000)]);
  await db.pool.query(
    `UPDATE chat_group_members SET last_wrote_at = $2 WHERE group_id = $1`,
    [group.id, new Date(night.getTime() - 7 * 3600_000)]);

  const sent = [];
  const held = await pass(sent, night, group.external_id);
  assert.deepEqual(sent, [], 'nobody in the room is awake, whatever her own sessions say');
  // `held` counts every room in the pass, and every earlier test in this file
  // left a live coordination behind — the same too-wide collection the comment
  // on `pass` is about. What this test owns is THIS meeting: held means nothing
  // was stamped, which is what makes the morning possible.
  assert.ok(held.held >= 1, 'due, and held rather than sent');
  const { rows: stamps } = await db.pool.query(
    `SELECT group_started_at, group_base_at FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(stamps[0].group_started_at, null, 'nothing stamped, so nothing is lost');
  assert.equal(stamps[0].group_base_at, null);

  const morning = [];
  await pass(morning, null, group.external_id);
  assert.equal(morning.length, 1, 'and it goes out in the morning');
  assert.match(morning[0].body, /מתחילה לתאם/, 'the first thing the room hears, one line per pass');
});

// The other half of the same rule: somebody IS in the room, so she is not
// holding an answer at a person standing right there.
test('a member who wrote a minute ago opens the room, at any hour', async () => {
  const { group, people } = await room(10);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('שלישי', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'שלישי 20:00', when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  await deliverInvites(meetingId);

  const night = new Date();
  night.setUTCHours(1, 0, 0, 0);
  await db.pool.query(
    `UPDATE chat_group_members SET last_wrote_at = $2 WHERE group_id = $1 AND phone = $3`,
    [group.id, new Date(night.getTime() - 60_000), b.phone]);

  const sent = [];
  await pass(sent, night, group.external_id);
  assert.equal(sent.length, 1);
});

test('the chase names only the people who answered nothing at all', () => {
  // Pure, because "has this gone quiet" must be answerable without a room, a
  // gateway or an hour of the day.
  const co = {
    status: 'negotiating',
    options: [{ optionId: 1, slot: 'שלישי', startsAt: new Date(Date.now() + 86400_000).toISOString(),
      yes: [{ phone: '+972500000001' }], no: [{ phone: '+972500000002' }],
      missing: [{ phone: '+972500000003' }], quorum: { known: false } }],
    silent: [{ phone: '+972500000003' }],
  };
  // A day and a bit in, with the thing itself tomorrow: past half the
  // distance, and past the 24-hour ceiling on waiting.
  const started = Date.now() - 30 * 3600_000;
  const line = groupVoice.decideGroupLine(co, { saidStarted: true, saidBase: true, saidChase: false, saidDone: false,
    startedAtMs: started, nowMs: Date.now() });
  assert.equal(line.kind, 'chase');
  assert.deepEqual(line.missing, ['+972500000003'],
    'somebody who said no has answered — chasing them is asking them to change their mind in public');

  // Too early: half the distance to the thing itself has not passed.
  const early = groupVoice.decideGroupLine(co, { saidStarted: true, saidBase: true, saidChase: false, saidDone: false,
    startedAtMs: Date.now() - 60_000, nowMs: Date.now() });
  assert.equal(early.kind, 'none');
});

test('a coordination that is already set is never chased', () => {
  const line = groupVoice.decideGroupLine(
    { status: 'confirmed', confirmedSlot: 'שלישי 20:00', options: [], silent: [{ phone: '+972500000009' }] },
    { saidBase: false, saidChase: false, saidDone: false, startedAtMs: 0, nowMs: Date.now() });
  assert.equal(line.kind, 'done');
  assert.equal(line.slot, 'שלישי 20:00');
});

test('the room is reminded on the day and an hour before, and never after it started', () => {
  const tz = 'Asia/Jerusalem';
  // 20:00 Israel time today, expressed as an instant.
  const start = new Date();
  start.setUTCHours(17, 0, 0, 0);
  const co = { status: 'confirmed', confirmedSlot: 'היום 20:00', confirmedStartAt: start.toISOString(), options: [], silent: [] };
  const base = { saidBase: true, saidChase: true, saidDone: true, startedAtMs: 0, timezone: tz };

  const morning = groupVoice.decideGroupLine(co, { ...base, nowMs: start.getTime() - 9 * 3600_000 });
  assert.equal(morning.kind, 'dayof');

  // Both due at once: the nearer one is the true one, and the day-of stamp
  // is not what stops it — the hour-before simply outranks it.
  const closer = groupVoice.decideGroupLine(co, { ...base, nowMs: start.getTime() - 40 * 60_000 });
  assert.equal(closer.kind, 'soon');

  // Yesterday: it is not today anywhere, so nothing is due.
  const dayBefore = groupVoice.decideGroupLine(co, { ...base, nowMs: start.getTime() - 30 * 3600_000 });
  assert.equal(dayBefore.kind, 'none');

  // Two hours to go and nothing said yet: the day-of line is skipped (too
  // close to be worth its own message) and the hour-before is not due, so
  // this room simply hears nothing until an hour out.
  const late = groupVoice.decideGroupLine(co, { ...base, saidDayOf: false, nowMs: start.getTime() - 2 * 3600_000 });
  assert.equal(late.kind, 'none');
  const nearly = groupVoice.decideGroupLine(co, { ...base, saidDayOf: false, nowMs: start.getTime() - 50 * 60_000 });
  assert.equal(nearly.kind, 'soon');

  // It has started. Nothing to remind anybody about.
  const after = groupVoice.decideGroupLine(co, { ...base, saidHour: true, nowMs: start.getTime() + 60_000 });
  assert.equal(after.kind, 'none');

  // A slot that never carried a moment cannot be reminded about at all.
  const undated = groupVoice.decideGroupLine(
    { ...co, confirmedStartAt: null }, { ...base, nowMs: Date.now() });
  assert.equal(undated.kind, 'none');
});

test('the reminders ride the same pass, once each, and only for this coordination', async () => {
  const { group, people } = await room(5);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  // Tomorrow, so the option is a real future moment; every pass below names
  // its own `now` relative to it.
  const at = new Date(Date.now() + 24 * 3600_000);
  at.setUTCHours(15, 0, 0, 0);
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, 'מחר 18:00', at.toISOString().replace('Z', '+00:00'))).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  const fresh = await withTx(db.pool, (c) => groups.getById(c, group.id));
  await withTx(db.pool, (c) => groupMeetings.settle(c, fresh, a, optionId));

  // This room only. The last pass below jumps `now` past the meeting, which is
  // also far enough ahead to make the coordinations OTHER tests in this file
  // left behind due for their chase — real lines, correctly sent, to other
  // rooms. Collecting them here made this assertion depend on the hour the
  // suite ran: green in CI on 2026-09-07 and red on the 08:00 clock-drift run
  // the next morning, on bytes nobody had touched.
  const sent = [];
  const mine = JID(5);
  await pass(sent, new Date(at.getTime() - 8 * 3600_000), mine);
  assert.match(sent[0].body, /סגור/, 'first it is set');
  await pass(sent, new Date(at.getTime() - 7 * 3600_000), mine);
  assert.match(sent[1].body, /היום/, 'then, on the day');
  await pass(sent, new Date(at.getTime() - 7 * 3600_000), mine);
  assert.equal(sent.length, 2, 'and not twice');
  await pass(sent, new Date(at.getTime() - 30 * 60_000), mine);
  assert.match(sent[2].body, /עוד שעה/, 'then an hour before');
  await pass(sent, new Date(at.getTime() + 60_000), mine);
  assert.equal(sent.length, 3, 'and nothing at all once it has started');
});

// "אצל יוסי" arrives in any message, before or after the time is set. Saved
// in the room's words; a shared calendar event, when one exists, gets it too.
test('the place can be said later, and a closed room has nothing to put it on', async () => {
  const { group, people } = await room(12);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פוקר'));
  const meetingId = Number(started.data.meeting.id);
  assert.equal(started.data.meeting.location, null);

  const empty = await withTx(db.pool, (c) => groupMeetings.setPlace(c, group, b, '   '));
  assert.equal(empty.ok, false);
  const set = await withTx(db.pool, (c) => groupMeetings.setPlace(c, group, b, '  אצל  יוסי '));
  assert.equal(set.ok, true, JSON.stringify(set.error));
  assert.deepEqual([set.data.location, set.data.calendarUpdated, set.data.status], ['אצל יוסי', false, 'negotiating']);
  const row = (await db.pool.query(`SELECT location FROM meetings WHERE id = $1`, [meetingId])).rows[0];
  assert.equal(row.location, 'אצל יוסי');
  const audit = await db.pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND event = 'meeting.place_set'`, [b.id]);
  assert.equal(audit.rows[0].n, 1);

  // A stranger to the room cannot set it.
  const outsider = await makeUser(db.pool, '+972607120099', { firstName: 'זר' });
  const no = await withTx(db.pool, (c) => groupMeetings.setPlace(c, group, outsider, 'אצלי'));
  assert.equal(no.ok, false);

  await db.pool.query(`UPDATE meetings SET status = 'cancelled' WHERE id = $1`, [meetingId]);
  const gone = await withTx(db.pool, (c) => groupMeetings.setPlace(c, group, a, 'בבית קפה'));
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'not_found');
});

// The owner, 2026-09-22, after the room chased two people nobody had written
// to: she may say that people are not answering only once she has tried.
test('neither room line names somebody the coordination never reached', () => {
  const soon = new Date(Date.now() + 86400_000).toISOString();
  const asked = { phone: '+972500000021', asked: true };
  const never = { phone: '+972500000022', asked: false };
  const co = {
    status: 'negotiating',
    options: [{ optionId: 1, slot: 'שלישי', startsAt: soon,
      yes: [{ phone: '+972500000023', asked: true }, { phone: '+972500000024', asked: true }],
      no: [], missing: [asked, never], quorum: { known: false } }],
    silent: [asked, never],
    settleDueAt: null,
  };
  const at = { startedAtMs: Date.now() - 30 * 3600_000, nowMs: Date.now() };

  const base = groupVoice.decideGroupLine(co, { saidStarted: true, saidBase: false, saidChase: true, saidDone: false, ...at });
  assert.equal(base.kind, 'base');
  assert.deepEqual(base.missing, [asked.phone], 'the base waits out loud only for somebody who was asked');

  const chase = groupVoice.decideGroupLine(co, { saidStarted: true, saidBase: true, saidChase: false, saidDone: false, ...at });
  assert.equal(chase.kind, 'chase');
  assert.deepEqual(chase.missing, [asked.phone]);

  // Nobody reached yet: there is no true sentence about people not answering,
  // so the room hears nothing at all rather than a line with no tags in it.
  const noneReached = { ...co, options: [{ ...co.options[0], missing: [never], yes: [{ phone: '+972500000023', asked: true }] }], silent: [never] };
  const quiet = groupVoice.decideGroupLine(noneReached, { saidStarted: true, saidBase: false, saidChase: false, saidDone: false, ...at });
  assert.equal(quiet.kind, 'none');
});


// ── the room hears that she has started ─────────────────────────────────────
// Owner, 2026-09-22: "תכתוב בקבוצה שאתה מתחיל בתיאום בפרטי עם מי שכתב לה". Until
// this line existed the first thing a room heard about its own coordination was
// `base` — which waits for two people to agree on a time, hours later — so a
// room that had just asked her for something heard nothing at all.
test('the first line a room hears is that she has started asking, and it counts people not names', async () => {
  const { group, people } = await room(40);
  const [a] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל השבוע'));
  const meetingId = Number(started.data.meeting.id);

  const sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /מתחילה לתאם \*פאדל השבוע\*/);
  assert.match(sent[0].body, /שאלתי בפרטי 3 מכם/, 'the three who have written');
  // Nobody is named and nobody is tagged: who is missing is the gate notice's
  // sentence, and this room has nobody missing anyway.
  assert.equal(/@\+?\d/.test(sent[0].body), false, 'no tags in this line, ever');
  for (const p of people) assert.equal(sent[0].body.includes(p.first_name || '—'), false);
  assert.equal(/לא נספר/.test(sent[0].body), false, 'everybody here has written, so no note about it');

  // Once, ever.
  const again = [];
  await pass(again, null, group.external_id);
  assert.deepEqual(again, [], 'said once per coordination');
  const { rows } = await db.pool.query(
    `SELECT group_started_at FROM meetings WHERE id = $1`, [meetingId]);
  assert.ok(rows[0].group_started_at);
});

// The other half: a room the `group_open_without_everyone` switch opened has
// members who never wrote, and the line says such people exist WITHOUT naming
// them — the room already heard who they are from the gate.
// ── one sentence somebody actually asked for ────────────────────────────────

test('a sentence a member asked the room to hear comes before anything she decided to say', () => {
  const when = new Date(Date.now() + 72 * 3600_000).toISOString();
  const co = {
    status: 'negotiating', title: 'פאדל', participants: 3,
    options: [{ slot: 'שלישי 20:00', startsAt: when, yes: [{}, {}], no: [], missing: [{ phone: '+972500000003', asked: true }] }],
    silent: [],
  };
  const withRelay = groupVoice.decideGroupLine(co, {
    saidStarted: true, nowMs: Date.now(), startedAtMs: Date.now(),
    pendingRelay: { userId: 7, phone: '+972500000001', what: 'ב-4 קצת חם' },
  });
  assert.equal(withRelay.kind, 'relay');
  assert.equal(withRelay.userId, 7);
  assert.equal(withRelay.what, 'ב-4 קצת חם');
  // The base is still owed, and is said on the next pass — one line per pass.
  const without = groupVoice.decideGroupLine(co, {
    saidStarted: true, nowMs: Date.now(), startedAtMs: Date.now(),
  });
  assert.equal(without.kind, 'base');

  // But never in front of "she has started": the room has to know what this is
  // about before it is handed somebody's sentence about it.
  const opening = groupVoice.decideGroupLine(co, {
    nowMs: Date.now(), startedAtMs: Date.now(),
    pendingRelay: { userId: 7, phone: '+972500000001', what: 'ב-4 קצת חם' },
  });
  assert.equal(opening.kind, 'started');

  // And a half-written one says nothing rather than an empty quote.
  assert.equal(groupVoice.decideGroupLine(co, {
    saidStarted: true, nowMs: Date.now(), startedAtMs: Date.now(),
    pendingRelay: { userId: 7, phone: '+972500000001', what: '' },
  }).kind, 'base');
});

test('the room hears it in their words, over their tag, once', async () => {
  const { group, people } = await room(15);
  const [a, b] = people;
  await withTx(db.pool, (c) => flags.setFlag(c, groupMeetings.RELAY_FLAG, group.external_id));
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  // Spend the opening line first — it is the one that comes before this.
  const opening = [];
  await pass(opening, null, group.external_id);
  assert.equal(opening.length, 1);

  const asked = await withTx(db.pool, (c) => groupMeetings.relayToRoom(c, b.id, meetingId, 'ב-4 קצת חם'));
  assert.equal(asked.ok, true, asked.ok ? '' : JSON.stringify(asked.error));

  const sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, `📣 מ@${b.phone}: ״ב-4 קצת חם״`);
  // Their TAG, never their name — the rule every room line obeys.
  assert.equal(sent[0].body.includes(b.first_name), false);

  const again = [];
  await pass(again, null, group.external_id);
  assert.deepEqual(again, [], 'said once, and the next pass is back to her own lines');
  const { rows } = await db.pool.query(
    `SELECT relay_said_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, b.id]);
  assert.ok(rows[0].relay_said_at);
});

test('a room with members who never wrote is told they are not counted, without a name or a tag', async () => {
  const { group, people } = await room(41);
  const [a] = people;
  // Somebody joins who has never written to her — the Padel Gang shape.
  await withTx(db.pool, (c) => groups.syncRoster(c, group.id, [
    ...people.map((u) => ({ phone: u.phone })),
    { phone: '+972609990041', displayName: 'חדש' },
  ]));
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  assert.equal(started.ok, true);

  const sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /שאלתי בפרטי 3 מכם/, 'the three she can reach, not the four in the room');
  assert.match(sent[0].body, /לא נספר/, 'and that somebody here is not counted');
  assert.equal(sent[0].body.includes('חדש'), false, 'never by name');
  assert.equal(sent[0].body.includes('972609990041'), false, 'and never by number');
});
