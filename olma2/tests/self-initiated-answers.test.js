'use strict';
// A turn Olma started is not the person answering (2026-10-04). A check-in
// turn wrote a yes onto a coordination its reader had never been asked about,
// and the room counted it. The three tools that write a person's own answer
// refuse inside such a turn — unless the person has written since it began,
// because inside the grace minute a real reply is theirs.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const options = require('../src/domain/meeting-options');
const selfInitiated = require('../src/domain/self-initiated');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });
afterEach(() => selfInitiated._reset());

const tx = (fn) => withTx(db.pool, fn);
const tool = (name) => require('../src/adapters/mcp/tools/meetings').find((t) => t.name === name);
const call = (name, user, args) => tx((c) => tool(name).handler(c, user, args, {}));

let seq = 0;
async function pair() {
  seq += 1;
  const a = await makeUser(db.pool, `+97253398${String(seq).padStart(2, '0')}01`, { firstName: 'Ann' });
  const b = await makeUser(db.pool, `+97253398${String(seq).padStart(2, '0')}02`, { firstName: 'Ben' });
  const { rows } = await db.pool.query(
    `INSERT INTO connections (requester_id, target_id, target_phone, status, responded_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`, [a.id, b.id, b.phone]);
  for (const g of [a, b]) {
    await db.pool.query(
      `INSERT INTO connection_feature_grants (connection_id, grantor_id, feature) VALUES ($1, $2, 'meetings')`,
      [rows[0].id, g.id]);
  }
  const id = Number((await tx((c) => meetings.startMeeting(c, a.id, 'פאדל', [b.id]))).data.meeting.id);
  const at = slotStart('שבת', { hours: 72 });
  await tx((c) => meetings.proposeSlot(c, a.id, id, 'שבת 17:00', at));
  const opt = (await tx((c) => options.list(c, id)))[0];
  return { a, b, id, opt };
}

test('inside a turn Olma started, nothing is answered for them', async () => {
  const { b, id, opt } = await pair();
  await db.pool.query(`UPDATE users SET last_woke_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
  selfInitiated.begin(b.id);

  const yes = await call('respond_to_meeting_slot', b,
    { meeting_id: id, accept: true, accepted_starts_at: new Date(opt.startsAt).toISOString() });
  assert.equal(yes.ok, false);
  assert.equal(yes.error.reason, 'not_their_turn');
  const out = await call('opt_out_of_meeting', b, { meeting_id: id });
  assert.equal(out.error.reason, 'not_their_turn');
  const back = await call('rejoin_meeting', b, { meeting_id: id });
  assert.equal(back.error.reason, 'not_their_turn');

  // Written ninety seconds before it began: still their conversation.
  await db.pool.query(`UPDATE users SET last_woke_at = now() - interval '90 seconds' WHERE id = $1`, [b.id]);
  const theirs = await call('respond_to_meeting_slot', b,
    { meeting_id: id, accept: false, accepted_starts_at: new Date(opt.startsAt).toISOString() });
  assert.equal(theirs.ok, true, theirs.ok ? '' : JSON.stringify(theirs.error));
  await db.pool.query(`DELETE FROM meeting_option_answers WHERE user_id = $1`, [b.id]);
  await db.pool.query(`UPDATE meeting_participants SET state = 'awaiting' WHERE user_id = $1`, [b.id]);

  const { rows } = await db.pool.query(
    `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [id, b.id]);
  assert.equal(rows[0].state, 'awaiting', 'nothing was written');
  assert.deepEqual((await tx((c) => options.list(c, id)))[0].answers[String(b.id)], undefined);
});

test('a reply they wrote inside the grace minute is theirs, and outside any mark nothing changes', async () => {
  const { b, id, opt } = await pair();
  await db.pool.query(`UPDATE users SET last_woke_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
  selfInitiated.begin(b.id);
  await new Promise((r) => setTimeout(r, 5));
  // The gateway opener stamped their message after our delivery began.
  await db.pool.query(`UPDATE users SET last_woke_at = now() WHERE id = $1`, [b.id]);
  const yes = await call('respond_to_meeting_slot', b,
    { meeting_id: id, accept: true, accepted_starts_at: new Date(opt.startsAt).toISOString() });
  assert.equal(yes.ok, true, yes.ok ? '' : JSON.stringify(yes.error));

  selfInitiated._reset();
  const out = await call('opt_out_of_meeting', b, { meeting_id: id });
  assert.equal(out.ok, true, out.ok ? '' : JSON.stringify(out.error));
});
