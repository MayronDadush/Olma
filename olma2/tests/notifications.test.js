'use strict';
// Cross-user event fan-out: every state change the OTHER side must hear about
// becomes an outbox row. Exercised through the real broker dispatch path
// (auth → tx → handler → fanout), the way production runs it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, broker, miron, kapish;

async function call(user, name, args) {
  const res = await broker.dispatch({
    id: 1, method: 'tool_call',
    params: { name, args: { identity_token: user.identity_token, ...args } },
  });
  assert.ok(res.ok, `${name} transport failed`);
  return res.text;
}

async function outboxFor(userId, kind) {
  const { rows } = await db.pool.query(
    `SELECT * FROM outbox WHERE user_id = $1 AND kind = $2 ORDER BY id`, [userId, kind]);
  return rows;
}

before(async () => {
  db = await freshDb();
  broker = createBrokerServer({ pool: db.pool });
  miron = await makeUser(db.pool, '+972621000001', { firstName: 'Miron' });
  kapish = await makeUser(db.pool, '+972621000002', { firstName: 'Kapish' });
  await withTx(db.pool, async (c) => {
    const req = await connections.requestConnection(c, miron.id, kapish.phone, {});
    const conn = (await connections.respondToConnection(c, kapish.id, req.data.connection.id, 'approve')).data.connection;
    for (const uid of [miron.id, kapish.id]) {
      await grants.grantFeature(c, uid, conn.id, 'meetings');
      await grants.grantFeature(c, uid, conn.id, 'sharing');
    }
  });
});
after(async () => { await db.teardown(); });

test('meeting lifecycle fans out at every turn', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'coffee', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);

  // kapish hears the invite
  let rows = await outboxFor(kapish.id, 'meeting_invite');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.byName, 'Miron');
  assert.equal(rows[0].urgency, 'urgent');

  // miron proposes → kapish hears the slot, miron does not self-notify
  await call(miron, 'propose_meeting_slot', { meeting_id: meetingId, slot_description: 'Tuesday 17:00, cafe' });
  rows = await outboxFor(kapish.id, 'meeting_slot_proposed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Tuesday 17:00, cafe');
  assert.equal((await outboxFor(miron.id, 'meeting_slot_proposed')).length, 0);

  // kapish declines with a counter → miron hears the NEW slot
  await call(kapish, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: false, counter_proposal: 'Wednesday 18:00, phone' });
  rows = await outboxFor(miron.id, 'meeting_slot_proposed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Wednesday 18:00, phone');

  // miron accepts → gate closes → kapish hears CONFIRMED exactly once
  const accepted = await call(miron, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: true });
  assert.match(accepted, /"meetingStatus":"confirmed"/);
  rows = await outboxFor(kapish.id, 'meeting_confirmed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Wednesday 18:00, phone');
});

test('plain decline notifies the initiator; cancel notifies participants', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'lunch', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);
  await call(miron, 'propose_meeting_slot', { meeting_id: meetingId, slot_description: 'Sunday 12:00' });

  await call(kapish, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: false });
  const declined = await outboxFor(miron.id, 'meeting_slot_declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].payload.byName, 'Kapish');

  await call(miron, 'cancel_meeting', { meeting_id: meetingId });
  const cancelled = await outboxFor(kapish.id, 'meeting_cancelled');
  assert.equal(cancelled.length, 1);
});

test('share offer and response fan out to the right sides', async () => {
  const added = await call(miron, 'add_task', { title: 'groceries run' });
  const taskId = Number(/"id":"?(\d+)/.exec(added)[1]);
  await call(miron, 'share_task_with', { task_id: taskId, phone: kapish.phone, role: 'editor' });

  const offers = await outboxFor(kapish.id, 'share_offer');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].payload.taskTitle, 'groceries run');
  assert.equal(offers[0].payload.role, 'editor');
  assert.equal(offers[0].urgency, 'normal'); // not worth waking anyone over

  await call(kapish, 'respond_to_share', { share_id: offers[0].payload.shareId, decision: 'accept' });
  const resp = await outboxFor(miron.id, 'share_response');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].payload.decision, 'accept');
});

test('connection approval notifies the requester and hints the grants step', async () => {
  const gali = await makeUser(db.pool, '+972621000003', { firstName: 'Gali' });
  await call(miron, 'request_connection', { phone: gali.phone, reason: 'לתאם דברים' });
  const pending = await outboxFor(gali.id, 'connection_request');
  assert.equal(pending.length, 1);

  const approved = await call(gali, 'respond_to_connection_request', {
    connection_id: pending[0].payload.connectionId, decision: 'approve',
  });
  assert.match(approved, /grant_connection_feature/); // approver's agent gets the next step
  const resp = await outboxFor(miron.id, 'connection_response');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].payload.decision, 'approve');
});

test('every proactive instruction forbids sending tools — one message, one delivery', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  // Live incident: the welcome said "Send the following message", so the agent
  // both said it (auto-delivered by --deliver) and called a send tool. The
  // user got it twice, 2.6s apart, with two different WhatsApp message ids.
  const kinds = ['welcome', 'checkin', 'reminder', 'digest', 'unblock_summary',
    'connection_intro', 'registration_reopened'];
  for (const kind of kinds) {
    const s = instructionFor({ kind, payload: { text: 'X', tasks: [], slot: 'y' } });
    assert.match(s, /^DELIVERY:/, `${kind} carries the delivery preamble`);
    assert.match(s, /Never call a message-sending tool/, `${kind} forbids the tool`);
  }
  // payload.instruction is a second entry point (checkin builds its own) —
  // it must not bypass the preamble
  const custom = instructionFor({ kind: 'checkin', payload: { instruction: 'Ask about the meeting.' } });
  assert.match(custom, /^DELIVERY:/);
  assert.match(custom, /Ask about the meeting\./);
});

test('welcome replays what they wrote to the silent greeter instead of ignoring it', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  const s = instructionFor({
    kind: 'welcome',
    payload: { text: 'WELCOME TEXT', firstMessage: 'יש לי משימה\nללכת לעבודה מחר' },
  });
  assert.match(s, /ללכת לעבודה מחר/, 'their actual words reach their own agent');
  assert.match(s, /<<</, 'wrapped as untrusted data, not instructions');
  assert.match(s, /ANSWER IT PROPERLY/, 'substantive first messages get handled, not re-requested');
  assert.match(s, /Never ask them to repeat/);
});
