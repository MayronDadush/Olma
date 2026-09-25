'use strict';
// The once-ever zone question (owner, 2026-09-25, פנתרה). In a room on several
// clocks every time is said in each person's zone, so a zone that was only ever
// inferred is worth asking about — once, riding the room invite they are
// getting anyway, and stamped only after that send confirms. User 11 was
// inferred as Los Angeles, asked once on 2026-09-05 and never answered; this
// is the new, bounded occasion to ask again.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const { drainOnce } = require('../src/outbox/worker');
const { instructionFor } = require('../src/channels/openclaw');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A Monday, 19:30 in Israel and 09:30 in Los Angeles: inside both people's
// windows and on nobody's quiet day, so the gate lets every invite through.
const NOW = new Date('2026-08-17T16:30:00Z');
const live = { checkChannels: async () => ({ status: 'live', detail: null, channels: [] }) };
const IL = 'Asia/Jerusalem';
const LA = 'America/Los_Angeles';

async function room(n, zones) {
  const people = [];
  for (let i = 0; i < zones.length; i++) {
    const u = await makeUser(db.pool, `+9726076${n}000${i}`, { firstName: `חבר${i}` });
    await db.pool.query(
      `UPDATE users SET last_inbound_at = now(), timezone = $2, timezone_confirmed = $3 WHERE id = $1`,
      [u.id, zones[i].tz, zones[i].confirmed]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036355555555${n}@g.us`, subject: 'פנתרה',
      members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = $4
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n + 60).padStart(2, '0').repeat(16), IL]);
    return rows[0];
  });
  return { group, people };
}

async function start(group, by) {
  const res = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, by, 'שיחת וידאו'));
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  return Number(res.data.meeting.id);
}

// Every row the worker handed to delivery, by user, with what it carried.
async function drain(deliverResult = { ok: true }) {
  const sent = [];
  await drainOnce(db.pool, async (r) => { sent.push(r); return deliverResult; }, NOW, live);
  return sent;
}
const askedAt = async (u) => (await db.pool.query(
  'SELECT room_zone_asked_at FROM users WHERE id = $1', [u.id])).rows[0].room_zone_asked_at;

test('an unconfirmed zone in a room on several clocks is asked about once, and only once the send confirmed', async () => {
  const { group, people } = await room(1, [
    { tz: IL, confirmed: true }, { tz: IL, confirmed: true }, { tz: LA, confirmed: false },
  ]);
  const [miron, , dan] = people;
  const first = await start(group, miron);

  // The send fails: nothing is spent, and the question is still owed.
  await drain({ ok: false, error: 'boom' });
  assert.equal(await askedAt(dan), null, 'stamped for a message that never went out');

  await db.pool.query(`UPDATE outbox SET release_after = NULL, attempts = 0 WHERE sent_at IS NULL`);
  const sent = await drain();
  const toDan = sent.find((r) => Number(r.user_id) === Number(dan.id));
  assert.equal(toDan.payload.askZone, 'לוס אנג׳לס');
  assert.ok(instructionFor(toDan).includes('רשום אצלי שאת/ה לפי שעון לוס אנג׳לס'));
  assert.notEqual(await askedAt(dan), null);
  // A confirmed zone is never asked about.
  for (const r of sent.filter((x) => Number(x.user_id) !== Number(dan.id))) {
    assert.equal(r.payload.askZone, undefined);
  }

  // The next coordination in the same room does not ask again.
  await db.pool.query(`UPDATE meetings SET status = 'no_match', closed_at = now() WHERE id = $1`, [first]);
  await start(group, miron);
  const again = (await drain()).find((r) => Number(r.user_id) === Number(dan.id));
  assert.ok(again, 'the second invite went out');
  assert.equal(again.payload.askZone, undefined);
});

test('a room on one clock never asks, however unconfirmed the zone', async () => {
  const { group, people } = await room(2, [
    { tz: IL, confirmed: true }, { tz: IL, confirmed: false }, { tz: IL, confirmed: true },
  ]);
  await start(group, people[0]);
  const sent = await drain();
  assert.ok(sent.length >= 2);
  assert.ok(sent.every((r) => r.payload.askZone === undefined && !r.payload.roomZones));
  assert.equal(await askedAt(people[1]), null);
});

test('somebody let into a settled coordination on several clocks is asked too, on the time they are sent', async () => {
  const { group, people } = await room(3, [
    { tz: IL, confirmed: true }, { tz: LA, confirmed: true },
  ]);
  const meetingId = await start(group, people[0]);
  await drain();
  await db.pool.query(
    `UPDATE meetings SET status = 'confirmed', confirmed_slot = 'יום שבת 12:00', confirmed_start_at = $2 WHERE id = $1`,
    [meetingId, new Date(NOW.getTime() + 2 * 86400e3)]);
  // A new member, whose zone was only ever guessed off a +972 number.
  const dana = await makeUser(db.pool, '+61412340077', { firstName: 'דנה' });
  await db.pool.query(
    `UPDATE users SET last_inbound_at = now(), timezone = $2, timezone_confirmed = false WHERE id = $1`, [dana.id, IL]);
  await withTx(db.pool, (c) => groups.syncRoster(c, group.id, [...people, dana].map((u) => ({ phone: u.phone }))));
  const m = (await db.pool.query('SELECT * FROM meetings WHERE id = $1', [meetingId])).rows[0];
  const g = (await db.pool.query('SELECT * FROM chat_groups WHERE id = $1', [group.id])).rows[0];
  const inNow = await withTx(db.pool, (c) => groupMeetings.admitLateMembers(c, g, m, NOW));
  assert.equal(inNow.length, 1);
  const toDana = (await drain()).find((r) => Number(r.user_id) === Number(dana.id));
  assert.equal(toDana.kind, 'meeting_confirmed');
  assert.equal(toDana.payload.askZone, 'ישראל');
  assert.notEqual(await askedAt(dana), null);
});
