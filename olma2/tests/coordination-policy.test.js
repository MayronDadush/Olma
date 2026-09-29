'use strict';
// The three moves a room coordination did not have (owner, 2026-09-28): a
// private nudge to somebody who has answered nothing, the offer to drop it
// once the room has gone quiet, and the quiet close when nobody took it up.
// The pure half is `domain/coordination-policy`; the sweep half is
// `jobs/coordination-moves`, run from `sweepGroupVoice`. Both are behind
// `coordination_policy`, and `shadow` must send nothing at all.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const policy = require('../src/domain/coordination-policy');
const flags = require('../src/domain/flags');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupOutbox = require('../src/domain/group-outbox');
const options = require('../src/domain/meeting-options');
const groupsJob = require('../src/jobs/groups');
const text = require('../src/domain/proactive-text');
const { instructionFor } = require('../src/channels/openclaw');

const H = 3600e3;

// ── the pure half ──────────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const at = (h) => new Date(T0 + h * H).toISOString();
const base = (over) => ({
  chaseAt: at(1), dropOfferAt: null, lastActivityAt: at(0), enough: false,
  silent: [], nudged: [], earliestStartAt: null, ...over,
});
const kinds = (moves) => moves.map((m) => m.kind);

test('the offer waits for the chase, for twelve quiet hours after both, and for a table with no direction', () => {
  assert.deepEqual(kinds(policy.nextMoves(base({ chaseAt: null }), T0 + 40 * H)), [], 'never before the chase');
  assert.deepEqual(kinds(policy.nextMoves(base(), T0 + 12.5 * H)), [], 'twelve hours after the CHASE, not the start');
  assert.deepEqual(kinds(policy.nextMoves(base(), T0 + 13 * H)), ['drop_offer']);
  assert.deepEqual(kinds(policy.nextMoves(base({ lastActivityAt: at(5) }), T0 + 13 * H)), [], 'quiet is measured from the last activity');
  assert.deepEqual(kinds(policy.nextMoves(base({ enough: true }), T0 + 40 * H)), [], 'a room with a direction is not stuck');
});

test('the offer closes quietly at the moment it named unless somebody moved, and is never said twice', () => {
  const named = base({ dropOfferAt: at(13), dropCloseAt: at(22) });
  assert.deepEqual(kinds(policy.nextMoves(named, T0 + 21.9 * H)), [], 'not before the moment the room read');
  assert.deepEqual(kinds(policy.nextMoves(named, T0 + 22 * H)), ['drop_close']);
  // An offer with no named moment falls back to its grace.
  const offered = base({ dropOfferAt: at(13) });
  assert.deepEqual(kinds(policy.nextMoves(offered, T0 + 18 * H)), [], 'grace not up');
  assert.deepEqual(kinds(policy.nextMoves(offered, T0 + 19 * H)), ['drop_close']);
  // Somebody answered after it: it lapsed — no close, and no second offer.
  const answered = base({ dropOfferAt: at(13), lastActivityAt: at(14) });
  assert.deepEqual(kinds(policy.nextMoves(answered, T0 + 60 * H)), []);
});

test('a nudge: once, only to the silent, never about a thing that started, never beside the offer', () => {
  const silent = [{ userId: 1, askedAt: at(0) }, { userId: 2, askedAt: at(4) }];
  const quiet = base({ lastActivityAt: at(5), silent });
  assert.deepEqual(policy.nextMoves(quiet, T0 + 7 * H), [{ kind: 'nudge', userIds: [1] }], 'six hours after THEIR ask');
  assert.deepEqual(policy.nextMoves({ ...quiet, nudged: [1] }, T0 + 11 * H), [{ kind: 'nudge', userIds: [2] }]);
  assert.deepEqual(policy.nextMoves({ ...quiet, nudged: [1, 2] }, T0 + 11 * H), []);
  assert.deepEqual(policy.nextMoves({ ...quiet, earliestStartAt: at(6) }, T0 + 7 * H), [], 'it already started');
  // Twelve quiet hours: the offer, and nobody is nudged in the same breath.
  assert.deepEqual(kinds(policy.nextMoves(base({ silent }), T0 + 14 * H)), ['drop_offer']);
  assert.deepEqual(kinds(policy.nextMoves(base({ silent, dropOfferAt: at(13) }), T0 + 15 * H)), []);
});

test('the flag names rooms by id or jid, and is off for everybody else', () => {
  const room = { id: 7, external_id: '1203@g.us' };
  assert.equal(policy.modeFor(undefined, room), 'off');
  assert.equal(policy.modeFor({ mode: 'off', rooms: [7] }, room), 'off');
  assert.equal(policy.modeFor({ mode: 'shadow', rooms: [7] }, room), 'shadow');
  assert.equal(policy.modeFor({ mode: 'live', rooms: ['1203@g.us'] }, room), 'live');
  assert.equal(policy.modeFor({ mode: 'live', rooms: [8] }, room), 'off');
  assert.equal(policy.modeFor({ mode: 'shadow', allRooms: true }, room), 'shadow');
  assert.equal(policy.modeFor({ mode: 'bogus', allRooms: true }, room), 'off');
  assert.deepEqual(policy.paramsOf({ dropGraceH: 3, nudgeAfterH: -1 }), { ...policy.DEFAULTS, dropGraceH: 3 });
});

test('the offer names the moment it closes, in the room\'s own words, and moves a night close to the morning', () => {
  const W = { start: '09:00', end: '21:00' };
  const tz = 'Asia/Jerusalem';
  const gate = require('../src/outbox/gate');
  const close = (said) => new Date(policy.closeMomentFor(Date.parse(said), policy.DEFAULTS,
    (d) => gate.msUntilWindowOpen(W, tz, d))).toISOString();
  // 12:07 in Jerusalem: six hours on, up to the half hour.
  assert.equal(close('2026-01-05T10:07:00Z'), '2026-01-05T16:30:00.000Z');
  // 19:10: six hours on is 01:10, the room's night, so 09:00 the next morning.
  assert.equal(close('2026-01-05T17:10:00Z'), '2026-01-06T07:00:00.000Z');

  const draw = (over) => text.renderGroupCoordination({
    kind: 'drop_offer', title: 'פאדל', missing: ['+972501234567'], roomTz: tz,
    saidAt: '2026-01-05T17:10:00Z', closeAt: '2026-01-06T07:00:00.000Z', ...over,
  });
  const s = draw();
  assert.match(s, /נתקע/);
  assert.match(s, /עוד לא שמעתי מ@\+972501234567\./);
  assert.match(s, /אסגור אותו מחר ב-09:00\.$/);
  assert.match(draw({ saidAt: '2026-01-05T10:07:00Z', closeAt: '2026-01-05T16:30:00.000Z' }), /אסגור אותו היום ב-18:30\.$/);
  // Nobody taggable: the sentence about them goes, not the offer.
  const none = draw({ missing: [] });
  assert.ok(!none.includes('עוד לא שמעתי'), none);
  // A room on several clocks hears the moment in each, from the owner's twin.
  const zoned = draw({ multiZone: true, zones: ['Asia/Jerusalem', 'America/New_York'] });
  assert.match(zoned, /09:00 ישראל · 02:00 ניו יורק/);
  // No moment, no promise: nothing is drawn rather than a close nobody can check.
  assert.equal(draw({ closeAt: null }), null);
});

test('the nudge instruction asks one thing, reads the table now, and forbids naming who said what', () => {
  const s = instructionFor({ kind: 'meeting_nudge', payload: { meetingId: 9, title: 'פאדל', groupSubject: 'Padel' }, timezone: 'Asia/Jerusalem' });
  assert.match(s, /ONE reminder/);
  assert.match(s, /get_meeting_status meeting_id=9/);
  assert.match(s, /never who said what/);
  assert.match(s, /LENGTH: one sentence of context and one question/);
});

// ── the sweep half, on a real database ─────────────────────────────────────
let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// 11:00 UTC today — daytime in an Israeli room whatever hour the suite runs —
// and every other moment measured from it, computed once.
const DAY = (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();
const plus = (h) => new Date(DAY.getTime() + h * H);

async function room(n) {
  const people = [];
  for (let i = 0; i < 3; i++) {
    const u = await makeUser(db.pool, `+9726089${n}000${i}`, { firstName: `חבר${i}` });
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
    people.push(u);
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036355555555${n}@g.us`, subject: 'Padel', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n + 60).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  return { group, people };
}

// A coordination opened eight hours before DAY: the room heard the opening and
// the chase, and every invite reached its person at the start.
async function staleCoordination(group, people) {
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, people[0], 'פאדל'));
  const id = Number(started.data.meeting.id);
  const t0 = plus(-8);
  await db.pool.query(
    `UPDATE meetings SET created_at = $2, group_started_at = $2, group_chase_at = $3 WHERE id = $1`,
    [id, t0, plus(-7)]);
  await db.pool.query(
    `UPDATE outbox SET sent_at = $2 WHERE (payload->>'meetingId')::bigint = $1 AND sent_at IS NULL`, [id, t0]);
  return id;
}

async function pass(group, now) {
  const sent = [];
  await withTx(db.pool, (c) => groupsJob.sweepGroupVoice(c, { now }));
  await groupOutbox.drainOnce(db.pool, {
    now, channelWrittenAt: () => null,
    send: async (to, body) => { if (to === group.external_id) sent.push(body); return 'sent'; },
  });
  return sent;
}

const nudges = async (id) => (await db.pool.query(
  `SELECT user_id, sent_at, hold_reason FROM outbox WHERE kind = 'meeting_nudge'
      AND (payload->>'meetingId')::bigint = $1 ORDER BY user_id`, [id])).rows;
const shadows = async (id) => (await db.pool.query(
  `SELECT detail->>'move' AS move, detail->>'userId' AS user_id FROM audit_log
    WHERE event = 'coordination.policy_shadow' AND (detail->>'meetingId')::bigint = $1 ORDER BY id`, [id])).rows;
const statusOf = async (id) => (await db.pool.query('SELECT status, group_drop_offer_at, group_drop_close_at FROM meetings WHERE id = $1', [id])).rows[0];

test('flag off: an old, quiet coordination gets nothing new', async () => {
  const { group, people } = await room(1);
  const id = await staleCoordination(group, people);
  assert.deepEqual(await pass(group, plus(24)), []);
  assert.deepEqual(await nudges(id), []);
  assert.deepEqual(await shadows(id), []);
  assert.equal((await statusOf(id)).status, 'negotiating');
});

test('shadow decides every move, once, and sends and changes nothing', async () => {
  const { group, people } = await room(2);
  const id = await staleCoordination(group, people);
  await withTx(db.pool, (c) => flags.setFlag(c, 'coordination_policy', { mode: 'shadow', rooms: [group.id] }));

  // Eight hours since they were asked: a nudge each, recorded and not queued.
  assert.deepEqual(await pass(group, DAY), []);
  const first = await shadows(id);
  assert.ok(first.length >= 2 && first.every((r) => r.move === 'nudge'), JSON.stringify(first));
  assert.deepEqual(await nudges(id), []);
  // The same pass again decides nothing new.
  await pass(group, plus(0.1));
  assert.equal((await shadows(id)).length, first.length);

  // Twelve quiet hours after the chase: the offer, recorded, not said.
  assert.deepEqual(await pass(group, plus(5)), []);
  assert.equal((await statusOf(id)).group_drop_offer_at, null);
  // Its grace up with nobody moving: the close, recorded, not done.
  assert.deepEqual(await pass(group, plus(24)), []);
  const moves = (await shadows(id)).map((r) => r.move);
  assert.deepEqual(moves.filter((m) => m !== 'nudge'), ['drop_offer', 'drop_close']);
  assert.equal((await statusOf(id)).status, 'negotiating');
  const { rows: roomRows } = await db.pool.query(
    `SELECT 1 FROM group_outbox WHERE idempotency_key LIKE $1`, [`g${group.id}:m${id}:drop_offer%`]);
  assert.equal(roomRows.length, 0);
});

test('live: a nudge once each, then the offer in the room, then a quiet close', async () => {
  const { group, people } = await room(3);
  const id = await staleCoordination(group, people);
  await withTx(db.pool, (c) => flags.setFlag(c, 'coordination_policy', { mode: 'live', rooms: [group.id] }));

  assert.deepEqual(await pass(group, DAY), [], 'a nudge is private');
  const queued = await nudges(id);
  assert.ok(queued.length >= 2, JSON.stringify(queued));
  await pass(group, plus(1));
  assert.equal((await nudges(id)).length, queued.length, 'never twice');

  const said = await pass(group, plus(5));
  assert.equal(said.length, 1);
  assert.match(said[0], /נתקע/);
  // Said at 19:00 in Jerusalem: six hours on is the room's night, so the
  // offer names the morning, and that is the moment stored for the close.
  assert.match(said[0], /אסגור אותו מחר ב-09:00\.$/);
  const offered = await statusOf(id);
  assert.ok(offered.group_drop_offer_at);
  assert.ok(new Date(offered.group_drop_close_at) > plus(5 + 6));
  assert.deepEqual(await pass(group, plus(6)), [], 'said once');

  // The next morning, nobody having moved: closed, and the room hears nothing.
  assert.deepEqual(await pass(group, plus(24)), []);
  assert.equal((await statusOf(id)).status, 'no_match');
  const { rows } = await db.pool.query(
    `SELECT 1 FROM audit_log WHERE event = 'meeting.dropped_quiet' AND (detail->>'meetingId')::bigint = $1`, [id]);
  assert.equal(rows.length, 1);
});

test('live: an answer after the offer lapses it, and an answer withdraws that person\'s queued nudge', async () => {
  const { group, people } = await room(4);
  const id = await staleCoordination(group, people);
  await withTx(db.pool, (c) => flags.setFlag(c, 'coordination_policy', { mode: 'live', rooms: [group.id] }));
  await pass(group, DAY);
  const before = await nudges(id);
  const who = people.find((p) => before.some((r) => Number(r.user_id) === Number(p.id)));
  assert.ok(who);

  // They put a time up and say yes to it: their nudge is withdrawn at once.
  // The words name no weekday: `slot` is three days from whenever the suite
  // runs, and a fixed "יום חמישי" is refused by the weekday check on every
  // day it is not a Thursday (it went red on 2026-09-29, a Tuesday).
  const slot = plus(72);
  await withTx(db.pool, async (c) => {
    const added = await options.add(c, who.id, id, 'עוד שלושה ימים', slot.toISOString());
    assert.ok(added.ok, JSON.stringify(added));
    await options.answer(c, who.id, id, added.data.optionId || added.data.option.id, 'y');
  });
  const mine = (await nudges(id)).find((r) => Number(r.user_id) === Number(who.id));
  assert.equal(mine.hold_reason, 'superseded');

  // The offer was due twelve quiet hours after the chase; the room moved, so
  // it is not said, and nothing closes.
  await pass(group, plus(5));
  await pass(group, plus(24));
  assert.equal((await statusOf(id)).status, 'negotiating');
});
