'use strict';
// A member who had never written to Olma is TAGGED in the opening line, and
// once they write they are let into the coordination that is already running
// (owner, 2026-09-25). The founding room is פנתרה: the member in Australia
// had never written, heard only "somebody here is not counted", and nothing
// could have let her in even if she had answered it (`incidents.md`, "פנתרה:
// one time, four clocks").
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupOutbox = require('../src/domain/group-outbox');
const groupsJob = require('../src/jobs/groups');
const text = require('../src/domain/proactive-text');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => { await db.pool.query(`DELETE FROM group_outbox WHERE sent_at IS NULL`); });

// One clock for every pass, computed once: 11:00 UTC today is inside an
// Israeli room's daytime whatever hour the suite runs.
const DAY = (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();

// Three members who have written to her, and one (`outsider`) who never has:
// a roster row with no user behind it.
async function room(n, outsider) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726079${n}000${i}`, { firstName: `חבר${i}` });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036344444444${n}@g.us`, subject: 'פנתרה',
      members: [...people.map((u) => ({ phone: u.phone })), { phone: outsider }],
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n + 40).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  return { group, people };
}

// They write to her: a user row, stamped as having written, and the roster row
// resolved to it — what the intake and the roster reconcile do between them.
async function writesToHer(group, phone, { gender = null } = {}) {
  const u = await makeUser(db.pool, phone, { firstName: 'דנה' });
  await db.pool.query(`UPDATE users SET last_inbound_at = now(), gender = $2 WHERE id = $1`, [u.id, gender]);
  await db.pool.query(`UPDATE chat_group_members SET user_id = $3 WHERE group_id = $1 AND phone = $2`,
    [group.id, phone, u.id]);
  return u;
}

async function pass(jid) {
  const sent = [];
  await withTx(db.pool, (c) => groupsJob.sweepGroupVoice(c, { now: DAY }));
  await groupOutbox.drainOnce(db.pool, {
    now: DAY, channelWrittenAt: () => null,
    send: async (to, body) => { if (to === jid) sent.push(body); return 'sent'; },
  });
  return sent;
}

async function start(group, a) {
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'שיחת וידאו'));
  const meetingId = Number(started.data.meeting.id);
  await db.pool.query('UPDATE meetings SET created_at = $2 WHERE id = $1', [meetingId, DAY]);
  return meetingId;
}

const invitesTo = async (userId, meetingId) => (await db.pool.query(
  `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'meeting_invite'
      AND (payload->>'meetingId')::bigint = $2`, [userId, meetingId])).rows;

test('the opening tags who has not written, and a room of LIDs keeps the count line', () => {
  const one = text.renderGroupCoordination({ kind: 'started', title: 'שיחה', asked: 3, outside: 1, outsidePhones: ['+61412345678'] });
  assert.ok(one.endsWith('@+61412345678 עוד לא כתבת לי בפרטי — ״היי״ שם ואצרף אותך לתיאום ☺️'), one);
  const many = text.renderGroupCoordination({ kind: 'started', title: 'שיחה', asked: 3, outside: 2, outsidePhones: ['+61412345678', '+972501234567'] });
  assert.ok(many.endsWith('@+61412345678 @+972501234567 עוד לא כתבתם לי בפרטי — ״היי״ שם ואצרף אתכם לתיאום ☺️'), many);
  // A LID pings nobody, so it is counted and never tagged.
  const lid = text.renderGroupCoordination({ kind: 'started', title: 'שיחה', asked: 3, outside: 1, outsidePhones: [] });
  assert.ok(lid.endsWith('מי שעוד לא כתב לי בפרטי לא נספר פה — ״היי״ בפרטי וזה מסתדר ☺️'), lid);
  const none = text.renderGroupCoordination({ kind: 'started', title: 'שיחה', asked: 3, outside: 0 });
  assert.ok(!none.includes('בפרטי —'), none);
});

test('the joined line says how THEY asked to be addressed, masculine when they never said', () => {
  assert.equal(text.renderGroupCoordination({ kind: 'joined', phones: ['+61412345678'], address: 'feminine' }),
    '@+61412345678 הצטרפה — שאלתי בפרטי 👋');
  assert.equal(text.renderGroupCoordination({ kind: 'joined', phones: ['+61412345678'], address: null }),
    '@+61412345678 הצטרף — שאלתי בפרטי 👋');
  assert.equal(text.renderGroupCoordination({ kind: 'joined', phones: ['+61412345678', '+972501234567'] }),
    '@+61412345678 @+972501234567 הצטרפו — שאלתי בפרטי 👋');
});

test('פנתרה, end to end: tagged at the start, let in once she writes, and the room hears it once', async () => {
  const outsider = '+61412340001';
  const { group, people } = await room(1, outsider);
  const meetingId = await start(group, people[0]);

  const opening = await pass(group.external_id);
  assert.equal(opening.length, 1);
  assert.ok(opening[0].includes(`@${outsider} עוד לא כתבת לי בפרטי`), opening[0]);

  // Nothing to let anybody in on while she has not written.
  assert.deepEqual(await pass(group.external_id), []);

  const dana = await writesToHer(group, outsider, { gender: 'female' });
  const joined = await pass(group.external_id);
  assert.deepEqual(joined, [`@${outsider} הצטרפה — שאלתי בפרטי 👋`]);
  const { rows: part } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, dana.id]);
  assert.equal(part[0].state, 'awaiting');
  const invites = await invitesTo(dana.id, meetingId);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].payload.groupSubject, 'פנתרה');

  // Idempotent: the next pass lets nobody in twice and says nothing about it.
  assert.deepEqual(await pass(group.external_id), []);
  assert.equal((await invitesTo(dana.id, meetingId)).length, 1);
});

test('somebody who LEFT the coordination is never swept back in', async () => {
  const outsider = '+61412340002';
  const { group, people } = await room(2, outsider);
  const meetingId = await start(group, people[0]);
  await pass(group.external_id);
  // The third member steps out; a later pass must not put them back.
  await db.pool.query(`UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, people[2].id]);
  await pass(group.external_id);
  const { rows } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, people[2].id]);
  assert.equal(rows[0].state, 'opted_out');
  assert.equal((await invitesTo(people[2].id, meetingId)).length, 1, 'only the original invite');
});

test('before the opening line has gone out, somebody let in is simply counted by it', async () => {
  const outsider = '+61412340003';
  const { group, people } = await room(3, outsider);
  const meetingId = await start(group, people[0]);
  const dana = await writesToHer(group, outsider);
  const first = await pass(group.external_id);
  // One pass: she is let in, and the room's first word is the opening, with
  // her in its count and nobody left to tag — never a "joined" line about a
  // coordination the room has not heard of.
  assert.equal(first.length, 1);
  assert.match(first[0], /^מתחילה לתאם/);
  assert.match(first[0], /שאלתי בפרטי 4 מכם/);
  assert.ok(!first[0].includes('עוד לא כתב'), first[0]);
  assert.equal((await invitesTo(dana.id, meetingId)).length, 1);
});
