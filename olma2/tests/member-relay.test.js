'use strict';
// One sentence a MEMBER asked the room to hear (owner, 2026-09-22). Sharon told
// Olma in private that the group should know the time had moved; the room was
// never told, because every line a room hears unasked is text Olma decided on
// and there was no shape at all for a sentence somebody else decided on.
//
// What is tested here is mostly the bound. The whole guard against her becoming
// "חופרת" is arithmetic — one per person per coordination, the room has to be
// listed in a flag, the words are cut — so each of those refusals is a test,
// and none of them asks a model anything.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const flags = require('../src/domain/flags');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036344444444${n}@g.us`;
const TOKEN = (n) => 'olma_grp_' + String(n).padStart(2, '0').repeat(16);

async function room(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726099${n}000${i}`, { firstName: ['דני', 'דנה', 'יובל'][i] });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: JID(n), subject: 'פאדל', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`, [reg.data.group.id, `g-${reg.data.group.id}`, TOKEN(n)]);
    return rows[0];
  });
  return { group, people };
}

async function relay(userId, meetingId, what) {
  return withTx(db.pool, (c) => groupMeetings.relayToRoom(c, userId, meetingId, what));
}

test('a room nobody turned this on for hears nothing, however clearly somebody asked', async () => {
  const { group, people } = await room(1);
  const [a] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  const off = await relay(a.id, meetingId, 'ב-4 קצת חם');
  assert.equal(off.ok, false);
  assert.equal(off.error.reason, 'relay_off');
  // Nothing was written, so nothing is owed: the refusal is not a deferral.
  assert.equal(await withTx(db.pool, (c) => groupMeetings.pendingRelay(c, meetingId)), null);

  // Per ROOM, not globally — the standing rule is that only the test rooms are
  // experimented on, so a flag naming another room leaves this one closed.
  await withTx(db.pool, (c) => flags.setFlag(c, groupMeetings.RELAY_FLAG, '999@g.us'));
  assert.equal((await relay(a.id, meetingId, 'ב-4 קצת חם')).error.reason, 'relay_off');

  await withTx(db.pool, (c) => flags.setFlag(c, groupMeetings.RELAY_FLAG, `999@g.us,${group.external_id}`));
  const on = await relay(a.id, meetingId, 'ב-4 קצת חם');
  assert.equal(on.ok, true, on.ok ? '' : JSON.stringify(on.error));
  assert.equal(on.data.said, 'ב-4 קצת חם');
});

test('one sentence per person per coordination, and the text itself is the budget', async () => {
  const { group, people } = await room(2);
  const [a, b] = people;
  await withTx(db.pool, (c) => flags.setFlag(c, groupMeetings.RELAY_FLAG, group.external_id));
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  assert.equal((await relay(a.id, meetingId, 'ב-4 קצת חם')).ok, true);
  const again = await relay(a.id, meetingId, 'ובכלל, אולי נדחה');
  assert.equal(again.ok, false);
  assert.equal(again.error.reason, 'relay_spent');
  assert.equal(again.error.already, 'ב-4 קצת חם', 'and it says what it already holds');

  // Somebody ELSE still has theirs — the budget is per person, not per room.
  assert.equal((await relay(b.id, meetingId, 'אני מביא כדורים')).ok, true);

  // Oldest first, one at a time, and a said one is out of the way.
  const first = await withTx(db.pool, (c) => groupMeetings.pendingRelay(c, meetingId));
  assert.equal(first.userId, Number(a.id));
  assert.equal(first.phone, a.phone);
  await withTx(db.pool, (c) => groupMeetings.markRelaySaid(c, meetingId, a.id));
  const second = await withTx(db.pool, (c) => groupMeetings.pendingRelay(c, meetingId));
  assert.equal(second.userId, Number(b.id));
  await withTx(db.pool, (c) => groupMeetings.markRelaySaid(c, meetingId, b.id));
  assert.equal(await withTx(db.pool, (c) => groupMeetings.pendingRelay(c, meetingId)), null);
});

test('only somebody in the coordination, and only while it is still being negotiated', async () => {
  const { group, people } = await room(3);
  const [a] = people;
  const outsider = await makeUser(db.pool, '+972609930099', { firstName: 'זר' });
  await withTx(db.pool, (c) => flags.setFlag(c, groupMeetings.RELAY_FLAG, group.external_id));
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const meetingId = Number(started.data.meeting.id);

  const stranger = await relay(outsider.id, meetingId, 'תגידו להם שאני בא');
  assert.equal(stranger.ok, false);
  assert.equal(stranger.error.code, 'forbidden');

  // Nothing to say about a plan that is already made: the room's next line is
  // "סגור", and a sentence about when to arrive is a message, not a relay.
  await db.pool.query(`UPDATE meetings SET status = 'confirmed' WHERE id = $1`, [meetingId]);
  const late = await relay(a.id, meetingId, 'ב-4 קצת חם');
  assert.equal(late.ok, false);
  assert.equal(late.error.reason, 'not_negotiating');
});

test('their words, with the tags taken out and the length cut', () => {
  // A relay is a sentence, never a way to notify people: an `@<digits>` token
  // in a room pings whoever it names, and the only tag this line carries is
  // the one Olma draws for the person who asked.
  assert.equal(groupMeetings.cleanRelay('תגידו ל@972501234567 שב-4 חם'), 'תגידו ל שב-4 חם');
  // The same strip every verbatim room string gets (message-format).
  assert.equal(groupMeetings.cleanRelay('*ב-4* קצת חם'), 'ב-4 קצת חם');
  const long = 'א'.repeat(400);
  assert.equal(groupMeetings.cleanRelay(long).length, groupMeetings.RELAY_MAX_CHARS);
  assert.equal(groupMeetings.cleanRelay('   '), '');
  assert.equal(groupMeetings.cleanRelay(null), '');
});

test('a room can be opened to this for everybody at once, and empty means nobody', () => {
  assert.equal(groupMeetings.relayRoomEnabled('', '1@g.us'), false);
  assert.equal(groupMeetings.relayRoomEnabled(null, '1@g.us'), false);
  assert.equal(groupMeetings.relayRoomEnabled('all', '1@g.us'), true);
  assert.equal(groupMeetings.relayRoomEnabled('1@g.us, 2@g.us', '2@g.us'), true);
  assert.equal(groupMeetings.relayRoomEnabled('1@g.us', '2@g.us'), false);
});
