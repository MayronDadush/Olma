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
    send: async (jid, body) => {
      if (!onlyJid || jid === onlyJid) sent.push({ jid, body });
      return 'sent';
    },
  });
  return { ...decided, ...drained };
}

test('a room hears "there is a direction" once, when two people can make the same time', async () => {
  const { group, people } = await room(1);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('שלישי', { hours: 72 });

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

  let sent = [];
  await pass(sent, null, group.external_id);
  assert.deepEqual(sent, [], 'two of the three this game needs is not a base');

  await withTx(db.pool, (c) => options.answer(c, c3.id, meetingId, optionId, 'y'));
  sent = [];
  await pass(sent, null, group.external_id);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /יש כיוון/);
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

  const after2 = [];
  await pass(after2);
  assert.deepEqual(after2, []);
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
  assert.equal(held.held, 1);

  const morning = [];
  await pass(morning, null, group.external_id);
  assert.equal(morning.length, 1, 'and it goes out in the morning');
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
  const line = groupVoice.decideGroupLine(co, { saidBase: true, saidChase: false, saidDone: false,
    startedAtMs: started, nowMs: Date.now() });
  assert.equal(line.kind, 'chase');
  assert.deepEqual(line.missing, ['+972500000003'],
    'somebody who said no has answered — chasing them is asking them to change their mind in public');

  // Too early: half the distance to the thing itself has not passed.
  const early = groupVoice.decideGroupLine(co, { saidBase: true, saidChase: false, saidDone: false,
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
