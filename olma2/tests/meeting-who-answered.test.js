'use strict';
// Who can and who cannot is the same board on every surface (owner,
// 2026-10-08): the page has always shown it by name, and asked in the poker
// room Olma named nobody. In the private chat `get_meeting_status` now draws
// each time's `who`, so the model reads names and never maps ids itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, me, her, him, meetingId, a, b;

async function connect(c, x, y) {
  const req = await connections.requestConnection(c, x.id, y.phone, {});
  const conn = (await connections.respondToConnection(c, y.id, req.data.connection.id, 'approve')).data.connection;
  for (const f of ['meetings', 'sharing']) {
    await grants.grantFeature(c, x.id, conn.id, f);
    await grants.grantFeature(c, y.id, conn.id, f);
  }
}

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531920001', { firstName: 'מירון' });
  her = await makeUser(db.pool, '+972531920002', { firstName: 'מאיה' });
  him = await makeUser(db.pool, '+972531920003', { firstName: 'יובל' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  const DAY = 24 * 3600_000;
  const base = new Date(Date.now() + 3 * DAY); base.setUTCHours(17, 0, 0, 0);
  await withTx(db.pool, async (c) => {
    await connect(c, me, her);
    await connect(c, me, him);
    meetingId = Number((await meetings.startMeeting(c, me.id, 'פוקר', [her.id, him.id])).data.meeting.id);
    a = (await meetings.options.add(c, me.id, meetingId, 'option A 20:00', base.toISOString())).data.option.id;
    b = (await meetings.options.add(c, me.id, meetingId, 'option B 20:00', new Date(base.getTime() + DAY).toISOString())).data.option.id;
    await meetings.options.answer(c, her.id, meetingId, a, 'y');
    await meetings.options.answer(c, her.id, meetingId, b, 'n');
    await meetings.recordConstraint(c, her.id, meetingId, 'בצילומים ביום השני', false);
  });
});
after(async () => { if (db) await db.teardown(); });

const status = (user) => withTx(db.pool, (c) => require('../src/adapters/mcp/tools/meetings')
  .find((t) => t.name === 'get_meeting_status').handler(c, { ...user }, { meeting_id: meetingId }));

test('each time says who said yes, who said no and who has not answered, by name', async () => {
  const r = await status(me);
  assert.equal(r.ok, true, JSON.stringify(r));
  const byId = Object.fromEntries(r.data.options.map((o) => [Number(o.id), o.who]));
  // The reader is not in it: where THEY stand is the ✓/✗ on the lines.
  assert.deepEqual(byId[a], { yes: ['מאיה'], no: [], waiting: ['יובל'] });
  assert.deepEqual(byId[b], { yes: [], no: ['מאיה'], waiting: ['יובל'] });
  assert.match(r.data.hints.who, /only when asked why|Never volunteer/);
});

test('somebody who left is not on the board', async () => {
  await withTx(db.pool, (c) => meetings.optOut(c, him.id, meetingId));
  const r = await status(her);
  const o = r.data.options.find((x) => Number(x.id) === Number(a));
  assert.equal(o.who.waiting.includes('יובל'), false);
});
