'use strict';
// A room she was removed from (owner, 2026-10-02).
//
// Nothing tells us she was taken out of a group. The roster arrives only on a
// tag, and the gateway drops WhatsApp's participants event. What is left is the
// send: room 11 answered `forbidden` on 2026-09-25 after it removed her. But
// room 3 answered `forbidden` once on 2026-09-08 and took the next line
// normally, so one refusal must never be read as a removal. A suspect is
// shown to a person, who confirms it. The code never retires a room.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const outbox = require('../src/domain/group-outbox');

const FORBIDDEN = 'gateway: OutboundDeliveryError: forbidden channel=whatsapp error=OutboundDeliveryError: forbidden';

let db;
let groupId;

before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

beforeEach(async () => {
  await db.pool.query(`DELETE FROM group_outbox`);
  const { rows } = await db.pool.query(
    `INSERT INTO chat_groups (channel, external_id, subject, state)
          VALUES ('whatsapp', 'g-' || gen_random_uuid()::text || '@g.us', 'Shabi OG', 'open')
       RETURNING id`);
  groupId = Number(rows[0].id);
});

// A finished row, `hoursAgo` back: refused (abandoned with the gateway's
// words) or delivered. Whole days apart, so two rows never share a date by
// accident whatever hour the suite runs.
async function row({ hoursAgo, refused = true, holdReason = null, error = FORBIDDEN, gid = groupId }) {
  await db.pool.query(
    `INSERT INTO group_outbox (group_id, kind, payload, attempts, claimed_at, sent_at, hold_reason, last_error, created_at)
          VALUES ($1, 'coordination', '{}'::jsonb, 2, now() - make_interval(hours => $2),
                  now() - make_interval(hours => $2), $3, $4, now() - make_interval(hours => $2))`,
    [gid, hoursAgo, refused ? 'abandoned' : holdReason, refused ? error : null]);
}

const suspects = () => withTx(db.pool, (c) => groups.removalSuspects(c));

test('one refusal is not a removal — room 3 got one and was fine', async () => {
  await row({ hoursAgo: 48 });
  await row({ hoursAgo: 48 }); // twice, the same moment: still one day
  assert.deepEqual(await suspects(), []);
});

test('refused on two different days with nothing sent since: a suspect', async () => {
  await row({ hoursAgo: 24 * 5, refused: false }); // it used to work
  await row({ hoursAgo: 72 });
  await row({ hoursAgo: 24 });
  const list = await suspects();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, groupId);
  assert.equal(list[0].subject, 'Shabi OG');
  assert.equal(list[0].days, 2);
  assert.equal(list[0].refusals, 2, 'only the refusals after the last clean send are counted');
});

test('a line that went through after the refusals clears it', async () => {
  await row({ hoursAgo: 72 });
  await row({ hoursAgo: 48 });
  await row({ hoursAgo: 24, refused: false });
  assert.deepEqual(await suspects(), []);
});

test('a send we could not confirm proves nothing either way', async () => {
  await row({ hoursAgo: 72 });
  await row({ hoursAgo: 48, refused: false, holdReason: 'unconfirmed' });
  await row({ hoursAgo: 24 });
  assert.equal((await suspects()).length, 1);
});

test('any other refusal is not this one — a dead channel is not a removal', async () => {
  const dead = 'gateway: OutboundDeliveryError: No active WhatsApp Web listener (account: default).';
  await row({ hoursAgo: 72, error: dead });
  await row({ hoursAgo: 24, error: dead });
  await row({ hoursAgo: 48, error: 'send refused' });
  assert.deepEqual(await suspects(), []);
});

test('confirming it retires the room, once, on the record, and it stops being a suspect', async () => {
  await row({ hoursAgo: 72 });
  await row({ hoursAgo: 24 });
  const first = await withTx(db.pool, (c) => groups.retire(c, groupId, { by: 'owner' }));
  assert.ok(first.ok);
  assert.equal(first.data.changed, true);
  assert.equal(first.data.group.state, 'retired');
  const again = await withTx(db.pool, (c) => groups.retire(c, groupId, { by: 'owner' }));
  assert.equal(again.data.changed, false);

  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'group.retired' AND (detail->>'groupId')::bigint = $1`, [groupId]);
  assert.equal(rows.length, 1, 'one row, not one per click');
  assert.equal(rows[0].detail.reason, 'removed_from_group');
  assert.equal(rows[0].detail.from, 'open');
  assert.deepEqual(await suspects(), []);

  // And the sweep cannot put it back on a stale roster read.
  const back = await withTx(db.pool, (c) => groups.applyState(c, groupId, 'open'));
  assert.equal(back.data.to, 'retired');
});

test('the queue keeps the gateway’s own words for a refusal, which is what the suspect list reads', async () => {
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened`,
  }));
  const deps = {
    send: async () => ({ result: 'failed', error: FORBIDDEN }),
    channelWrittenAt: () => null,
  };
  await outbox.drainOnce(db.pool, deps);
  const { rows } = await db.pool.query(`SELECT last_error FROM group_outbox WHERE group_id = $1`, [groupId]);
  assert.match(rows[0].last_error, /forbidden/);

  // A bare 'failed' (no words) still reads as it always did.
  await db.pool.query(`DELETE FROM group_outbox`);
  await withTx(db.pool, (c) => outbox.enqueue(c, {
    groupId, kind: 'opened', idempotencyKey: `g${groupId}:opened:2`,
  }));
  await outbox.drainOnce(db.pool, { send: async () => 'failed', channelWrittenAt: () => null });
  const { rows: bare } = await db.pool.query(`SELECT last_error FROM group_outbox WHERE group_id = $1`, [groupId]);
  assert.equal(bare[0].last_error, 'send refused');
});

test('the admin page names the suspect with the button, and the alert strip points at it', async () => {
  await row({ hoursAgo: 72 });
  await row({ hoursAgo: 24 });
  const { renderGroups } = require('../src/adapters/http/admin/sections/groups');
  const { collectAlerts } = require('../src/adapters/http/admin/sections/health');
  const html = await withTx(db.pool, (c) => renderGroups(c, 'tok', null, { configPath: '/nonexistent' }));
  assert.match(html, /ייתכן שהוציאו את עולמה מהקבוצות האלה/);
  assert.match(html, /action="\/group-retire"/);
  assert.match(html, new RegExp(`name="id" value="${groupId}"`));

  const alerts = await withTx(db.pool, (c) => collectAlerts(c, { hbRows: [], gateway: { status: 'live' } }));
  const pill = alerts.find((a) => a.href === '#groups');
  assert.ok(pill, 'a pill on the strip');
  assert.equal(pill.level, 'warn');
  assert.match(pill.text, /Shabi OG/);

  await withTx(db.pool, (c) => groups.retire(c, groupId, {}));
  const after = await withTx(db.pool, (c) => renderGroups(c, 'tok', null, { configPath: '/nonexistent' }));
  assert.doesNotMatch(after, /group-retire/, 'no suspects, no block');
});

// She was put back (owner, 2026-10-03). WhatsApp delivers a group's messages
// only to members, so a turn heard there after the retirement is proof.
async function heard(hoursAgo, { gid = groupId } = {}) {
  const { rows } = await db.pool.query(`SELECT external_id FROM chat_groups WHERE id = $1`, [gid]);
  const jid = rows[0].external_id;
  await db.pool.query(
    `INSERT INTO group_inbound_context (session_key, agent_id, chat_id, at)
          VALUES ($1, $2, $3, now() - make_interval(hours => $4))
     ON CONFLICT (session_key) DO UPDATE SET at = EXCLUDED.at`,
    [`agent:g-${gid}:whatsapp:group:${jid}`, `g-${gid}`, jid, hoursAgo]);
}

async function retiredAgo(hoursAgo, reason = 'removed_from_group') {
  await withTx(db.pool, (c) => groups.retire(c, groupId, { reason }));
  await db.pool.query(
    `UPDATE audit_log SET created_at = now() - make_interval(hours => $2)
      WHERE event = 'group.retired' AND (detail->>'groupId')::bigint = $1`, [groupId, hoursAgo]);
}

const restore = () => withTx(db.pool, (c) => groups.restoreReturned(c));
const stateOf = async () => (await db.pool.query(`SELECT state FROM chat_groups WHERE id = $1`, [groupId])).rows[0].state;

test('a room heard from only BEFORE it was retired stays retired', async () => {
  await heard(72);
  await retiredAgo(48);
  assert.deepEqual(await restore(), []);
  assert.equal(await stateOf(), 'retired');
});

test('a room heard from AFTER it was retired comes back, locked, once, on the record', async () => {
  await retiredAgo(48);
  await heard(1);
  assert.deepEqual(await restore(), [groupId]);
  assert.equal(await stateOf(), 'locked', 'locked, and the same pass judges it on the fresh roster');
  assert.deepEqual(await restore(), [], 'a second pass restores nothing');
  const { rows } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE event = 'group.returned' AND (detail->>'groupId')::bigint = $1`, [groupId]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].detail.heardAt && rows[0].detail.retiredAt);
});

test('a room retired for any other reason is not brought back by a message', async () => {
  await retiredAgo(48, 'owner_closed');
  await heard(1);
  assert.deepEqual(await restore(), []);
  assert.equal(await stateOf(), 'retired');
});

test('after she is back, the refusals from before her removal do not flag the room again', async () => {
  await row({ hoursAgo: 24 * 5 });
  await row({ hoursAgo: 24 * 4 });
  assert.equal((await suspects()).length, 1);
  await retiredAgo(72);
  await heard(1);
  assert.deepEqual(await restore(), [groupId]);
  assert.deepEqual(await suspects(), [], 'the old refusals are history');

  // ...and if she is removed again, new refusals count from scratch.
  await row({ hoursAgo: 0 });
  assert.deepEqual(await suspects(), [], 'one new day is still one day');
});
