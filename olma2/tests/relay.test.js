'use strict';
// Person-to-person relayed messages — the domain rules on their own:
// gating, text bounds, and what the audit trail does and does not record.
// The broker-path behaviour (fan-out, instruction text, revoke/regrant)
// lives in notifications.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const connections = require('../src/domain/connections');
const relay = require('../src/domain/relay');

let db, alice, boaz, carol;
before(async () => {
  db = await freshDb();
  alice = await makeUser(db.pool, '+972531000001', { firstName: 'Alice' });
  boaz = await makeUser(db.pool, '+972531000002', { firstName: 'Boaz' });
  carol = await makeUser(db.pool, '+972531000003', { firstName: 'Carol' });
  // alice ↔ boaz are friends; carol is a stranger to both
  const client = await db.pool.connect();
  try {
    const req = await connections.requestConnection(client, alice.id, boaz.phone, {});
    await connections.respondToConnection(client, boaz.id, req.data.connection.id, 'approve');
  } finally { client.release(); }
});
after(async () => { await db.teardown(); });

async function withClient(fn) {
  const client = await db.pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

test('a message to a friend becomes one urgent outbox row; content stays out of the audit trail', async () => {
  await withClient(async (c) => {
    const res = await relay.relayMessage(c, alice, boaz, '  אל תשכח את המפתחות  ');
    assert.equal(res.ok, true);
    assert.equal(res.data.queued, true);

    const { rows } = await c.query(
      `SELECT * FROM outbox WHERE user_id = $1 AND kind = 'relayed_message'`, [boaz.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].urgency, 'urgent');
    assert.equal(rows[0].payload.text, 'אל תשכח את המפתחות'); // trimmed
    assert.equal(rows[0].payload.fromName, 'Alice');

    // The audit row records THAT a message crossed, never what it said — the
    // content lives only in the outbox row, pruned like every operational row.
    const { rows: audit } = await c.query(
      `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'relay.sent'`, [alice.id]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.toUserId, Number(boaz.id));
    assert.ok(!JSON.stringify(audit[0].detail).includes('מפתחות'));
  });
});

test('no connection means no relay, and the error says which part is missing', async () => {
  await withClient(async (c) => {
    const stranger = await relay.relayMessage(c, alice, carol, 'שלום');
    assert.equal(stranger.ok, false);
    assert.equal(stranger.error.reason, 'not_connected');
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'relayed_message'`, [carol.id]);
    assert.equal(rows[0].n, 0);
  });
});

test('empty and over-length messages are refused, never truncated', async () => {
  await withClient(async (c) => {
    const empty = await relay.relayMessage(c, alice, boaz, '   ');
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, 'invalid');

    const long = await relay.relayMessage(c, alice, boaz, 'א'.repeat(relay.MAX_MESSAGE_CHARS + 1));
    assert.equal(long.ok, false);
    assert.equal(long.error.code, 'invalid');
    assert.match(long.error.message, /shorten/); // the agent gets a next step, not a trim

    // nothing partial was queued for either failure
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM outbox WHERE user_id = $1 AND kind = 'relayed_message'`, [boaz.id]);
    assert.equal(rows[0].n, 1); // just the message from the first test
  });
});
