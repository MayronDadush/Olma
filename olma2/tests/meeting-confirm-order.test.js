'use strict';
// Ownership transfer needs "the first person who confirmed" to be a real total
// order, not something re-derived at read time from whatever a query returns.
// meeting_participants had no timestamp AND no surrogate id — its key is
// (meeting_id, user_id) — so that order did not exist in the data at all.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const meetings = require('../src/domain/meetings');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, host, a, b;
const at = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace('Z', '+00:00');
const when = at(24);
const later = at(48);

before(async () => {
  db = await freshDb();
  host = await makeUser(db.pool, '+972531920001', { firstName: 'מירון' });
  a = await makeUser(db.pool, '+972531920002', { firstName: 'אלף' });
  b = await makeUser(db.pool, '+972531920003', { firstName: 'בית' });
  await db.pool.query(`UPDATE users SET timezone = 'Asia/Jerusalem'`);
  await withTx(db.pool, async (c) => {
    for (const u of [a, b]) {
      const req = await connections.requestConnection(c, host.id, u.phone, {});
      const conn = (await connections.respondToConnection(
        c, u.id, req.data.connection.id, 'approve')).data.connection;
      for (const f of ['meetings', 'sharing']) {
        await grants.grantFeature(c, host.id, conn.id, f);
        await grants.grantFeature(c, u.id, conn.id, f);
      }
    }
  });
});
after(async () => { if (db) await db.teardown(); });

const stamps = async (id) => (await db.pool.query(
  `SELECT user_id, state, confirmed_at FROM meeting_participants
    WHERE meeting_id = $1 ORDER BY confirmed_at ASC NULLS LAST, user_id ASC`, [id])).rows;

test('confirmation order is recorded, and B-then-A is not A-then-B', async () => {
  const id = await withTx(db.pool, async (c) => {
    const m = (await meetings.startMeeting(c, host.id, 'סדר', [a.id, b.id])).data.meeting;
    // ONE moment, reused: respondToSlot rejects an accept whose start does not
    // match the proposal exactly, so recomputing at(24) per call is a
    // slot_changed conflict and nobody ends up confirmed at all.
    await meetings.proposeSlot(c, host.id, m.id, 'מחר', when);
    // B answers first, deliberately out of user_id order — the whole point is
    // that the successor is who confirmed first, not who has the lower id.
    assert.equal((await meetings.respondToSlot(c, b.id, m.id, true, null, null, when)).ok, true);
    assert.equal((await meetings.respondToSlot(c, a.id, m.id, true, null, null, when)).ok, true);
    return m.id;
  });
  const rows = await stamps(id);
  assert.equal(String(rows[0].user_id), String(host.id), 'the proposer confirmed first');
  assert.equal(String(rows[1].user_id), String(b.id), 'B answered before A and must sort before A');
  assert.equal(String(rows[2].user_id), String(a.id));
  assert.ok(rows.every((r) => r.confirmed_at), 'a confirmed participant with no timestamp');
});

test('a new proposal clears the old round rather than carrying its order over', async () => {
  const id = await withTx(db.pool, async (c) => {
    const m = (await meetings.startMeeting(c, host.id, 'סבב שני', [a.id, b.id])).data.meeting;
    await meetings.proposeSlot(c, host.id, m.id, 'ראשון', when);
    assert.equal((await meetings.respondToSlot(c, b.id, m.id, true, null, null, when)).ok, true);
    // Host moves the evening. B agreed to a DIFFERENT one and must not keep a
    // stamp that would make him the successor for a slot he never saw.
    await meetings.proposeSlot(c, host.id, m.id, 'שני', later);
    return m.id;
  });
  const rows = await stamps(id);
  const byUser = Object.fromEntries(rows.map((r) => [String(r.user_id), r]));
  assert.equal(byUser[String(b.id)].state, 'awaiting');
  assert.equal(byUser[String(b.id)].confirmed_at, null, 'a stale confirmation time survived a re-proposal');
  assert.ok(byUser[String(host.id)].confirmed_at, 'the new proposer was not stamped');
});

test('accepting the same slot twice does not move you to the back', async () => {
  let id, first;
  await withTx(db.pool, async (c) => {
    const m = (await meetings.startMeeting(c, host.id, 'כפול', [a.id, b.id])).data.meeting;
    await meetings.proposeSlot(c, host.id, m.id, 'מחר', when);
    assert.equal((await meetings.respondToSlot(c, a.id, m.id, true, null, null, when)).ok, true);
    id = m.id;
  });
  first = (await stamps(id)).find((r) => String(r.user_id) === String(a.id)).confirmed_at;
  await withTx(db.pool, (c) => meetings.respondToSlot(c, a.id, id, true, null, null, when));
  const again = (await stamps(id)).find((r) => String(r.user_id) === String(a.id)).confirmed_at;
  assert.deepEqual(again, first, 're-accepting rewrote the confirmation time');
});

test('rows confirmed before the column existed sort last, deterministically', async () => {
  const id = await withTx(db.pool, async (c) => {
    const m = (await meetings.startMeeting(c, host.id, 'ישן', [a.id, b.id])).data.meeting;
    await meetings.proposeSlot(c, host.id, m.id, 'מחר', when);
    assert.equal((await meetings.respondToSlot(c, a.id, m.id, true, null, null, when)).ok, true);
    assert.equal((await meetings.respondToSlot(c, b.id, m.id, true, null, null, when)).ok, true);
    return m.id;
  });
  // Exactly the production shape: confirmed, but predating the column.
  await db.pool.query(
    `UPDATE meeting_participants SET confirmed_at = NULL WHERE meeting_id = $1 AND user_id = ANY($2::bigint[])`,
    [id, [a.id, b.id]]);
  const rows = await stamps(id);
  assert.equal(String(rows[0].user_id), String(host.id), 'a known time must outrank an unknown one');
  // NULLS LAST leaves the two unknowns tied, and user_id breaks the tie the
  // same way every time — the order is arbitrary but never irreproducible.
  assert.deepEqual(rows.slice(1).map((r) => String(r.user_id)),
    [a.id, b.id].map(String).sort((x, y) => Number(x) - Number(y)));
});
