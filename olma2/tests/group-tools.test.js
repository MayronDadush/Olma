'use strict';
// The group's own door: a token that is not a person's, and the two ways it
// can be got wrong. The refusals matter more than the successes here — a group
// agent that resolved to a user would be holding that person's tasks, facts
// and calendar in a room with other people in it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const groups = require('../src/domain/groups');
const users = require('../src/domain/users');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const JID = (n) => `12036300000000${n}@g.us`;
const TOKEN = (suffix) => 'olma_grp_' + String(suffix).repeat(32).slice(0, 32);

// A group that is registered, open, and provisioned as far as the columns go.
async function openGroup(client, { jid, members, token }) {
  const reg = await groups.registerGroup(client, { externalId: jid, members });
  assert.ok(reg.ok, 'the fixture group registered');
  const { rows } = await client.query(
    `UPDATE chat_groups SET state = 'open', agent_id = $2, identity_token = $3
      WHERE id = $1 RETURNING *`,
    [reg.data.group.id, `g-${reg.data.group.id}`, token]);
  return rows[0];
}

test('a group token resolves to a group and never to a person', async () => {
  const a = await makeUser(db.pool, '+972605000001');
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [a.id]);

  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(1), members: [{ phone: a.phone }], token: TOKEN('a'),
  }));

  const ok = await withTx(db.pool, (c) => groups.resolveByToken(c, TOKEN('a')));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.group.id, group.id);

  // The same string put to the PERSON door resolves to nobody. Two doors, and
  // neither can be walked through with the other one's key.
  const asUser = await withTx(db.pool, (c) => users.resolveByToken(c, TOKEN('a')));
  assert.equal(asUser.ok, false);
  const asGroup = await withTx(db.pool, (c) => groups.resolveByToken(c, a.identity_token));
  assert.equal(asGroup.ok, false);
});

test('a malformed group token is refused AS a group, not sent looking for a person', async () => {
  // The prefix decides the door, the shape decides the answer: a truncated
  // group token routed to the user door would come back "unknown identity
  // token" and send the model hunting for a file it does not have.
  assert.equal(groups.looksLikeGroupToken('olma_grp_short'), true);
  assert.equal(groups.looksLikeGroupToken('olma_tok_' + 'a'.repeat(32)), false);
  assert.equal(groups.looksLikeGroupToken(undefined), false);

  const r = await withTx(db.pool, (c) => groups.resolveByToken(c, 'olma_grp_short'));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /malformed group identity/);
  assert.match(r.error.message, /\.olma-identity/, 'and it says how to recover');
});

test('a locked group cannot act, even holding a valid token', async () => {
  const a = await makeUser(db.pool, '+972605000010');
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [a.id]);
  const missing = '+972605000011';

  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(2), members: [{ phone: a.phone }, { phone: missing }], token: TOKEN('b'),
  }));
  // Somebody in the room never wrote to her, so the group falls back to locked.
  await withTx(db.pool, async (c) => {
    const ev = await groups.evaluate(c, group.id);
    assert.equal(ev.data.state, 'locked');
    await groups.applyState(c, group.id, ev.data.state);
  });

  const r = await withTx(db.pool, (c) => groups.resolveByToken(c, TOKEN('b')));
  assert.equal(r.ok, false);
  assert.match(r.error.message, /locked, not open/,
    'the mute is at the gateway; this is the second belt for the day it fails');
});

test('who the turn acts for is read off what the gateway filed, never off the call', async () => {
  const a = await makeUser(db.pool, '+972605000020', { firstName: 'Dana' });
  const b = await makeUser(db.pool, '+972605000021', { firstName: 'Ron' });
  for (const u of [a, b]) {
    await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [u.id]);
  }
  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(3), members: [{ phone: a.phone }, { phone: b.phone }], token: TOKEN('c'),
  }));

  // Nothing filed yet: null, and null is an answer. A caller that needs a
  // person must refuse rather than pick one.
  assert.equal(await withTx(db.pool, (c) => groups.actingMember(c, group)), null);

  const sessionKey = `agent:${group.agent_id}:whatsapp:group:${group.external_id}`;
  await db.pool.query(
    `INSERT INTO group_inbound_context (session_key, agent_id, chat_id, members, sender_e164, was_mentioned, at)
     VALUES ($1, $2, $3, $4, $5, true, now())`,
    [sessionKey, group.agent_id, group.external_id, `${a.phone}, ${b.phone}`, b.phone]);

  const acting = await withTx(db.pool, (c) => groups.actingMember(c, group));
  assert.equal(acting.id, b.id, 'the member who tagged her, per the gateway');

  // Somebody who is not in this room cannot become the actor by writing into
  // the row: the join is to the group's own live membership.
  const stranger = await makeUser(db.pool, '+972605000099');
  await db.pool.query(`UPDATE group_inbound_context SET sender_e164 = $2 WHERE session_key = $1`,
    [sessionKey, stranger.phone]);
  assert.equal(await withTx(db.pool, (c) => groups.actingMember(c, group)), null);
});

test('the room status carries only what she may say out loud in the room', async () => {
  const a = await makeUser(db.pool, '+972605000030', { firstName: 'Tal' });
  await db.pool.query(`UPDATE users SET last_inbound_at = now() WHERE id = $1`, [a.id]);
  const group = await withTx(db.pool, (c) => openGroup(c, {
    jid: JID(4), members: [{ phone: a.phone, displayName: 'Tal' }, { phone: '+972605000031' }],
    token: TOKEN('d'),
  }));

  const status = await withTx(db.pool, (c) => groups.roomStatus(c, group));
  assert.deepEqual(status.members.map((m) => m.wroteToHer), [true, false]);
  // Everything here is already visible to the room: WhatsApp shows it the
  // participants, and she tags the missing ones out loud in the gate notice.
  const fields = new Set(status.members.flatMap((m) => Object.keys(m)));
  assert.deepEqual([...fields].sort(), ['displayName', 'phone', 'wroteToHer']);
});

test('every tool in the group file is a group tool, and no other file has one', () => {
  // The audience field is the whole boundary (brokerd routes on it), and it is
  // set by which HELPER a tool was written with. A `tool(...)` that lands in
  // this file by copy-paste would be offered to a group agent and refused at
  // brokerd — reachable only through a room, and confusing when it happens.
  const groupFile = require('../src/adapters/mcp/tools/group');
  for (const t of groupFile) assert.equal(t.audience, 'group', `${t.name} is a group tool`);
  assert.deepEqual(groupFile.map((t) => t.name).sort(),
    ['group_coordination_status', 'group_status', 'set_group_kind',
      'settle_group_coordination', 'start_group_coordination']);

  const { toolDefinitions } = require('../src/adapters/mcp/registry');
  const groupNames = new Set(groupFile.map((t) => t.name));
  const elsewhere = toolDefinitions({ audience: 'group' }).map((t) => t.name).filter((n) => !groupNames.has(n));
  assert.deepEqual(elsewhere, [], 'a group-audience tool defined outside tools/group.js');
});

