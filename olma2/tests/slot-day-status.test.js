'use strict';
// A slot is the proposer's words, and "מחר" in them is true on the day they
// were written (2026-10-06: the poker room heard "מחר (שלישי) בערב" on the
// Tuesday). The room's lines and the private messages were fixed first; this
// is `get_meeting_status`, which hands the model the table it reads back.
//
// The moments are built off the live clock ONCE, at 19:00 in Israel one and two
// days ahead, so they are in the future whatever hour the suite runs
// (.claude/rules/testing.md).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const dt = require('../src/domain/datetime');
const { DAYS_HE } = require('../src/domain/meeting-time');

const IL = 'Asia/Jerusalem';
const ahead = (days) => {
  const p = dt.partsInZone(IL, new Date());
  const noon = new Date(Date.UTC(p.y, p.m - 1, p.d + days, 12));
  const q = dt.partsInZone(IL, noon);
  const at = new Date(dt.instantInZone(IL, { y: q.y, m: q.m, d: q.d, hh: 19, mi: 0, ss: 0 }));
  return { iso: at.toISOString(), weekday: DAYS_HE[dt.weekdayOfParts(q)] };
};
const TOMORROW = ahead(1);
const LATER = ahead(2);

let db, ann, ben;
before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972533000001', { firstName: 'Ann', timezone: IL });
  ben = await makeUser(db.pool, '+972533000002', { firstName: 'Ben', timezone: IL });
  const c = await db.pool.connect();
  try {
    const req = await connections.requestConnection(c, ann.id, ben.phone, {});
    const conn = (await connections.respondToConnection(c, ben.id, req.data.connection.id, 'approve')).data.connection;
    await grants.grantFeature(c, ann.id, conn.id, 'meetings');
    await grants.grantFeature(c, ben.id, conn.id, 'meetings');
  } finally { c.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('a stale "מחר" on the table is said as the day it is now, in the options and the row alike', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, ann.id, 'פוקר', [ben.id])).data.meeting.id);
    // Written yesterday about tomorrow, read today: "מחר" now means the wrong day.
    const added = await meetings.options.add(c, ann.id, m, 'מחר בערב', LATER.iso, { daypart: 'evening' });
    assert.equal(added.ok, true, JSON.stringify(added.error));

    const st = await meetings.getStatus(c, ben.id, m);
    assert.equal(st.ok, true);
    const [opt] = st.data.options;
    assert.ok(!opt.slotText.includes('מחר'), opt.slotText);
    assert.ok(opt.slotText.includes(LATER.weekday) && opt.slotText.endsWith('בערב'), opt.slotText);
    assert.equal(st.data.meeting.proposed_slot, opt.slotText, 'the row says the same time the same way');

    // Nothing is rewritten: the stored words are the proposer's.
    const { rows } = await c.query('SELECT slot_text FROM meeting_options WHERE id = $1', [opt.id]);
    assert.equal(rows[0].slot_text, 'מחר בערב');
  });
});

test('a word that is still true is left exactly as it was said', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, ann.id, 'קפה', [ben.id])).data.meeting.id);
    await meetings.options.add(c, ann.id, m, 'מחר בערב', TOMORROW.iso, { daypart: 'evening' });
    const st = await meetings.getStatus(c, ben.id, m);
    assert.equal(st.data.options[0].slotText, 'מחר בערב');
    assert.equal(st.data.meeting.proposed_slot, 'מחר בערב');
  });
});

test('"היום" said yesterday about today-plus-one becomes "מחר (weekday)"', async () => {
  await withClient(async (c) => {
    const m = Number((await meetings.startMeeting(c, ann.id, 'ריצה', [ben.id])).data.meeting.id);
    await meetings.options.add(c, ann.id, m, 'היום בערב', TOMORROW.iso, { daypart: 'evening' });
    const st = await meetings.getStatus(c, ben.id, m);
    assert.equal(st.data.options[0].slotText, `מחר (${TOMORROW.weekday}) בערב`);
  });
});
