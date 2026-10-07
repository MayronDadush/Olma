'use strict';
// Yuval, 2026-10-01 (incidents.md, "בחוץ"). The room was arranging poker, he
// was asked privately when suits him, and he answered "בחוץ". He got "Got it —
// you're out. When would work for you?", no tool was called, and the next
// question about the same poker reached him twelve minutes later.
//
// The owner's rule, held here in both directions:
//   - "out" answering a GENERAL question (the invite, the table as a whole)
//     is leaving — opted out by code, a 👍, nothing asked;
//   - "out" answering ONE time is ambiguous — nothing written, and the turn
//     is told to ask one short question.
// Every state below is produced the way production produces it: the invite
// by `afterStart`, a time by `afterOptionAdded`, delivery by the stamp the
// worker writes, the message by the gateway's `turn_open`.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { freshDb, makeUser, slotStart } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { createBrokerServer } = require('../src/brokerd/server');
const connections = require('../src/domain/connections');
const grants = require('../src/domain/grants');
const meetings = require('../src/domain/meetings');
const fanout = require('../src/domain/meeting-fanout');
const flagsDomain = require('../src/domain/flags');
const turnDomain = require('../src/domain/turn');
const selfInitiated = require('../src/domain/self-initiated');
process.env.OLMA_HOOK_TRACE = path.join(os.tmpdir(), `meeting-exit-hook-test-${process.pid}.log`);
const hook = require('../gateway-hooks/olma-turn-open/handler');

let db, broker, marks, now, seq = 0;
before(async () => {
  db = await freshDb();
  now = Date.now();
  marks = [];
  broker = createBrokerServer({ pool: db.pool, placeMark: (o) => { marks.push(o); return { attempted: true }; }, now: () => now });
});
after(async () => { await db.teardown(); });
beforeEach(() => { marks.length = 0; selfInitiated._reset(); selfInitiated._setGraceMs(0); });

const newTurn = () => ({ userId: null, opened: false, counted: false, quota: null, messageId: null, lastInboundAt: null, marked: null });
const call = (user, name, args, turn) => broker.dispatch(
  { id: 1, method: 'tool_call', params: { name, args: { olma_identity: user.identity_token, ...args } } }, turn);
const open = (params) => broker.dispatch({ id: 1, method: 'turn_open', params });
// The slot's own words go to slotStart: `add` refuses a time whose weekday
// disagrees with the one the words name (when_said), so a bare "now + 50h"
// passed only on the days of the week where it happened to land on Saturday.
const at = (slot, h) => slotStart(slot, { hours: h });

// Three people who may coordinate; `yuval` is the one who answers, on an agent.
async function cast() {
  seq += 1;
  const base = 972533200000 + seq * 10;
  const miron = await makeUser(db.pool, `+${base + 1}`, { firstName: 'Miron' });
  const yuval = await makeUser(db.pool, `+${base + 2}`, { firstName: 'Yuval' });
  const bar = await makeUser(db.pool, `+${base + 3}`, { firstName: 'Bar' });
  const agentId = `u-${7000 + seq}`;
  await db.pool.query(`UPDATE users SET agent_id = $2 WHERE id = $1`, [yuval.id, agentId]);
  await withTx(db.pool, async (c) => {
    for (const [x, y] of [[miron, yuval], [miron, bar], [yuval, bar]]) {
      const req = await connections.requestConnection(c, x.id, y.phone, {});
      const conn = (await connections.respondToConnection(c, y.id, req.data.connection.id, 'approve')).data.connection;
      await grants.grantFeature(c, x.id, conn.id, 'meetings');
      await grants.grantFeature(c, y.id, conn.id, 'meetings');
    }
  });
  return { miron, yuval, bar, agentId };
}

async function poker({ miron, yuval, bar }) {
  return withTx(db.pool, async (c) => {
    const res = await meetings.startMeeting(c, miron.id, 'פוקר', [yuval.id, bar.id]);
    await fanout.afterStart(c, miron, res, [yuval.id, bar.id], 'פוקר');
    return Number(res.data.meeting.id);
  });
}

async function addTime(actor, meetingId, slot, hours) {
  return withTx(db.pool, async (c) => {
    const add = await meetings.options.add(c, actor.id, meetingId, slot, at(slot, hours));
    await fanout.afterOptionAdded(c, actor, meetingId, add);
    return add;
  });
}

// Delivery as the worker records it — the stamp with no hold_reason. A minute
// in the past, so the message that answers it is unmistakably after it.
async function deliver(userId, kind, ago = '1 minute') {
  const { rowCount } = await db.pool.query(
    `UPDATE outbox SET sent_at = now() - $3::interval, release_after = NULL
      WHERE user_id = $1 AND kind = $2 AND sent_at IS NULL`, [userId, kind, ago]);
  assert.ok(rowCount >= 1, `a ${kind} row was waiting to be delivered`);
}

const stateOf = async (meetingId, userId) => (await db.pool.query(
  `SELECT state FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2`, [meetingId, userId])).rows[0].state;

test('the hook reads a message that is only "out", and nothing that only contains the word', () => {
  const yes = ['בחוץ', 'אני בחוץ', 'בחוץ!', 'סורי אני בחוץ', 'אני בחוץ הפעם', 'לא מגיע', 'אני לא בא',
    'תוציאי אותי', 'פאס', 'I\'m out', 'count me out', 'not coming', 'I\'ll pass'];
  const no = [
    'בחוץ?', 'אני בחוץ עכשיו', 'אני בחוץ, אחזור אליך', 'לא מגיע בשבת', 'אולי לא אגיע',
    'אולי אני אבוא זה תלוי', 'שקרן תרשום להם שאני לא מגיע', 'לא', 'אני', 'out of milk',
    'מה זה בחוץ', 'יכול כל שעה שבו אני פנוי ביומן',
  ];
  for (const t of yes) assert.equal(hook.outOnly(t), true, `out: ${JSON.stringify(t)}`);
  for (const t of no) assert.equal(hook.outOnly(t), false, `not out: ${JSON.stringify(t)}`);
  assert.equal(hook.outOnly('[Replying to Olma id:3EB0X]\nמה נוח לך לפוקר?\n[/Replying]\nבחוץ'), true);
});

test('the hook reads a quoted status as one, and a person speaking for themselves as not (Eden, 2026-10-05)', () => {
  const yes = ['רשום עדן יצא', 'עדן יצא', 'כתוב שם שיוסי עזב', 'רשום שעדן הוצא'];
  const no = [
    // the measured near-misses on the box
    'בסוף אני לא יכול בשבת הקרובה תחפש שותף במקומי אל תגיד שזה שרון יצא',
    'לבדוק כמה מתוך הפנסיה נחשב הוצאה מוכרת',
    // asking, or asking for themselves
    'עדן יצא?', 'אני יצאתי', 'תוציאי אותי', 'תצא משני הפגישות', 'לא מגיע', 'בחוץ',
  ];
  for (const t of yes) assert.equal(hook.reportsExit(t), true, `reported: ${JSON.stringify(t)}`);
  for (const t of no) assert.equal(hook.reportsExit(t), false, `not reported: ${JSON.stringify(t)}`);
});

test('Eden: opt_out_of_meeting on a quoted "עדן יצא" writes nothing and tells the model to ask', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite');

  const quoted = newTurn();
  await open({ agentId: p.agentId, messageId: '3EB0QUOTE01', kind: 'text', reportedExit: true });
  await call(p.yuval, 'turn_start', { message_id: '3EB0QUOTE01' }, quoted);
  const refused = await call(p.yuval, 'opt_out_of_meeting', { meeting_id: m }, quoted);
  assert.match(refused.text, /^ERROR invalid/);
  assert.match(refused.text, /Nothing was written/);
  assert.notEqual(await stateOf(m, p.yuval.id), 'opted_out', 'a status he quoted is not him leaving');

  // His answer to the question is an ordinary turn, and it works.
  const asked = newTurn();
  await open({ agentId: p.agentId, messageId: '3EB0QUOTE02', kind: 'text' });
  await call(p.yuval, 'turn_start', { message_id: '3EB0QUOTE02' }, asked);
  const left = await call(p.yuval, 'opt_out_of_meeting', { meeting_id: m }, asked);
  assert.match(left.text, /^OK /);
  assert.equal(await stateOf(m, p.yuval.id), 'opted_out');
});

test('Yuval: "בחוץ" to the invite takes him out of the coordination, with a 👍 and nothing asked', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite');
  // Miron puts a time up while Yuval is reading — the question that reached
  // Yuval twelve minutes after he had said he was out.
  await addTime(p.miron, m, 'שבת בערב', 50);
  const queued = (await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND kind = 'meeting_slot_proposed' AND sent_at IS NULL`, [p.yuval.id])).rows;
  assert.equal(queued.length, 1, 'a question about the new time is waiting for him');

  const r = await open({ agentId: p.agentId, messageId: '3EB0OUT0001', kind: 'text', out: true });
  assert.equal(r.opened, true);
  assert.equal(await stateOf(m, p.yuval.id), 'opted_out');
  assert.equal(marks[0].state, 'done', 'the 👍 is the answer; 👀 would promise one');
  const { rows: [withdrawn] } = await db.pool.query(`SELECT sent_at, hold_reason FROM outbox WHERE id = $1`, [queued[0].id]);
  assert.ok(withdrawn.sent_at && withdrawn.hold_reason, 'the waiting question will not reach somebody who left');

  const res = await call(p.yuval, 'turn_start', { message_id: '3EB0OUT0001' }, newTurn());
  assert.match(res.text, /meetingExit/);
  assert.match(res.text, /they have LEFT it/);
  assert.match(res.text, /NO_REPLY/);
  assert.match(res.text, /Do not ask when suits them/, 'the line Yuval actually got is the one this forbids');

  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'meeting.exit_word'`, [p.yuval.id]);
  assert.deepEqual(audit.map((a) => a.detail.outcome), ['left']);
  // The others are still in, and the coordination carries on.
  assert.equal((await db.pool.query(`SELECT status FROM meetings WHERE id = $1`, [m])).rows[0].status, 'negotiating');

  // A misread is undoable from the chat: the exit is recorded as his own
  // choice, which is the one kind rejoin_meeting may put back.
  const back = await withTx(db.pool, (c) => meetings.rejoin(c, p.yuval.id, m));
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(await stateOf(m, p.yuval.id), 'awaiting');
});

test('the same opening reaches the prompt door too (turn_context), not only turn_start', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite');
  await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, p.yuval.phone));
  try {
    await open({ agentId: p.agentId, messageId: '3EB0OUT0002', kind: 'text', out: true });
    const r = await broker.dispatch({ id: 1, method: 'turn_context',
      params: { agentId: p.agentId, sessionKey: `agent:${p.agentId}:whatsapp:direct:${p.yuval.phone}` } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.context, /they have LEFT it/);
    assert.equal(await stateOf(m, p.yuval.id), 'opted_out');
  } finally {
    await withTx(db.pool, (c) => flagsDomain.setFlag(c, turnDomain.CONTEXT_FLAG, ''));
  }
});

test('"out" to the whole TABLE is leaving too — the folded question is about the coordination, not a time', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite', '20 minutes');
  await addTime(p.miron, m, 'שבת בערב', 50);
  await addTime(p.bar, m, 'שני בערב', 98);
  const { rows: [row] } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'meeting_slot_proposed' AND sent_at IS NULL`, [p.yuval.id]);
  assert.equal(row.payload.tableChanged, true, 'the second time folded into the first question');
  await deliver(p.yuval.id, 'meeting_slot_proposed');

  await open({ agentId: p.agentId, messageId: '3EB0OUT0003', kind: 'text', out: true });
  assert.equal(await stateOf(m, p.yuval.id), 'opted_out');
  assert.equal(marks[0].state, 'done');
});

test('"out" to ONE time writes nothing and asks which he means', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite', '30 minutes');
  await addTime(p.miron, m, 'שבת בערב', 50);
  await deliver(p.yuval.id, 'meeting_slot_proposed');

  await open({ agentId: p.agentId, messageId: '3EB0OUT0004', kind: 'text', out: true });
  assert.equal(await stateOf(m, p.yuval.id), 'awaiting', 'not opted out');
  const { rows: answers } = await db.pool.query(
    `SELECT count(*)::int AS n FROM meeting_option_answers WHERE user_id = $1`, [p.yuval.id]);
  assert.equal(answers[0].n, 0, 'and the time is not declined either');
  assert.equal(marks[0].state, 'working', 'a question is owed, so the ordinary 👀');

  const res = await call(p.yuval, 'turn_start', { message_id: '3EB0OUT0004' }, newTurn());
  assert.match(res.text, /was ONE time, <<<שבת בערב>>>/);
  assert.match(res.text, /Ask ONE short question/);
  assert.match(res.text, /do NOT opt them out/);
  assert.match(res.text, new RegExp(`opt_out_of_meeting meeting_id=${m}`));
  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'meeting.exit_word'`, [p.yuval.id]);
  assert.deepEqual(audit.map((a) => a.detail.outcome), ['ask']);
});

test('after another exchange, or behind a later message, "out" is not read as an answer to the coordination', async () => {
  // Something he said in between: the last thing Olma said was a reply.
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite');
  await open({ agentId: p.agentId, messageId: '3EB0OUT0005', kind: 'text' });
  await open({ agentId: p.agentId, messageId: '3EB0OUT0006', kind: 'text', out: true });
  assert.equal(await stateOf(m, p.yuval.id), 'awaiting');

  // A message of another kind reached him after the question.
  const q = await cast();
  const m2 = await poker(q);
  await deliver(q.yuval.id, 'meeting_invite', '10 minutes');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, idempotency_key, sent_at)
     VALUES ($1, 'policy_update', '{}'::jsonb, 'urgent', $2, now() - interval '1 minute')`,
    [q.yuval.id, `test-policy-${q.yuval.id}`]);
  await open({ agentId: q.agentId, messageId: '3EB0OUT0007', kind: 'text', out: true });
  assert.equal(await stateOf(m2, q.yuval.id), 'awaiting');
});

test('a WhatsApp reply, or a message the hook did not read as "out", changes nothing', async () => {
  const p = await cast();
  const m = await poker(p);
  await deliver(p.yuval.id, 'meeting_invite');
  await open({ agentId: p.agentId, messageId: '3EB0OUT0008', kind: 'text', out: true, replyToId: '3EB0OLDER01' });
  assert.equal(await stateOf(m, p.yuval.id), 'awaiting', 'the quoted message may be an older one; the model reads it');
  await open({ agentId: p.agentId, messageId: '3EB0OUT0009', kind: 'text' });
  assert.equal(await stateOf(m, p.yuval.id), 'awaiting');
  const res = await call(p.yuval, 'turn_start', { message_id: '3EB0OUT0009' }, newTurn());
  assert.doesNotMatch(res.text, /meetingExit/);
});
