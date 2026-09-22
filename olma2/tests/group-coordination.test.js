'use strict';
// The room asks for something, and the asking moves into everybody's private
// chat. What is being tested here is mostly what does NOT travel: no pairwise
// grant is needed inside a room, and no reason anybody gave in private is
// readable from it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const { instructionFor } = require('../src/channels/openclaw');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036311111111${n}@g.us`;
// Padded, so room(1) and room(11) cannot mint the same token.
// And `room(n)` and `roomWithAGreeterJoiner(n)` SHARE this space — both mint
// JID(n) and TOKEN(n) — so a number is spoken for whichever helper took it.
// Reusing one registers a second room on the same jid and every later call
// answers "that person is not a member of this group", which reads as a
// broken membership check rather than a collided fixture.
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);

async function openGroup(client, { jid, members, token, subject }) {
  const reg = await groups.registerGroup(client, { externalId: jid, members, subject });
  assert.ok(reg.ok, 'the fixture group registered');
  const { rows } = await client.query(
    `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
      WHERE id = $1 RETURNING *`,
    [reg.data.group.id, `g-${reg.data.group.id}`, token]);
  return rows[0];
}

// Three people who have all written to her privately — an open room — and who
// are NOT connected to each other in any way.
async function room(n, { subject = 'פאדל חמישי' } = {}) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726055${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(n), subject, token: TOKEN(n),
    members: people.map((u) => ({ phone: u.phone })),
  }));
  return { group, people };
}

test('a room coordinates without anybody being connected to anybody', async () => {
  const { group, people } = await room(1);
  const [asked] = people;

  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, asked, 'פאדל השבוע'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.created, true);
  assert.equal(res.data.participants, 3);

  const { rows } = await db.pool.query(
    `SELECT group_id, initiator_id, title FROM meetings WHERE id = $1`, [res.data.meeting.id]);
  assert.equal(Number(rows[0].group_id), Number(group.id), 'the coordination belongs to the room');
  assert.equal(Number(rows[0].initiator_id), Number(asked.id), 'and the person who asked holds it');
  assert.equal(rows[0].title, 'פאדל השבוע');

  // The same call between two of these people, in private, is still refused:
  // the room is the consent, and it did not become a connection.
  const direct = await withTx(db.pool, (c) => meetings.startMeeting(c, people[0].id, 'קפה', [people[1].id]));
  assert.equal(direct.ok, false);
  assert.equal(direct.error.reason, 'not_connected');
});

test('the private question names the room, and never asks anybody to answer in it', async () => {
  const { group, people } = await room(2, { subject: 'פוקר של רביעי' });
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'משחק השבוע'));
  assert.equal(res.ok, true);

  const { rows } = await db.pool.query(
    `SELECT user_id, payload FROM outbox
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1
      ORDER BY user_id`, [res.data.meeting.id]);
  // Everybody in the room, the person who asked included — this line used to
  // read `2, 'everybody but the person who asked'`, and that was the bug
  // written down as an assertion (`incidents.md`, "The coordination waited on
  // the man who started it").
  assert.equal(rows.length, 3, 'everybody in the room, the asker included');
  assert.deepEqual(rows.map((r) => Number(r.user_id)).sort(),
    people.map((u) => Number(u.id)).sort());

  const p = rows.find((r) => Number(r.user_id) === Number(people[1].id)).payload;
  assert.equal(p.groupSubject, 'פוקר של רביעי');
  assert.equal(p.askedItYourself, undefined, 'they did not ask for it');
  const body = instructionFor({ kind: 'meeting_invite', payload: p });
  assert.match(body, /פוקר של רביעי/, 'the room is the subject of the sentence');
  assert.match(body, /never in the group/, 'and the answer comes back here, not there');
});

test('the person who asked in the room is asked when suits THEM', async () => {
  const { group, people } = await room(30, { subject: 'בדיקה לעולמה' });
  const asked = people[0];
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(
    c, group, asked, 'פגישה שבוע הקרוב'));
  assert.equal(res.ok, true);

  // `startMeeting` puts the initiator in at `awaiting` like everyone else, so a
  // coordination that never asks them cannot settle at all.
  const { rows: parts } = await db.pool.query(
    `SELECT user_id, state FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id`,
    [res.data.meeting.id]);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((r) => r.state === 'awaiting'));

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox
      WHERE kind = 'meeting_invite' AND user_id = $1
        AND (payload->>'meetingId')::bigint = $2`, [asked.id, res.data.meeting.id]);
  assert.equal(rows.length, 1, 'the man who asked gets his own row');
  assert.equal(rows[0].payload.askedItYourself, true);

  const body = instructionFor({ kind: 'meeting_invite', payload: rows[0].payload });
  assert.match(body, /has not said when suits THEM/, 'which is the only thing missing');
  assert.match(body, /בדיקה לעולמה/, 'the room he asked in');
  assert.doesNotMatch(body, /in front of everyone/,
    'he was there; being told he asked in front of everyone reads as a tool losing track of him');
  assert.doesNotMatch(body, /asked for it there/, 'and nobody tells him who asked');
});

test('one row each, so asking twice cannot ask the same man twice', async () => {
  const { group, people } = await room(31);
  const first = await withTx(db.pool, (c) => groupMeetings.startCoordination(
    c, group, people[0], 'ראשון'));
  assert.equal(first.ok, true);
  // The room asks again while the same coordination is running: `startCoordination`
  // answers with the one already going, and the idempotency key is what stops a
  // second question reaching anybody — the asker's row included.
  const again = await withTx(db.pool, (c) => groupMeetings.startCoordination(
    c, group, people[0], 'שני'));
  assert.equal(again.ok, true);
  assert.equal(again.data.created, false);

  const { rows } = await db.pool.query(
    `SELECT user_id, count(*)::int AS n FROM outbox
      WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1
      GROUP BY user_id`, [first.data.meeting.id]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.n === 1), 'one invite per person, ever');
});

// ---- the organic joiner, who is the one the room was waiting for ----------
//
// Every fixture above stamps `last_inbound_at` by hand, which is the state a
// person reaches by writing to their OWN agent. The people who actually arrive
// through a room do not reach it: they meet the intake GREETER, which stamps
// `opening_sent_at` instead, and for them the gate below is the only thing
// that reads both. A fixture that writes the state by hand cannot notice the
// state is only ever reached the other way, so these three build it the real
// way round (`incidents.md`, "The room coordinated without the person who
// opened it").
async function roomWithAGreeterJoiner(n, { size = 3 } = {}) {
  const people = [];
  for (let i = 0; i < size; i++) {
    const u = await makeUser(db.pool, `+9726077${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    // The LAST of them is the joiner: the greeter answered their first
    // message, so their own agent has never heard them and the column every
    // other test leans on is NULL.
    await db.pool.query(
      i === size - 1
        ? `UPDATE users SET last_inbound_at = NULL, opening_sent_at = now() WHERE id = $1`
        : `UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(n), subject: 'בדיקה לעולמה', token: TOKEN(n),
    members: people.map((u) => ({ phone: u.phone })),
  }));
  return { group, people, joiner: people[size - 1] };
}

test('the person the greeter met is counted into the room they opened', async () => {
  const { group, people, joiner } = await roomWithAGreeterJoiner(20);
  // The gate opened this room for all three — that is the fix this one never
  // got, and asserting it here is what keeps the two answers tied together.
  const roster = await withTx(db.pool, (c) => groups.listMembers(c, group.id));
  assert.deepEqual(roster.map(groups.isConnected), [true, true, true], 'the gate says open for everybody');

  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פגישה שבוע הקרוב'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.participants, 3, 'and so does the coordination');

  const { rows } = await db.pool.query(
    `SELECT user_id FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id`, [res.data.meeting.id]);
  assert.ok(rows.some((r) => Number(r.user_id) === Number(joiner.id)),
    'the joiner is in the coordination, not silently left out of it');

  const { rows: invites } = await db.pool.query(
    `SELECT user_id FROM outbox WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1`,
    [res.data.meeting.id]);
  assert.ok(invites.some((r) => Number(r.user_id) === Number(joiner.id)),
    'and is actually asked when they are free');
});

test('a room of two coordinates when the other person met the greeter', async () => {
  // The sharp version: with the joiner filtered out there is nobody else left,
  // and she answered a room with two people in it that it had nobody to
  // coordinate with.
  const { group, people, joiner } = await roomWithAGreeterJoiner(21, { size: 2 });
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'קפה'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  assert.equal(res.data.created, true);
  assert.equal(res.data.participants, 2, 'both of them — and the tool turns this into willAsk: 2');
  const { rows } = await db.pool.query(
    `SELECT user_id FROM meeting_participants WHERE meeting_id = $1`, [res.data.meeting.id]);
  assert.deepEqual(rows.map((r) => Number(r.user_id)).sort(),
    [people[0].id, joiner.id].map(Number).sort());
});

test('group_status never says somebody has not written when the greeter heard them', async () => {
  const { group, joiner } = await roomWithAGreeterJoiner(22);
  const status = await withTx(db.pool, (c) => groups.roomStatus(c, group));
  const row = status.members.find((m) => m.phone === joiner.phone);
  assert.ok(row, 'the joiner is on the roster the model is shown');
  assert.equal(row.wroteToHer, true,
    'or the model tells the room this person never wrote, about a person, out loud');
  assert.deepEqual(status.members.map((m) => m.wroteToHer), [true, true, true]);
});

test('a second ask while one is running gets the same coordination back', async () => {
  const { group, people } = await room(3);
  const first = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'ארוחה'));
  const second = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[1], 'משהו אחר'));
  assert.equal(second.ok, true);
  assert.equal(second.data.created, false);
  assert.equal(Number(second.data.meeting.id), Number(first.data.meeting.id));

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM meetings WHERE group_id = $1`, [group.id]);
  assert.equal(rows[0].n, 1, 'one table of times, not two');
});

test('a turn with nobody behind it starts nothing', async () => {
  const { group } = await room(4);
  // groups.actingMember returns null when the gateway filed no sender, or the
  // sender is not a user. Picking a member would put one person's name on a
  // decision they never made.
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, null, 'משחק'));
  assert.equal(res.ok, false);
  assert.match(res.error.message, /who asked/);
  const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM meetings WHERE group_id = $1`, [group.id]);
  assert.equal(rows[0].n, 0);
});

test('the room sees the answers and never the reasons', async () => {
  const { group, people } = await room(5);
  const [danny, dana] = people; // and יובל, who never answers
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, danny, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  const when = slotStart('שלישי', { hours: 72 });
  await withTx(db.pool, async (c) => {
    const added = await options.add(c, danny.id, meetingId, 'שלישי 20:00', when);
    assert.equal(added.ok, true, added.ok ? '' : JSON.stringify(added.error));
    const optionId = added.data.option.id;
    // Dana cannot, and says why. Her reason is prose she wrote in her own
    // private chat.
    const r = await meetings.recordConstraint(c, dana.id, meetingId, 'בצילומים ומסיימת מאוחר');
    assert.equal(r.ok, true);
    await options.answer(c, dana.id, meetingId, optionId, 'n');
  });

  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  const co = status.coordination;
  assert.equal(co.meetingId, meetingId);
  assert.equal(co.options.length, 1);
  assert.deepEqual(co.options[0].yes.map((x) => x.name), ['דני']);
  assert.deepEqual(co.options[0].no.map((x) => x.name), ['דנה']);
  assert.deepEqual(co.options[0].missing.map((x) => x.name), ['יובל']);
  assert.deepEqual(co.silent.map((x) => x.name), ['יובל'], 'and the room can chase exactly him');

  assert.equal(JSON.stringify(status).includes('בצילומים'), false,
    'the reason she gave in private is not in what the room can read');
});

test('a room with nothing running says so, rather than inventing a coordination', async () => {
  const { group } = await room(6);
  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  assert.equal(status.coordination, null);
});

test('a room nobody has classified has nothing to say about "enough people"', async () => {
  const { group, people } = await room(7);
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פאדל'));
  assert.equal(started.data.askKind, true, 'the one question is due');

  const q = groups.quorumFor(group, 3);
  assert.equal(q.known, false);
  assert.deepEqual([q.min, q.max, q.met, q.short], [null, null, null, null],
    'not "0 of 0" — nothing at all, so nothing can be read as a full house');

  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  assert.equal(status.coordination.kind, null);
  assert.equal(status.coordination.options.length, 0);
});

test('the kind question is asked once ever, answered or not', async () => {
  const { group, people } = await room(8);
  const first = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'ארוחה'));
  assert.equal(first.data.askKind, true);
  // Nobody answers. The coordination closes and another one starts later.
  await db.pool.query(`UPDATE meetings SET status = 'cancelled' WHERE group_id = $1`, [group.id]);
  const fresh = await withTx(db.pool, (c) => groups.getById(c, group.id));
  const second = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, fresh, people[0], 'עוד ארוחה'));
  assert.equal(second.data.created, true);
  assert.equal(second.data.askKind, false, 'a room that let the question go by is not asked again');
});

test('a game has a minimum and a social group cannot have one', async () => {
  const { group, people } = await room(9);
  const bad = await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'social', min: 4 }, people[0].id));
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /no minimum or maximum/);
  assert.equal((await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'poker' }))).ok, false);
  assert.equal((await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'game', min: 5, max: 4 }))).ok, false);
  assert.equal((await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'game', min: 1 }))).ok, false);

  const good = await withTx(db.pool, (c) => groups.setKind(c, group.id,
    { kind: 'game', min: 4, max: 4, closeAtTarget: true }, people[0].id));
  assert.equal(good.ok, true);
  const g = good.data.group;
  assert.equal(groups.quorumFor(g, 3).met, false);
  assert.equal(groups.quorumFor(g, 3).short, 1);
  assert.equal(groups.quorumFor(g, 4).met, true);
  assert.equal(groups.quorumFor(g, 4).mayClose, true, 'four of four, and this room closes at its target');
  // A social room is never short of anybody: whoever can, comes.
  assert.equal(groups.quorumFor({ kind: 'social' }, 1).met, true);
  assert.equal(groups.quorumFor({ kind: 'social' }, 1).mayClose, false);
});

test('the room cannot close a game below its own minimum, and can at it', async () => {
  const { group, people } = await room(10);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('רביעי', { hours: 96 });
  const optionId = await withTx(db.pool, async (c) => {
    const added = await options.add(c, a.id, meetingId, 'רביעי 20:00', when);
    return added.data.option.id;
  });
  const gamely = await withTx(db.pool, (c) => groups.setKind(c, group.id, { kind: 'game', min: 3 }, a.id));
  const g = gamely.data.group;

  const tooFew = await withTx(db.pool, (c) => groupMeetings.settle(c, g, a, optionId));
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.error.reason, 'below_minimum');
  assert.match(tooFew.error.message, /1 of the 3/);

  await withTx(db.pool, async (c) => {
    await options.answer(c, b.id, meetingId, optionId, 'y');
    await options.answer(c, people[2].id, meetingId, optionId, 'y');
  });
  const closed = await withTx(db.pool, (c) => groupMeetings.settle(c, g, b, optionId));
  assert.equal(closed.ok, true, closed.ok ? '' : JSON.stringify(closed.error));
  assert.equal(closed.data.meetingStatus, 'confirmed');

  // Everybody hears it privately — including the member who said it in the
  // room, who is mid-turn THERE and would otherwise never be told.
  const { rows } = await db.pool.query(
    `SELECT user_id, payload FROM outbox
      WHERE kind = 'meeting_confirmed' AND (payload->>'meetingId')::bigint = $1`, [meetingId]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].payload.groupSubject, 'פאדל חמישי');
  const body = instructionFor({ kind: 'meeting_confirmed', payload: rows[0].payload });
  assert.match(body, /closed it in the group/);
  assert.doesNotMatch(body, /who opened it/, 'nobody "opened" a coordination that belongs to the room');
});

test('a member of another room cannot close this one', async () => {
  const { group, people } = await room(11);
  const other = await room(12);
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פוקר'));
  const meetingId = Number(started.data.meeting.id);
  const when = slotStart('חמישי', { hours: 96 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, people[0].id, meetingId, 'חמישי 21:00', when)).data.option.id);

  const res = await withTx(db.pool, (c) => groupMeetings.settle(c, group, other.people[0], optionId));
  assert.equal(res.ok, false);
  assert.match(res.error.message, /not a member of this group/);
});

test('no group tool hands the room its own identity token back', async () => {
  // The token is in AGENTS.md, where the model reads it out of a file. A copy
  // in a tool RESULT is a second copy in the context for nothing — and every
  // `chat_groups` row carries it, so any handler that returns a row leaks it
  // by accident. Driven through the handlers themselves rather than by reading
  // the source, because the next one will be written by somebody who never
  // saw this test.
  const { group, people } = await room(13);
  const token = group.identity_token;
  assert.match(token, /^olma_grp_/);
  const tools = require('../src/adapters/mcp/tools/group');
  const args = {
    start_group_coordination: { what: 'פאדל' },
    set_group_kind: { kind: 'game', minimum: 4 },
    settle_group_coordination: { option_id: 1 },
  };
  for (const t of tools) {
    const res = await withTx(db.pool, (c) =>
      t.handler(c, { group, actingUser: people[0] }, args[t.name] || {}, {}));
    assert.equal(JSON.stringify(res).includes(token), false, `${t.name} put the group token in its result`);
  }
});

test('the room is told she will ask, never that she has', async () => {
  // 2026-09-07, the first real coordination: the tool answered `asked: 2` and
  // the model wrote "על זה. שואלת את כולם בפרטי מתי מתאים" into the room —
  // while both invites were still sitting in the queue, one held for the night
  // and one dropped because that person had stopped answering. Nobody was
  // asked anything. The count was rows enqueued, and the word was a claim the
  // tool had no way to support.
  const { group, people } = await room(14);
  const tool = require('../src/adapters/mcp/tools/group')
    .find((t) => t.name === 'start_group_coordination');
  const res = await withTx(db.pool, (c) =>
    tool.handler(c, { group, actingUser: people[0] }, { what: 'פאדל' }, {}));

  assert.equal(res.ok, true);
  // `people.length - 1` until 2026-09-19: the person who asked is owed the
  // question too, because a tag in a room carries no times (`incidents.md`,
  // "The coordination waited on the man who started it"). The fan-out was
  // fixed and this number was not, so the tool told the model one fewer
  // person than it had just written rows for.
  assert.equal(res.data.willAsk, people.length, 'how many are OWED a message');
  assert.equal('asked' in res.data, false, 'the word that made the claim is gone');
  assert.match(res.data.hints.room, /WHEN THEY ARE AVAILABLE/);
  assert.match(res.data.hints.room, /Never say they have already been asked/);
});

// The hint above only reaches the model AFTER it calls the tool. On
// 2026-09-12, in a room with nobody else in it (מירון, group "ב"), the model
// answered "בסדר, אני על זה! כולם יקבלו שאלה בפרט" without calling this tool
// at all — no `group.tool` row, no meeting, nothing queued for anybody to
// receive. The claim above fixed what she says about a call she DID make;
// nothing stopped the turn where she made none. The description is the only
// thing that runs before the call, so the instruction has to live there.
test('the description tells her to call this before saying anything, not after', () => {
  const tool = require('../src/adapters/mcp/tools/group')
    .find((t) => t.name === 'start_group_coordination');
  assert.match(tool.description, /Call this the moment the room asks/);
  assert.match(tool.description, /never say you are on it before calling it/);
});

// Coordination 38, 2026-09-22: the room was chased about three people one
// minute before the second of them was asked and nine hours after the third's
// invite was dropped as quiet. An invite that never arrived is not silence.
test('somebody the gate never let her reach is silent but not ASKED', async () => {
  const { group, people } = await room(15);
  const [host, held, dropped] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, host, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  const rowOf = async (userId) => (await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND kind = 'meeting_invite'
       AND (payload->>'meetingId')::bigint = $2`, [userId, meetingId])).rows[0];
  // The host's own invite arrives; one is still held for the night, one was
  // dropped as quiet — which marks the row sent, and is why sent_at alone
  // cannot answer this.
  await db.pool.query(`UPDATE outbox SET sent_at = now(), hold_reason = NULL WHERE id = $1`,
    [(await rowOf(host.id)).id]);
  await db.pool.query(`UPDATE outbox SET sent_at = NULL, hold_reason = 'night', release_after = now() + interval '8 hours' WHERE id = $1`,
    [(await rowOf(held.id)).id]);
  await db.pool.query(`UPDATE outbox SET sent_at = now(), hold_reason = 'quiet' WHERE id = $1`,
    [(await rowOf(dropped.id)).id]);

  const st = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  const by = (u) => st.coordination.silent.find((p2) => p2.phone === u.phone);
  assert.equal(st.coordination.silent.length, 3, 'all three have answered nothing — that count is unchanged');
  assert.equal(by(host).asked, true);
  assert.equal(by(held).asked, false, 'held for the night: she has not got a word to them yet');
  assert.equal(by(dropped).asked, false, 'dropped as quiet: the row says sent, and nobody read it');

  // And it turns true the moment the held row actually goes out.
  await db.pool.query(`UPDATE outbox SET sent_at = now(), hold_reason = NULL, release_after = NULL WHERE id = $1`,
    [(await rowOf(held.id)).id]);
  const after = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  assert.equal(after.coordination.silent.find((p2) => p2.phone === held.phone).asked, true);
});

