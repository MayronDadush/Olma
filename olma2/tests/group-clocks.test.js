'use strict';
// A room whose people live on more than one clock hears every time in each of
// them (owner, 2026-09-25). The founding room is פנתרה: two members in Israel,
// one abroad on a +972 number, a fourth in Australia — and every time the room
// heard was the proposer's Israeli hour, "יום שבת 26.9 20:00", read at ten in
// the morning by the man it was ten in the morning for.
//
// Three layers, each pinned: the renderer draws the owner's `_zones` wording
// from what a line carries; the decision puts that on a line only when the
// people being asked span clocks (and leaves a one-clock line field for field
// what it was); and a real room, end to end, says it.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupVoice = require('../src/domain/group-voice');
const groupTurn = require('../src/domain/group-turn');
const options = require('../src/domain/meeting-options');
const groupsJob = require('../src/jobs/groups');
const groupOutbox = require('../src/domain/group-outbox');
const templates = require('../src/domain/message-templates');
const { renderGroupCoordination, PLACE_ASK_ONLINE } = require('../src/domain/proactive-text');

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const SYD = 'Australia/Sydney';

// פנתרה's own option 62, as a line would carry it.
const SAT = { startsAt: '2026-09-26T17:00:00Z', allDay: false, daypart: null, authorTz: IL };
const clocks = (extra) => ({ multiZone: true, zones: [IL, NY, SYD], roomTz: IL, ...extra });

// ---- the renderer ------------------------------------------------------------

test('"סגור" on several clocks: the day, a line per clock, and how they connect', () => {
  const body = renderGroupCoordination(clocks({
    kind: 'done', slot: 'יום שבת 26.9 20:00', who: { all: true, phones: [] }, placeAsk: true, at: { slot: SAT },
  }));
  assert.equal(body, [
    'סגור: *יום שבת 26.9* 🎉 כולם בפנים',
    '20:00 ישראל',
    '13:00 ניו יורק',
    '03:00 סידני (יום ראשון 27.9)',
    PLACE_ASK_ONLINE,
  ].join('\n'));
  assert.doesNotMatch(body, /איפה נפגשים/, 'people on several clocks are not meeting in one room');
});

test('"יש כיוון" on several clocks, and the moved line built from it', () => {
  const base = clocks({ kind: 'base', slot: 'יום שבת 26.9 20:00', yes: 2, total: 4, missing: ['+972501234567'], more: 1, at: { slot: SAT } });
  assert.equal(renderGroupCoordination(base), [
    'יש כיוון: *יום שבת 26.9* — 2 מתוך 4 בפנים.',
    '20:00 ישראל', '13:00 ניו יורק', '03:00 סידני (יום ראשון 27.9)',
    'עוד לא ענו: @+972501234567 ועוד 1',
    'רוצים לסגור בלי מי שלא ענה? תכתבו לי ״סגור״ 👍',
  ].join('\n'));
  const noon = { ...SAT, startsAt: '2026-09-26T09:00:00Z' };
  const moved = renderGroupCoordination({ ...base, kind: 'moved', was: 'יום שבת 26.9 12:00', at: { slot: SAT, was: noon } });
  assert.match(moved, /^\*יום שבת 26\.9 · 12:00 ישראל · 05:00 ניו יורק · 19:00 סידני\* כבר לא על השולחן 🔄\nיש כיוון:/);
});

test('the one-line lines join every clock with " · "', () => {
  const inline = 'יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)';
  assert.equal(renderGroupCoordination(clocks({ kind: 'soon', slot: 'יום שבת 26.9 20:00', at: { slot: SAT } })),
    `עוד שעה: *${inline}* 🙂`);
  assert.equal(renderGroupCoordination(clocks({ kind: 'dayof', slot: 'יום שבת 26.9 20:00', at: { slot: SAT } })),
    `מזכירה — *${inline}* 👋`, 'no "היום": in Sydney it may already be tomorrow');
  assert.equal(renderGroupCoordination(clocks({ kind: 'table', count: 3, lead: 'יום שבת 26.9 20:00', at: { lead: SAT } })),
    `השולחן זז — עכשיו *3* מועדים על הפרק. הכי מתקדם: *${inline}*.`);
  assert.equal(renderGroupCoordination(clocks({
    kind: 'relay', userId: 7, from: '+972542636760', what: 'בבוקר קשה לי', added: 'יום שבת 26.9 20:00', at: { added: SAT },
  })), `@+972542636760: בבוקר קשה לי — הוספתי את האופציה *${inline}* 📣`);
});

test('the opening says which clocks the room is on', () => {
  const body = renderGroupCoordination(clocks({ kind: 'started', title: 'שיחת וידאו', asked: 3, total: 4, outside: 0, at: {} }));
  assert.match(body, /אתם פרוסים על ישראל, ניו יורק וסידני/);
  assert.match(body, /^מתחילה לתאם \*שיחת וידאו\* לכל 4 חברי הקבוצה 🎯/);
});

test('a time with no clock in it keeps its author\'s words and city, and leaves no empty line', () => {
  const evening = { startsAt: '2026-09-29T16:00:00Z', allDay: false, daypart: 'evening', authorTz: NY };
  const body = renderGroupCoordination(clocks({
    kind: 'done', slot: 'יום שלישי 29.9 בערב', who: null, placeAsk: false, at: { slot: evening },
  }));
  assert.equal(body, 'סגור: *יום שלישי 29.9 בערב (ניו יורק)* 🎉');
});

test('a one-clock line, and a row queued before this existed, render exactly as before', () => {
  const line = { kind: 'done', slot: 'יום שבת 26.9 20:00', who: { all: true, phones: [] }, placeAsk: true };
  assert.equal(renderGroupCoordination(line), templates.render('group_coord_done', {
    slot: 'יום שבת 26.9 20:00', who: 'כולם בפנים', place_ask: 'איפה נפגשים? תכתבו לי ואני אוסיף ליומן 📍',
  }).trim());
});

test('the owner\'s rewording of a several-clocks line is the one that goes out', () => {
  const overrides = { group_coord_soon_zones: '⏰ {{slot}}' };
  assert.equal(renderGroupCoordination(clocks({ kind: 'soon', slot: 'x 20:00', at: { slot: SAT } }), overrides),
    '⏰ יום שבת 26.9 · 20:00 ישראל · 13:00 ניו יורק · 03:00 סידני (יום ראשון 27.9)');
  // …and a rewording of the one-clock line does not leak into it
  const other = { group_coord_soon: 'עוד שעה, {{slot}}' };
  assert.match(renderGroupCoordination(clocks({ kind: 'soon', slot: 'x 20:00', at: { slot: SAT } }), other), /^עוד שעה: \*/);
});

// ---- the decision --------------------------------------------------------------

const co = (zones) => ({
  status: 'confirmed', title: 'שיחה', confirmedSlot: 'יום שבת 26.9 20:00',
  confirmedStartAt: SAT.startsAt, confirmedOption: null, participants: 3, location: null,
  zones, roomTz: IL, moments: { 'יום שבת 26.9 20:00': SAT },
});
const NOW = Date.parse('2026-09-24T10:00:00Z');

test('the decision marks a line only when the people asked span clocks', () => {
  const many = groupVoice.decideGroupLine(co([IL, NY]), { nowMs: NOW, timezone: IL });
  assert.equal(many.multiZone, true);
  assert.deepEqual(many.zones, [IL, NY]);
  assert.deepEqual(many.at.slot, SAT);
  const one = groupVoice.decideGroupLine(co([IL]), { nowMs: NOW, timezone: IL });
  const bare = groupVoice.decideGroupLine({ ...co([IL]), zones: undefined, moments: undefined }, { nowMs: NOW, timezone: IL });
  assert.deepEqual(one, bare, 'one clock: the line is field for field what it was');
  assert.equal(one.multiZone, undefined);
});

// ---- a real room, end to end ---------------------------------------------------

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
beforeEach(async () => { await db.pool.query(`DELETE FROM group_outbox WHERE sent_at IS NULL`); });

// One clock for every pass, computed once: 11:00 UTC today is inside an
// Israeli room's daytime whatever hour the suite runs.
const DAY = (() => { const d = new Date(); d.setUTCHours(11, 0, 0, 0); return d; })();

async function room(n, zones) {
  const people = [];
  for (let i = 0; i < zones.length; i++) {
    const u = await makeUser(db.pool, `+9726078${n}000${i}`, { firstName: `חבר${i}` });
    await db.pool.query(`UPDATE users SET last_inbound_at = now(), timezone = $2 WHERE id = $1`, [u.id, zones[i]]);
    people.push({ ...u, timezone: zones[i] });
  }
  const group = await withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `12036333333333${n}@g.us`, subject: 'פנתרה', members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = 'Asia/Jerusalem'
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(n).padStart(2, '0').repeat(16)]);
    return rows[0];
  });
  return { group, people };
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

const hhmm = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date(iso));

test('פנתרה, end to end: the opening names the clocks, and the direction is said in each', async () => {
  const { group, people } = await room(1, [IL, IL, NY]);
  const [a, b] = people;
  const started = await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'שיחת וידאו'));
  const meetingId = Number(started.data.meeting.id);
  await db.pool.query('UPDATE meetings SET created_at = $2 WHERE id = $1', [meetingId, DAY]);
  await db.pool.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = NULL WHERE kind = 'meeting_invite' AND (payload->>'meetingId')::bigint = $1`,
    [meetingId]);

  const opening = await pass(group.external_id);
  assert.equal(opening.length, 1);
  assert.match(opening[0], /אתם פרוסים על ישראל וניו יורק/);

  const when = slotStart('שבת', { hours: 72 });
  const optionId = await withTx(db.pool, async (c) =>
    (await options.add(c, a.id, meetingId, `יום שבת ${hhmm(when, IL)}`, when)).data.option.id);
  await withTx(db.pool, (c) => options.answer(c, b.id, meetingId, optionId, 'y'));
  const direction = await pass(group.external_id);
  assert.equal(direction.length, 1);
  assert.match(direction[0], /^יש כיוון: \*יום שבת/);
  assert.ok(direction[0].includes(`\n${hhmm(when, IL)} ישראל\n`), direction[0]);
  assert.ok(direction[0].includes(`\n${hhmm(when, NY)} ניו יורק`), direction[0]);

  // The room's model reads the same drawn time, and knows whose clock is whose.
  const block = await withTx(db.pool, (c) => groupTurn.draw(c, group));
  assert.deepEqual(block.room.clocks, ['ישראל', 'ניו יורק']);
  assert.ok(block.coordination.onTable[0].roomTimes.includes(`${hhmm(when, NY)} ניו יורק`));
  assert.ok(block.room.people.some((p) => p.clock === 'ניו יורק'));
  const text = await withTx(db.pool, (c) => groupTurn.renderContext(c, group));
  assert.ok(text.includes(groupTurn.CLOCK_RULE));
  // …and never the raw clocks behind them: a zone is about a person.
  const status = await withTx(db.pool, (c) => groupMeetings.coordinationStatus(c, group));
  assert.equal(status.coordination.moments, undefined);
  assert.equal(status.coordination.zones, undefined);
});

test('a room on one clock hears, and its model reads, exactly what it did before', async () => {
  const { group, people } = await room(2, [IL, IL, IL]);
  const [a] = people;
  await withTx(db.pool, (c) => groupMeetings.startCoordination(c, group, a, 'פאדל'));
  const block = await withTx(db.pool, (c) => groupTurn.draw(c, group));
  assert.equal(block.room.clocks, undefined);
  assert.ok(block.room.people.every((p) => p.clock === undefined));
  const text = await withTx(db.pool, (c) => groupTurn.renderContext(c, group));
  assert.ok(!text.includes(groupTurn.CLOCK_RULE));
});
