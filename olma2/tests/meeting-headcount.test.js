'use strict';
// get_meeting_status's `headcount`: how many are IN on a game room's
// coordination, drawn by code so the model copies it instead of counting.
// The founding case (incidents.md, "The poker count was the people asked"):
// one yes, thirteen in the room, and Olma told a member "כרגע אנחנו 4 וצריך 5"
// because she counted the participants — the people being asked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');

let db, ann, ben, cal, dan;
const tx = (fn) => withTx(db.pool, fn);

function tomorrowAt(hh) {
  const d = new Date(Date.now() + 86400e3);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  return `${day}T${hh}:00:00+03:00`;
}

async function connect(a, b) {
  const { rows } = await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [a.id, b.id, b.phone]);
  for (const grantor of [a, b]) {
    for (const feature of ['sharing', 'meetings', 'messages']) {
      await db.pool.query(
        `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature)
         VALUES ($1, $2, $3)`, [rows[0].id, grantor.id, feature]);
    }
  }
}

let groupSeq = 0;
async function room(kind, quorumMin) {
  groupSeq += 1;
  const { rows } = await db.pool.query(
    `INSERT INTO chat_groups (channel, external_id, subject, quorum_min, kind)
     VALUES ('whatsapp', $1, 'פוקר', $2, $3) RETURNING id`,
    [`g-headcount-${groupSeq}@g.us`, quorumMin, kind]);
  return Number(rows[0].id);
}

const startIn = async (groupId) => Number((await tx((c) => meetings.startMeeting(
  c, ann.id, 'ערב פוקר', [ben.id, cal.id, dan.id], groupId ? { groupId } : {}))).data.meeting.id);
const status = async (id) => (await tx((c) => meetings.getStatus(c, ann.id, id))).data;
const optionsOf = (id) => tx((c) => meetings.options.list(c, id));

before(async () => {
  db = await freshDb();
  ann = await makeUser(db.pool, '+972531970001', { firstName: 'Ann' });
  ben = await makeUser(db.pool, '+972531970002', { firstName: 'Ben' });
  cal = await makeUser(db.pool, '+972531970003', { firstName: 'Cal' });
  dan = await makeUser(db.pool, '+972531970004', { firstName: 'Dan' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  const all = [ann, ben, cal, dan];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) await connect(all[i], all[j]);
});
after(async () => { await db.teardown(); });

test('one yes in a game room of four asked is ONE in, not four', async () => {
  const id = await startIn(await room('game', 5));
  const at = tomorrowAt('20');
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־20:00', at));
  const [opt] = await optionsOf(id);
  const s = await status(id);
  assert.equal(s.participants.length > 1, true, 'the people asked are still listed');
  assert.deepEqual(
    { inSoFar: s.headcount.inSoFar, needs: s.headcount.needs, short: s.headcount.short, optionId: s.headcount.optionId },
    { inSoFar: 1, needs: 5, short: 4, optionId: opt.id });
  assert.equal(s.headcount.slot, 'מחר ב־20:00');
});

test('the lead is the time with the most yes, and only people still in count', async () => {
  const id = await startIn(await room('game', 3));
  const early = tomorrowAt('18');
  const late = tomorrowAt('21');
  await tx((c) => meetings.proposeSlot(c, ann.id, id, 'מחר ב־18:00', early));
  await tx((c) => meetings.proposeSlot(c, ben.id, id, 'מחר ב־21:00', late));
  const lateOpt = (await optionsOf(id)).find((o) => o.slotText === 'מחר ב־21:00');
  await tx((c) => meetings.options.answer(c, cal.id, id, lateOpt.id, 'y'));
  await tx((c) => meetings.options.answer(c, dan.id, id, lateOpt.id, 'y'));
  let s = await status(id);
  assert.equal(s.headcount.optionId, lateOpt.id);
  assert.equal(s.headcount.inSoFar, 3);
  assert.equal(s.headcount.short, 0);

  // Dan leaves. His yes is still a row on the option, and it no longer counts.
  await db.pool.query(
    `UPDATE meeting_participants SET state = 'opted_out' WHERE meeting_id = $1 AND user_id = $2`, [id, dan.id]);
  s = await status(id);
  assert.equal(s.headcount.inSoFar, 2);
  assert.equal(s.headcount.short, 1);
});

test('nothing on the table is zero in, and names no option', async () => {
  const id = await startIn(await room('game', 5));
  const s = await status(id);
  assert.equal(s.headcount.inSoFar, 0);
  assert.equal(s.headcount.optionId, null);
  assert.equal(s.headcount.slot, null);
});

test('a room whose kind nobody answered, and a private coordination, carry no headcount', async () => {
  const unknown = await startIn(await room(null, null));
  await tx((c) => meetings.proposeSlot(c, ann.id, unknown, 'מחר ב־19:00', tomorrowAt('19')));
  assert.equal('headcount' in (await status(unknown)), false);

  const priv = await startIn(null);
  await tx((c) => meetings.proposeSlot(c, ann.id, priv, 'מחר ב־19:00', tomorrowAt('19')));
  assert.equal('headcount' in (await status(priv)), false);
});
