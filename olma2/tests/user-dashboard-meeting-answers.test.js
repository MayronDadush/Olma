'use strict';
// A live meeting showed both people as unanswered. One of them had answered —
// with a constraint ("לא פנויה עד 22:00 — ואחריה יכולה"), which is neither yes
// nor no, and which loadMeetings dropped on the floor. The tri-state rendered
// her identical to somebody who had never opened the message, so the screen
// reported silence from a person who had spoken. Same shape as every other
// entry on this project's list: "read, found nothing" collapsed into "not read".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const dash = require('../src/domain/user-dashboard');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, me, her, meetingId;

before(async () => {
  db = await freshDb();
  me = await makeUser(db.pool, '+972531910001', { firstName: 'מירון' });
  her = await makeUser(db.pool, '+972531910002', { firstName: 'מאיה' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, me.id, '+972531910002', {});
    const conn = (await connections.respondToConnection(
      c, her.id, req.data.connection.id, 'approve')).data.connection;
    for (const f of ['meetings', 'sharing']) {
      await grants.grantFeature(c, me.id, conn.id, f);
      await grants.grantFeature(c, her.id, conn.id, f);
    }
    const m = await meetings.startMeeting(c, me.id, 'דייט זוגי', [her.id]);
    meetingId = m.data.meeting.id;
  });
});
after(async () => { if (db) await db.teardown(); });

const load = (uid) => withTx(db.pool, (c) => dash.load(c, uid));
const meAndHer = async (uid) => {
  const res = await load(uid);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const m = res.data.meetings.find((x) => String(x.id) === String(meetingId));
  assert.ok(m, 'meeting missing from payload');
  return Object.fromEntries(m.participants.map((p) => [p.name, p]));
};

test('before anybody speaks, silence is silence', async () => {
  const p = await meAndHer(me.id);
  assert.equal(p['מאיה'].answered, false);
  assert.deepEqual(p['מאיה'].said, []);
});

test('a constraint is an answer, and the sentence travels with it', async () => {
  await withTx(db.pool, (c) => meetings.recordConstraint(
    c, her.id, meetingId, 'ביום שני לא פנויה עד 22:00 — ואחריה יכולה', false));
  const p = await meAndHer(me.id);
  // Still neither yes nor no — that must not change.
  assert.equal(p['מאיה'].answer, '');
  // But no longer indistinguishable from someone who never replied.
  assert.equal(p['מאיה'].answered, true);
  assert.deepEqual(p['מאיה'].said, ['ביום שני לא פנויה עד 22:00 — ואחריה יכולה']);
});

test('a private constraint reaches its author and nobody else', async () => {
  await withTx(db.pool, (c) => meetings.recordConstraint(
    c, her.id, meetingId, 'סיבה אישית', true));
  const mine = await meAndHer(her.id);
  assert.ok(mine['מאיה'].said.includes('סיבה אישית'), 'author cannot see their own private note');
  const theirs = await meAndHer(me.id);
  assert.ok(!theirs['מאיה'].said.includes('סיבה אישית'), 'a private constraint leaked to the other side');
  // ...and the shareable one is still there, so the filter did not take both.
  assert.ok(theirs['מאיה'].said.some((t) => t.includes('22:00')));
});

test('an explicit yes is answered too, with or without anything said', async () => {
  const you = await makeUser(db.pool, '+972531910003', { firstName: 'שקטה' });
  let id;
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, me.id, '+972531910003', {});
    const conn = (await connections.respondToConnection(
      c, you.id, req.data.connection.id, 'approve')).data.connection;
    for (const f of ['meetings', 'sharing']) {
      await grants.grantFeature(c, me.id, conn.id, f);
      await grants.grantFeature(c, you.id, conn.id, f);
    }
    const m = await meetings.startMeeting(c, me.id, 'קפה', [you.id]);
    id = m.data.meeting.id;
    const when = new Date(Date.now() + 86400_000).toISOString();
    await meetings.proposeSlot(c, me.id, id, 'מחר ב-10', when);
    await meetings.respondToSlot(c, you.id, id, true, null, null, when);
  });
  const res = await load(me.id);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
  const m = res.data.meetings.find((x) => String(x.id) === String(id));
  const p = m.participants.find((x) => x.name === 'שקטה');
  assert.equal(p.answer, 'y');
  assert.equal(p.answered, true, 'a plain yes read as unanswered');
});
