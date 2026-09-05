'use strict';
// Cross-user event fan-out: every state change the OTHER side must hear about
// becomes an outbox row. Exercised through the real broker dispatch path
// (auth → tx → handler → fanout), the way production runs it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');

let db, broker, miron, kapish;

async function call(user, name, args) {
  const res = await broker.dispatch({
    id: 1, method: 'tool_call',
    params: { name, args: { olma_identity: user.identity_token, ...args } },
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
    // Approval auto-grants every feature for both sides — no manual grants.
    await connections.respondToConnection(c, kapish.id, req.data.connection.id, 'approve');
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
  await call(miron, 'propose_meeting_slot', { meeting_id: meetingId, slot_description: 'Tuesday 17:00, cafe',
    starts_at: slotStart('Tuesday 17:00, cafe') });
  rows = await outboxFor(kapish.id, 'meeting_slot_proposed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Tuesday 17:00, cafe');
  assert.equal((await outboxFor(miron.id, 'meeting_slot_proposed')).length, 0);

  // kapish declines with a counter → miron hears the NEW slot, with its
  // machine time riding along for the accept to echo back
  const wed = slotStart('Wednesday 18:00, phone', { hours: 72 });
  await call(kapish, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: false,
    counter_proposal: 'Wednesday 18:00, phone', counter_starts_at: wed });
  rows = await outboxFor(miron.id, 'meeting_slot_proposed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Wednesday 18:00, phone');
  assert.equal(rows[0].payload.startsAt, wed);

  // miron accepts → gate closes → kapish hears CONFIRMED exactly once
  const accepted = await call(miron, 'respond_to_meeting_slot',
    { meeting_id: meetingId, accept: true, accepted_starts_at: wed });
  assert.match(accepted, /"meetingStatus":"confirmed"/);
  rows = await outboxFor(kapish.id, 'meeting_confirmed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.slot, 'Wednesday 18:00, phone');
});

test('plain decline notifies the initiator; cancel notifies participants', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'lunch', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);
  await call(miron, 'propose_meeting_slot', { meeting_id: meetingId, slot_description: 'Sunday 12:00',
    starts_at: slotStart('Sunday 12:00') });

  await call(kapish, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: false });
  const declined = await outboxFor(miron.id, 'meeting_slot_declined');
  assert.equal(declined.length, 1);
  assert.equal(declined[0].payload.byName, 'Kapish');

  await call(miron, 'cancel_meeting', { meeting_id: meetingId });
  const cancelled = await outboxFor(kapish.id, 'meeting_cancelled');
  assert.equal(cancelled.length, 1);
});

// Three proposals once crossed within eight seconds and each participant got
// the whole parade of dead slots. Since options (2026-09-05) a second proposal
// does not kill the first — both are on the table, so both asks stand — but a
// yes must still name one of them, and once the meeting confirms every queued
// ask goes the dashboard way (sent_at stamped, hold_reason 'superseded', never
// DELETE): meeting_confirmed is the message everyone hears now.
test('two proposals are two options; a yes names one; confirming supersedes the asks', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'race', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);
  const sun = slotStart('Sunday 09:00, phone');
  await call(miron, 'propose_meeting_slot', {
    meeting_id: meetingId, slot_description: 'Sunday 09:00, phone', starts_at: sun });
  const tue = slotStart('Tuesday 10:00, cafe', { hours: 96 });
  await call(miron, 'propose_meeting_slot', {
    meeting_id: meetingId, slot_description: 'Tuesday 10:00, cafe', starts_at: tue });

  const rows = (await outboxFor(kapish.id, 'meeting_slot_proposed'))
    .filter((r) => Number(r.payload.meetingId) === meetingId);
  assert.equal(rows.length, 2);
  const bySlot = Object.fromEntries(rows.map((r) => [r.payload.slot, r]));
  assert.equal(bySlot['Sunday 09:00, phone'].hold_reason, null, 'the first option is still on the table');
  assert.equal(bySlot['Tuesday 10:00, cafe'].hold_reason, null);
  assert.equal(bySlot['Tuesday 10:00, cafe'].payload.startsAt, tue);

  // a yes to a moment nobody proposed is refused and shown the table; a bare
  // yes is refused too; neither records anything
  const never = slotStart('Friday 12:00', { hours: 120 });
  const stale = await call(kapish, 'respond_to_meeting_slot', {
    meeting_id: meetingId, accept: true, accepted_starts_at: never });
  assert.match(stale, /slot_changed/);
  assert.match(stale, /Sunday 09:00, phone/);
  assert.match(stale, /Tuesday 10:00, cafe/);
  const missing = await call(kapish, 'respond_to_meeting_slot', { meeting_id: meetingId, accept: true });
  assert.match(missing, /accepted_starts_at_required/);
  let st = await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(st.rows[0].status, 'negotiating');

  // the yes to SUNDAY — the older option — is a real yes to it, and with miron
  // already on it, Sunday is unanimous: confirmed to Sunday, not to the newest
  const good = await call(kapish, 'respond_to_meeting_slot', {
    meeting_id: meetingId, accept: true, accepted_starts_at: sun });
  assert.match(good, /"meetingStatus":"confirmed"/);
  assert.match(good, /Sunday 09:00, phone/);
  const after = (await outboxFor(kapish.id, 'meeting_slot_proposed'))
    .filter((r) => Number(r.payload.meetingId) === meetingId);
  for (const r of after) assert.equal(r.hold_reason, 'superseded', `${r.payload.slot} should be superseded once the meeting confirmed`);
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

test('connection approval notifies the requester and enables everything at once', async () => {
  const gali = await makeUser(db.pool, '+972621000003', { firstName: 'Gali' });
  await call(miron, 'request_connection', { phone: gali.phone, reason: 'לתאם דברים' });
  const pending = await outboxFor(gali.id, 'connection_request');
  assert.equal(pending.length, 1);

  const approved = await call(gali, 'respond_to_connection_request', {
    connection_id: pending[0].payload.connectionId, decision: 'approve',
  });
  // No toggle conversation: the approval itself enabled every feature, and
  // the approver's agent is told to continue rather than ask about features.
  assert.match(approved, /enabled automatically/);
  const { rows: granted } = await db.pool.query(
    `SELECT count(*)::int AS n FROM connection_feature_grants WHERE connection_id = $1`,
    [pending[0].payload.connectionId]);
  assert.equal(granted[0].n, grants.KNOWN_CONNECTION_FEATURES.length * 2);

  const resp = await outboxFor(miron.id, 'connection_response');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].payload.decision, 'approve');
  // The requester's own reason rides back with the approval, so their agent
  // resumes the errand instead of stranding it. Live incident: "approved!"
  // arrived bare, the original meeting request sat forgotten, and the user
  // had to repeat what they wanted.
  assert.equal(resp[0].payload.reason, 'לתאם דברים');
  const { instructionFor } = require('../src/channels/openclaw');
  const text = instructionFor({ kind: 'connection_response', payload: resp[0].payload });
  assert.ok(text.includes('<<<לתאם דברים>>>'), 'the reason must reach the agent, wrapped as data');
  assert.match(text, /without waiting to be asked again/);
  // ...and it must not send the agent chasing feature toggles any more
  assert.match(text, /enabled automatically/);
  assert.ok(!text.includes('call grant_connection_feature'), 'no toggle step in the approval flow');
});

test('a relayed message reaches the other side fenced, attributed, deduped', async () => {
  await call(miron, 'send_message_to_connection', { phone: kapish.phone, message: 'תביא את הקלפים הערב' });
  const rows = await outboxFor(kapish.id, 'relayed_message');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.fromName, 'Miron');
  assert.equal(rows[0].payload.text, 'תביא את הקלפים הערב');
  // urgent = never folds into tomorrow's digest over a budget counter, but
  // still held by the recipient's own quiet hours (gate policy, tested there).
  assert.equal(rows[0].urgency, 'urgent');

  const { instructionFor } = require('../src/channels/openclaw');
  const body = instructionFor(rows[0]);
  assert.match(body, /^DELIVERY:/);
  assert.ok(body.includes('<<<תביא את הקלפים הערב>>>'), 'the text travels as fenced data');
  assert.match(body, /Miron/);
  assert.match(body, /meeting tools/); // relay never becomes the scheduling path

  // the identical text on the same day is one row — the double-call guard
  const dup = await call(miron, 'send_message_to_connection', { phone: kapish.phone, message: 'תביא את הקלפים הערב' });
  assert.match(dup, /already on its way/);
  assert.equal((await outboxFor(kapish.id, 'relayed_message')).length, 1);
});

test('the recipient can close the message lane; the sender hears why, actionably', async () => {
  const { rows: [conn] } = await db.pool.query(
    `SELECT id FROM connections WHERE status = 'active'
       AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))`,
    [miron.id, kapish.id]);
  await call(kapish, 'revoke_connection_feature', { connection_id: Number(conn.id), feature: 'messages' });

  const refused = await call(miron, 'send_message_to_connection', { phone: kapish.phone, message: 'עוד משהו קטן' });
  assert.match(refused, /not_granted_by_them/);
  assert.equal((await outboxFor(kapish.id, 'relayed_message')).length, 1); // still just the earlier one

  // meetings/sharing are untouched by closing the messages lane
  const still = await call(miron, 'start_meeting_coordination', { title: 'walk', phones: [kapish.phone] });
  assert.match(still, /"id"/);

  // and kapish can reopen it himself
  await call(kapish, 'grant_connection_feature', { connection_id: Number(conn.id), feature: 'messages' });
  const again = await call(miron, 'send_message_to_connection', { phone: kapish.phone, message: 'עכשיו זה עובר?' });
  assert.match(again, /"queued":true/);
});

test('every proactive instruction forbids sending tools — one message, one delivery', () => {
  const { instructionFor } = require('../src/channels/openclaw');
  // Live incident: an instruction once said "Send the following message", so
  // the agent both said it (auto-delivered by --deliver) and called a send
  // tool. The user got it twice, 2.6s apart, with two different WhatsApp
  // message ids. There is no 'welcome' kind any more (2026-08-17 redesign —
  // no separate welcome message, see intake/provision.js) so it is not in
  // this list; every kind that still exists must carry the preamble.
  const kinds = ['checkin', 'reminder', 'digest', 'unblock_summary',
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

test('unanswered repair: only for messages provably never answered', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000021', { firstName: 'Tal' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);

  // readSentEvents is pinned to null (unreadable log) because this test is
  // about case (a) only. Learned on the box: the CI deploy runs this suite ON
  // the production server, where the real gateway log EXISTS — and the
  // "answered" transcript below then reads, correctly, as an assistant reply
  // with no Sent line for this fake phone, i.e. case (b). Locally the log is
  // absent and the difference is invisible.
  const sweep = (msgs) => withTx(db.pool, (c) =>
    unanswered.sweepUnanswered(c, { readDroppedTurns: () => new Map(), readMessages: () => msgs, readSentEvents: () => null, now }));

  // too fresh — the gateway's own recovery (75s) gets first chance
  assert.deepEqual((await sweep([{ role: 'user', text: 'היי', at: ago(1) }])).repaired, []);
  // answered — the transcript ends with Olma
  assert.deepEqual((await sweep([
    { role: 'user', text: 'היי', at: ago(10) },
    { role: 'assistant', text: 'שלום', at: ago(9) },
  ])).repaired, []);
  // stale — a check-in is the right tool for this, not a fake live reply
  assert.deepEqual((await sweep([{ role: 'user', text: 'היי', at: ago(90) }])).repaired, []);

  // genuinely dropped
  const hit = await sweep([
    { role: 'assistant', text: 'שלום', at: ago(12) },
    { role: 'user', text: 'יש לי משימה', at: ago(8) },
  ]);
  assert.deepEqual(hit.repaired, [u.id]);

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, urgency, expires_at, payload FROM outbox
     WHERE user_id = $1 AND payload->>'rung' = 'unanswered_repair'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urgency, 'urgent');
  assert.ok(rows[0].expires_at, 'expires rather than arriving hours late');
  // the agent decides — we detect a candidate, it has the conversation
  assert.match(rows[0].payload.checkinInstruction, /NO_REPLY/);
  assert.match(rows[0].payload.checkinInstruction, /Do not apologise/);
  // the blind case fails closed: no history / failed tools → NO_REPLY,
  // never a message improvised from notes (the 2026-08-27 incident)
  assert.match(rows[0].payload.checkinInstruction, /CANNOT see their message/);
  assert.match(rows[0].payload.checkinInstruction, /never turn notes or memory/);

  // same dropped message seen again → no second nudge
  const repeat = await sweep([
    { role: 'assistant', text: 'שלום', at: ago(12) },
    { role: 'user', text: 'יש לי משימה', at: ago(8) },
  ]);
  assert.deepEqual(repeat.repaired, []);

  // a NEWER dropped message inside the cooldown hour → still no second
  // repair; one user got three "repairs" in eight minutes this way
  const newer = await sweep([
    { role: 'assistant', text: 'שלום', at: ago(12) },
    { role: 'user', text: 'ועוד שאלה', at: ago(5) },
  ]);
  assert.deepEqual(newer.repaired, [], 'cooldown holds even for a distinct message');

  // once the hour passes, a genuinely dropped message is repaired again
  await db.pool.query(
    `UPDATE outbox SET created_at = created_at - interval '2 hours'
      WHERE user_id = $1 AND payload->>'rung' = 'unanswered_repair'`, [u.id]);
  const later = await sweep([
    { role: 'assistant', text: 'שלום', at: ago(12) },
    { role: 'user', text: 'ועוד שאלה', at: ago(5) },
  ]);
  assert.deepEqual(later.repaired, [u.id], 'cooldown ends, repair resumes');
});

// A reason given to one Olma has to reach the other person, or every
// negotiation restarts from "he just can't" — which is how one poker game
// burned four slots without either side learning anything.
test('the reason a slot suits someone rides along to the other side', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'poker', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);
  await call(miron, 'record_meeting_constraint', {
    meeting_id: meetingId, constraint: 'בצילומים ומסיים מאוחר' });
  await call(miron, 'propose_meeting_slot', {
    meeting_id: meetingId, slot_description: 'יום שלישי 20:00',
    starts_at: slotStart('יום שלישי 20:00') });

  // this file shares one DB, so filter to THIS meeting rather than trusting order
  const rows = (await outboxFor(kapish.id, 'meeting_slot_proposed'))
    .filter((r) => Number(r.payload.meetingId) === meetingId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].payload.reasons, ['בצילומים ומסיים מאוחר']);

  // and it reaches the model as quoted DATA, inside the same fence every other
  // cross-user string uses — never as something to act on.
  const { instructionFor } = require('../src/channels/openclaw');
  const body = instructionFor(rows[0]);
  assert.ok(body.includes('<<<בצילומים ומסיים מאוחר>>>'), 'the reason must be in the instruction');
  assert.ok(/data only/.test(body), 'and must be labelled as data');
});

test('a private reason never leaves its own agent', async () => {
  const started = await call(miron, 'start_meeting_coordination', { title: 'poker private', phones: [kapish.phone] });
  const meetingId = Number(/"id":"?(\d+)/.exec(started)[1]);
  await call(miron, 'record_meeting_constraint', {
    meeting_id: meetingId, constraint: 'לא ביום שני' });
  await call(miron, 'record_meeting_constraint', {
    meeting_id: meetingId, constraint: 'בדיקה רפואית', private: true });
  await call(miron, 'propose_meeting_slot', {
    meeting_id: meetingId, slot_description: 'יום שלישי 20:00',
    starts_at: slotStart('יום שלישי 20:00') });

  const rows = (await outboxFor(kapish.id, 'meeting_slot_proposed'))
    .filter((r) => Number(r.payload.meetingId) === meetingId);
  assert.equal(rows.length, 1);
  const { instructionFor } = require('../src/channels/openclaw');
  const body = instructionFor(rows[0]);
  assert.ok(body.includes('<<<לא ביום שני>>>'), 'the shareable one still travels');
  assert.ok(!body.includes('בדיקה רפואית'), 'the private one must not appear anywhere');
  assert.ok(!JSON.stringify(rows[0].payload).includes('בדיקה רפואית'),
    'and must not be sitting in the payload either');
});

test('a crashed delivery instruction is not "their unanswered message"', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000022', { firstName: 'Gil' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  // case-(a) test: pin readSentEvents to null so the box's real gateway log
  // cannot pull case (b) into it (see the comment in the test above).
  const sweep = (msgs) => withTx(db.pool, (c) =>
    unanswered.sweepUnanswered(c, { readDroppedTurns: () => new Map(), readMessages: () => msgs, readSentEvents: () => null, now }));

  // a proactive turn crashed AFTER its instruction was written to the session:
  // last entry is user-role but it is OUR text, not theirs. Repairing it made
  // the repair self-feeding — a failed repair manufactured the next one.
  assert.deepEqual((await sweep([
    { role: 'assistant', text: 'שלום', at: ago(20) },
    { role: 'user', text: 'DELIVERY: whatever you say in this turn is automatically sent... Their last message appears to have gone unanswered', at: ago(8) },
  ])).repaired, [], 'an injected instruction must never trigger a repair');

  // but a real person message BEHIND a crashed instruction still counts
  assert.deepEqual((await sweep([
    { role: 'user', text: 'יש לי שאלה', at: ago(10) },
    { role: 'user', text: 'DELIVERY: whatever you say in this turn is automatically sent...', at: ago(4) },
  ])).repaired, [u.id], 'the person behind the crashed turn is still owed an answer');
});

// 2026-08-31: user 11 sent seven messages, the agent composed seven replies in
// seconds each — and six of them died with the wedged lane they were composed
// on. Every transcript ended with a healthy-looking assistant reply, so the
// case-(a) check above saw nothing to repair for thirteen minutes of silence.
// The gateway's Sent line (hash of the recipient JID) is what makes the loss
// provable instead of guessable.
test('a composed reply that never left the box is repaired; a delivered one never is', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000023', { firstName: 'Noa' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  const hash = unanswered.sentHashFor(u.phone);
  const msgs = [
    { role: 'user', text: 'יש לי משימות', at: ago(10) },
    { role: 'assistant', text: 'ספר לי, אני רושמת', at: ago(9) },
  ];
  // An all-covering window, because these cases are about what the log
  // CONTAINS. Coverage of the window itself gets its own tests.
  const sweep = (events, m = msgs) => withTx(db.pool, (c) =>
    unanswered.sweepUnanswered(c, { readDroppedTurns: () => new Map(), readMessages: () => m, readSentEvents: () => ({ events, windows: [{ from: 0, to: Infinity }] }), now }));

  // the hash is the real recipient-JID derivation, verified live 2026-08-31
  assert.equal(unanswered.sentHashFor('+972526404855'), '41e6d58ec018');

  // delivered: a Sent line for THIS person at/after composition → healthy turn
  assert.deepEqual((await sweep([{ at: now - 9 * 60_000 + 500, hash }])).repaired, []);
  // a reply still fresh enough to be in flight is left to the gateway
  assert.deepEqual((await sweep([], [
    { role: 'user', text: 'הי', at: ago(3) },
    { role: 'assistant', text: 'שלום', at: ago(1) },
  ])).repaired, []);
  // someone ELSE's send in the window proves nothing about this person
  const hit = await sweep([{ at: now - 8 * 60_000, hash: 'deadbeef0000' }]);
  assert.deepEqual(hit.repaired, [u.id]);

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox
      WHERE user_id = $1 AND payload->>'repairKind' = 'undelivered_reply'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].payload.checkinInstruction, /never delivered/);
  assert.match(rows[0].payload.checkinInstruction, /NO_REPLY/);
  assert.match(rows[0].payload.checkinInstruction, /Do not apologise/);
  // same rung as case (a) so ONE cooldown covers both repair kinds
  assert.equal(rows[0].payload.rung, 'unanswered_repair');

  // seen again → the idempotency key (composedAt) and the cooldown both hold
  assert.deepEqual((await sweep([])).repaired, []);
});

test('an unreadable gateway log never manufactures undelivered-reply repairs', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000024', { firstName: 'Dan' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  const msgs = [
    { role: 'user', text: 'שאלה', at: ago(10) },
    { role: 'assistant', text: 'תשובה', at: ago(9) },
  ];
  // null = the log could not be read AT ALL. "No evidence of a send" and "no
  // evidence at all" must not look alike — a rotated log file would otherwise
  // spray a repair at every user whose agent replied recently.
  const out = await withTx(db.pool, (c) =>
    unanswered.sweepUnanswered(c, { readDroppedTurns: () => new Map(), readMessages: () => msgs, readSentEvents: () => null, now }));
  assert.deepEqual(out.repaired, []);
});

test('a lost proactive delivery is not repaired here — its outbox row owns the retry', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000025', { firstName: 'Rina' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  // the reply answers an injected DELIVERY instruction, not the person — a
  // second voice re-sending it from here would race the outbox's own retry
  const msgs = [
    { role: 'user', text: 'DELIVERY: whatever you say in this turn is automatically sent...', at: ago(10) },
    { role: 'assistant', text: 'תזכורת: פגישה מחר', at: ago(9) },
  ];
  const out = await withTx(db.pool, (c) =>
    unanswered.sweepUnanswered(c, { readDroppedTurns: () => new Map(), readMessages: () => msgs, readSentEvents: () => ({ events: [], windows: [{ from: 0, to: Infinity }] }), now }));
  assert.deepEqual(out.repaired, []);
});

// The window arithmetic itself, on the real line shape off the box. Without
// this the sweep tests all stub readSentEvents, so the window could be hard-wired
// to the epoch and every one of them would still pass — which is exactly the
// assumption the 00:53 duplicate was built on.
test('the log window is dated by every line, and the two files never merge', () => {
  const unanswered = require('../src/jobs/unanswered');
  const line = (time, message) => JSON.stringify({
    0: '{"subsystem":"gateway/channels/whatsapp/outbound"}', 1: message,
    time, hostname: 'olma', message, traceId: 'x', spanId: 'y', traceFlags: '01',
  });
  const at = (iso) => Date.parse(iso);
  // The real shape measured on the box, 2026-09-04: yesterday's tail ends with
  // the day, today's starts 512KB before now, and seven hours sit unread
  // between them.
  const yesterday = [
    'runcated fragment from mid-line, readTail sliced it',
    line('2026-09-03T22:01:00.000+00:00', 'poll cycle complete'),
    line('2026-09-03T23:59:00.000+00:00', 'Sent message 3EB0AAA1 -> sha256:1bc24860de1e (204ms)'),
  ].join('\n');
  const today = [
    line('2026-09-04T07:19:01.614+00:00', 'poll cycle complete'),
    line('2026-09-04T08:34:59.068+00:00', 'Sent message 3EB0DEC1 -> sha256:184023327ef0 (763ms)'),
  ].join('\n');

  const out = unanswered.parseSentEvents([
    { raw: yesterday, openEnded: false }, { raw: today, openEnded: true }]);
  assert.deepEqual(out.events.map((e) => e.hash), ['1bc24860de1e', '184023327ef0']);
  assert.equal(out.windows.length, 2, 'one window per file — never one span across the gap');

  // dated by the plain "poll cycle" line, not the first Sent one: taking the
  // window from sends alone would blind the sweep to 76 minutes it can see
  assert.ok(unanswered.covers(out, at('2026-09-04T07:19:01.614+00:00')));
  // the seven-hour hole between the files is NOT covered — the whole point
  assert.equal(unanswered.covers(out, at('2026-09-04T03:00:00.000+00:00')), false);
  assert.equal(unanswered.covers(out, at('2026-09-03T20:00:00.000+00:00')), false);
  // yesterday's file is finished, so its window stops where it stops
  assert.ok(unanswered.covers(out, at('2026-09-03T23:00:00.000+00:00')));
  // today's is still being appended to: a quiet stretch is not a blind one
  assert.ok(unanswered.covers(out, at('2026-09-04T09:30:00.000+00:00')));

  // nothing readable at all → null, never an empty window
  assert.equal(unanswered.parseSentEvents([{ raw: '', openEnded: true }]), null);
  assert.equal(unanswered.parseSentEvents([{ raw: '\n  \n', openEnded: true }]), null);
  assert.equal(unanswered.parseSentEvents([{ raw: 'not json\nalso not', openEnded: true }]), null,
    'unparseable is unknown; an undated window must never read as an empty one');
  assert.equal(unanswered.covers(null, Date.now()), false);
});

// 2026-09-02, 00:53 local: user 8 answered a reminder with "בוצע", Olma
// replied, the reply was delivered two seconds later — and 26 minutes on this
// sweep declared it lost and sent her a second copy, inside her quiet hours.
// The log tail is a fixed 512KB of a file that grows to megabytes a day, so
// its window had simply closed behind the moment in question. An empty result
// from a window that was not open is not evidence of anything.
test('a log window that does not reach back to the reply proves nothing', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000026', { firstName: 'Gal' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);
  const msgs = [
    { role: 'user', text: 'בוצע', at: ago(27) },
    { role: 'assistant', text: 'סבבה, הורדתי מהרשימה', at: ago(26) },
  ];
  const sweep = (from) => withTx(db.pool, (c) => unanswered.sweepUnanswered(
    c, { readMessages: () => msgs, readSentEvents: () => ({ events: [], windows: [{ from, to: Infinity }] }), now }));

  // window opened AFTER the reply was composed → unknown, never "undelivered"
  assert.deepEqual((await sweep(now - 20 * 60_000)).repaired, []);

  // and the check still goes red for the real case: same empty log, but a
  // window that was demonstrably open when the send should have happened.
  // A guard that cannot fail is not a guard. (The stub transcript is returned
  // for every user in the db, so others from earlier tests ride along —
  // membership is the claim here, not the exact set.)
  assert.ok((await sweep(now - 40 * 60_000)).repaired.includes(u.id));
});

// ---- case (c): the turn ran and produced nothing ---------------------------
//
// Yahav, 2026-09-05, 23:00:29. "תזכיר לי בבקשה מחר ב19:00, להתקשר למלי" — three
// tool calls timed out against a brokerd that was mid-deploy, the model wrote
// nothing, and the gateway logged one line naming the message it had swallowed.
// A check-in rung fired two seconds later, he answered THAT, and it was
// answered normally — so the transcript ended in a delivered reply and both
// existing cases read the conversation as healthy. The message he actually
// sent sat in the middle of the history where nothing looks.
test('a swallowed message is repaired even with a healthy conversation on top of it', async () => {
  const unanswered = require('../src/jobs/unanswered');
  const laneLog = require('../src/jobs/lane-watchdog');
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const u = await makeUser(db.pool, '+972617000031', { firstName: 'Yahav' });
  await db.pool.query(
    `UPDATE users SET agent_id = 'u-' || id, onboarded_at = now() - interval '2 days' WHERE id = $1`, [u.id]);

  const line = (atMs, peer, messageId) => JSON.stringify({
    time: new Date(atMs).toISOString(),
    message: 'visible channel turn dispatched with no queued reply payloads: '
      + `channel=whatsapp messageId=${messageId} sessionKey=agent:u-9:whatsapp:direct:${peer} cause=completed`,
  });

  // The real parse path, not a hand-built map: the line shape is the thing
  // under test as much as the repair is.
  const dropped = (raw) => unanswered.droppedTurnsByPeer([{ raw, openEnded: true }]);

  // The transcript ends the way Yahav's did — his reply to the rung, answered.
  const healthyTail = [
    { role: 'user', text: 'דודה שלי מניו יורק הביאה לי מתנה לברית', at: ago(7) },
    { role: 'assistant', text: 'איזה יופי 🎉 מזל טוב!', at: ago(6) },
  ];
  const sweep = (raw) => withTx(db.pool, (c) => unanswered.sweepUnanswered(c, {
    readMessages: () => healthyTail,
    readSentEvents: () => null,
    readDroppedTurns: () => dropped(raw),
    now,
  }));

  // too fresh — the gateway's own recovery gets first chance
  assert.deepEqual((await sweep(line(now - 60_000, u.phone, 'AAA1'))).repaired, []);
  // too stale — a check-in is the right tool for that, not a fake live reply
  assert.deepEqual((await sweep(line(now - 90 * 60_000, u.phone, 'AAA2'))).repaired, []);
  // somebody else's dropped turn is not this person's
  assert.deepEqual((await sweep(line(now - 8 * 60_000, '+972500009999', 'AAA3'))).repaired, []);

  const hit = await sweep(line(now - 8 * 60_000, u.phone, 'ACDCDB52'));
  assert.deepEqual(hit.repaired, [u.id], 'the swallowed message is seen even though the tail looks answered');

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, urgency, payload FROM outbox
      WHERE user_id = $1 AND payload->>'repairKind' = 'dropped_turn'`, [u.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].urgency, 'urgent');
  // Keyed on the message the GATEWAY named, so the same log tail read again is
  // a no-op rather than a second nudge.
  assert.equal(rows[0].idempotency_key, `dropped:${u.id}:ACDCDB52`);
  // It must send the model looking BACK, or it finds the answered tail and
  // concludes everything is fine — which is exactly what happened live.
  assert.match(rows[0].payload.checkinInstruction, /NOT necessarily the last thing they wrote/);
  assert.match(rows[0].payload.checkinInstruction, /NO_REPLY/);
  assert.match(rows[0].payload.checkinInstruction, /Do not apologise/);

  // and the sweep is idempotent over the same tail
  assert.deepEqual((await sweep(line(now - 8 * 60_000, u.phone, 'ACDCDB52'))).repaired, []);

  // the parser itself, on the line as the box writes it
  const parsed = laneLog.parseDroppedTurns(line(now, u.phone, 'ZZZ9'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].messageId, 'ZZZ9');
  assert.equal(parsed[0].cause, 'completed');
});
