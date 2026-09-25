'use strict';
// Hours that suit every clock in a room, computed by code (owner, 2026-09-25).
// The founding case is פנתרה: מירון asked her to "suggest hours that suit
// Australia, New York and Israel", and she answered that she would ask each of
// them privately — there was nothing to answer from. Every moment below is a
// fixed instant, so nothing here depends on when the suite runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mt = require('../src/domain/meeting-time');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const groupMeetings = require('../src/domain/group-meetings');
const groupTurn = require('../src/domain/group-turn');

const IL = 'Asia/Jerusalem';
const NY = 'America/New_York';
const SYD = 'Australia/Sydney';
const LA = 'America/Los_Angeles';
// Sunday 27.9.2026, 06:00 in Israel — a whole week before Sydney's clock change.
const SUNDAY = new Date('2026-09-27T03:00:00Z');

test('Israel, New York and Sydney meet at 15:00 in Israel, every day of that week', () => {
  const r = mt.commonHours([{ tz: IL }, { tz: NY }, { tz: SYD }], IL, { from: SUNDAY, days: 7 });
  assert.deepEqual(r.clocks, ['ישראל', 'ניו יורק', 'סידני']);
  assert.deepEqual(r.lines, ['יום ראשון 27.9 עד יום שבת 3.10: 15:00 ישראל · 08:00 ניו יורק · 22:00 סידני']);
});

test('the day Sydney changes its clock stands out, and a day with nothing inside 08-22 is widened and says so', () => {
  const r = mt.commonHours([{ tz: IL }, { tz: NY }, { tz: SYD }], IL,
    { from: new Date('2026-10-04T21:00:00Z'), days: 2 });
  assert.match(r.lines[0], /^יום שני 5\.10: /);
  assert.match(r.lines[0], /14:00–15:00 ישראל · 07:00–08:00 ניו יורק · 22:00–23:00 סידני/);
  assert.match(r.lines[0], /מחוץ ל־08:00–22:00, בטווח 07:00–23:00/);
});

test('a guessed clock is shown beside the answer and never chooses it', () => {
  const counted = mt.commonHours([{ tz: IL }, { tz: NY }, { tz: SYD }], IL, { from: SUNDAY, days: 1 });
  const withGuess = mt.commonHours([{ tz: IL }, { tz: NY }, { tz: SYD }, { tz: LA, confirmed: false }], IL,
    { from: SUNDAY, days: 1 });
  assert.deepEqual(withGuess.unconfirmed, ['לוס אנג׳לס']);
  assert.equal(withGuess.lines[0], `${counted.lines[0]} (לא מאושר: 05:00 לוס אנג׳לס)`);
});

test('one clock is no question, and neither is one confirmed clock beside a guess', () => {
  assert.equal(mt.commonHours([{ tz: IL }, { tz: 'Asia/Tel_Aviv' }], IL, { from: SUNDAY }), null);
  assert.equal(mt.commonHours([{ tz: LA, confirmed: false }], IL, { from: SUNDAY }), null);
});

test('asked late in the evening, today is not led with "nothing suits"', () => {
  const r = mt.commonHours([{ tz: IL }, { tz: NY }, { tz: SYD }], IL,
    { from: new Date('2026-09-26T20:00:00Z'), days: 2 });
  assert.match(r.lines[0], /^יום ראשון 27\.9/);
});

// ---- through the room ---------------------------------------------------------

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

async function room(zones) {
  const people = [];
  for (let i = 0; i < zones.length; i++) {
    const u = await makeUser(db.pool, `+97260791${i}00${zones.length}`, { firstName: `חבר${i}` });
    await db.pool.query(
      `UPDATE users SET last_inbound_at = now(), timezone = $2, timezone_confirmed = $3 WHERE id = $1`,
      [u.id, zones[i].tz, zones[i].confirmed !== false]);
    people.push(u);
  }
  return withTx(db.pool, async (c) => {
    const reg = await groups.registerGroup(c, {
      externalId: `1203635555555${zones.length}@g.us`, subject: 'פנתרה',
      members: people.map((u) => ({ phone: u.phone })),
    });
    const { rows } = await c.query(
      `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3, timezone = $4
        WHERE id = $1 RETURNING *`,
      [reg.data.group.id, `g-${reg.data.group.id}`, 'olma_grp_' + String(60 + zones.length).repeat(16), IL]);
    return rows[0];
  });
}

test('פנתרה: only Israel is confirmed, so the block has no answer — and the places the room named give one', async () => {
  const group = await room([{ tz: IL }, { tz: IL, confirmed: false }, { tz: LA, confirmed: false }]);
  const block = await groupTurn.draw(db.pool, group);
  assert.deepEqual(block.room.clocks, ['ישראל', 'לוס אנג׳לס']);
  assert.equal(block.room.commonHours, undefined, 'one confirmed clock chooses nothing');
  assert.match(groupTurn.CLOCK_RULE, /places/);

  const asked = await groupMeetings.coordinationStatus(db.pool, group, { places: [SYD, NY, 'Mars/Olympus'] });
  assert.deepEqual(asked.commonHours.clocks, ['ישראל', 'ניו יורק', 'סידני']);
  assert.deepEqual(asked.commonHours.unconfirmed, ['לוס אנג׳לס']);
  assert.deepEqual(asked.unknownPlaces, ['Mars/Olympus']);
  // Without `places` the status is exactly what it was.
  assert.equal((await groupMeetings.coordinationStatus(db.pool, group)).commonHours, undefined);
});

test('a room whose clocks are confirmed hears the answer in its block, before the model says a word', async () => {
  const group = await room([{ tz: IL }, { tz: NY }, { tz: SYD }, { tz: IL }]);
  const block = await groupTurn.draw(db.pool, group);
  assert.deepEqual(block.room.commonHours.clocks, ['ישראל', 'ניו יורק', 'סידני']);
  assert.ok(block.room.commonHours.lines.length >= 1);
});
