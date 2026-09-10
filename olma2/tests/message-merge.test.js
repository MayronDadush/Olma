'use strict';
// Several things due at the same moment are one message — the policy that
// decides which rows may travel together, and the worker path that carries
// them. The founding case is a real morning on the box (2026-09-08): fifteen
// runs of messages in a day and a bit, a check-in landing fifty-two seconds
// behind the message that said who Olma was.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, daytime } = require('./helpers');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const { withTx } = require('../src/db/pool');
const { mergeRoleFor, planMerge, MAX_MERGE, MERGEABLE_KINDS } = require('../src/domain/message-merge');
const { instructionFor } = require('../src/channels/openclaw');

const row = (kind, payload = {}, extra = {}) => ({ id: extra.id || 1, kind, payload, ...extra });

// ---- the policy, with no database in the way ------------------------------

test('merge: statements travel together and the one question goes last', () => {
  const lead = row('checkin', { checkinInstruction: 'ask how it went' }, { id: 1 });
  const parts = planMerge(lead, [
    row('tasks_auto_archived', { titles: ['x'] }, { id: 2 }),
    row('calendar_connected', {}, { id: 3 }),
  ]);
  assert.deepEqual(parts.map((p) => p.kind),
    ['tasks_auto_archived', 'calendar_connected', 'checkin'],
    'the ask is last, so the message ends on its question rather than burying it');
});

test('merge: a second question is left behind — one message, one answer', () => {
  const lead = row('checkin', { checkinInstruction: 'how are you' }, { id: 1 });
  const parts = planMerge(lead, [
    row('travel', { from: 'Asia/Jerusalem' }, { id: 2 }),
    row('email_connected', {}, { id: 3 }),
  ]);
  assert.deepEqual(parts.map((p) => p.kind), ['email_connected', 'checkin']);
  assert.ok(!parts.some((p) => p.kind === 'travel'),
    'travel asks a question and acts on the answer; two asks in one message get one reply '
    + 'and nothing can tell which was answered');
});

test('merge: a row that carries its own words is never composed with', () => {
  // The introduction ג.ב was owed says, in its own text, to add nothing and
  // send no second message. Honouring that is the entire point of it.
  assert.equal(mergeRoleFor(row('introduction', { instruction: 'say this exactly' })), null);
  assert.equal(mergeRoleFor(row('checkin', { instruction: 'hand-written repair' })), null,
    'a mergeable KIND still goes alone once somebody has written the words by hand');
  assert.equal(planMerge(row('introduction', { instruction: 'x' }, { id: 1 }),
    [row('checkin', { checkinInstruction: 'hi' }, { id: 2 })]), null);
});

test('merge: a reminder is never folded into a composed turn', () => {
  // Every rung rides the raw pipe with the owner's wording and no model. A
  // model that rewords or drops the one sentence they asked for would leave
  // the row stamped delivered all the same.
  assert.equal(mergeRoleFor(row('reminder', { title: 'call the bank', attempt: 1 })), null);
  const parts = planMerge(row('digest', { scope: 'summary' }, { id: 1 }),
    [row('reminder', { title: 'call the bank' }, { id: 2 })]);
  assert.equal(parts, null, 'a digest and a reminder due together stay two messages');
});

test('merge: urgency is not diluted, and an unknown kind waits to be read', () => {
  assert.equal(mergeRoleFor(row('checkin', { checkinInstruction: 'x' }, { urgency: 'urgent' })), null);
  assert.equal(mergeRoleFor(row('meeting_invite', {})), null,
    'kinds carrying another person\'s text are excluded until somebody decides otherwise');
  assert.equal(mergeRoleFor(row('some_kind_invented_next_month', {})), null,
    'absent from the map means alone — the safe direction for a kind nobody has read');
});

test('merge: a run longer than one breath stays two sends', () => {
  const lead = row('checkin', { checkinInstruction: 'x' }, { id: 1 });
  const many = Array.from({ length: 6 }, (_, i) => row('tasks_auto_archived', {}, { id: i + 2 }));
  assert.equal(planMerge(lead, many).length, MAX_MERGE);
});

test('merge: one row on its own is not a merge', () => {
  assert.equal(planMerge(row('checkin', { checkinInstruction: 'x' }, { id: 1 }), []), null);
});

// ---- what the model is actually handed -------------------------------------

test('merge: the joint instruction keeps every part\'s own words and asks for one message', () => {
  const text = instructionFor({
    kind: 'digest',
    payload: {
      scope: 'summary',
      mergedParts: [
        { kind: 'tasks_auto_archived', payload: { titles: ['old thing'] } },
        { kind: 'digest', payload: { scope: 'summary', cardMinItems: 3 } },
      ],
    },
  });
  assert.match(text, /ONE message/, 'the instruction has to say it is one message');
  assert.match(text, /PART 1 OF 2[\s\S]*PART 2 OF 2/);
  assert.match(text, /get_my_digest/, 'the digest part keeps its own body text');
  assert.match(text, /render_schedule_card/,
    'and its card clause with it — a part is not reworded because it has company');
  assert.match(text, /At most one part below ends in a question/);
});

test('merge: every mergeable kind has words of its own, not the generic fallback', () => {
  // `bodyFor` ends in a default that dumps the payload as JSON — fine for a
  // one-off system notice nobody planned for, and not fine for a kind somebody
  // deliberately added to the merge map: they would be reading raw payload
  // fields inside an otherwise warm message. The map and the switch are in
  // different files, so nothing else notices.
  for (const kind of MERGEABLE_KINDS) {
    const text = instructionFor({
      kind,
      payload: {
        mergedParts: [
          {
            kind,
            payload: {
              titles: ['an old errand'], checkinInstruction: 'ask how it went',
              scope: 'summary', from: 'Asia/Jerusalem', startsAt: '2026-09-09',
            },
          },
          { kind: 'calendar_connected', payload: {} },
        ],
      },
    });
    assert.doesNotMatch(text, /System update for the user:/,
      `${kind} is on the merge map but has no body of its own — it would arrive as raw JSON`);
  }
});

// ---- the worker path -------------------------------------------------------

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972581000188', { firstName: 'Dana', timezone: 'UTC' });
});
after(async () => { await db.teardown(); });

const NOON = new Date('2026-08-16T12:00:00Z');

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r); return { ok: true }; } };
}

test('worker: two things due at the same moment are one send, and both rows are stamped', async () => {
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '2 hours' WHERE sent_at IS NULL`);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'tasks_auto_archived', payload: { titles: ['an old errand'] },
    idempotencyKey: 'm-arch',
  }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'ask how the week went' },
    idempotencyKey: 'm-checkin',
  }));

  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, NOON);

  assert.equal(rec.sent.length, 1, 'one WhatsApp message, not two');
  assert.equal(out.delivered, 1);
  const parts = rec.sent[0].payload.mergedParts.map((p) => p.kind);
  assert.deepEqual(parts, ['tasks_auto_archived', 'checkin']);

  const { rows } = await db.pool.query(
    `SELECT idempotency_key, sent_at, hold_reason FROM outbox
      WHERE idempotency_key IN ('m-arch', 'm-checkin') ORDER BY idempotency_key`);
  assert.ok(rows.every((r) => r.sent_at && !r.hold_reason),
    'both rows are delivered — the one that rode along is not left pending to be sent again');
});

test('worker: a message Olma owes goes alone and is never blended into', async () => {
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '2 hours' WHERE sent_at IS NULL`);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'introduction',
    payload: { instruction: 'Say the following EXACTLY as written: <<<היי, אני עולמה>>>' },
    idempotencyKey: 'm-intro',
  }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'which city are you in?' },
    idempotencyKey: 'm-after-intro',
  }));

  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, NOON);

  // The introduction is the owner's copy and says in its own words to add
  // nothing — so it is never composed with anything, and the check-in behind
  // it stays its own message rather than being blended in.
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0].kind, 'introduction');
  assert.equal(rec.sent[0].payload.mergedParts, undefined,
    'nothing merges with a message Olma owes in her own words');

  // And it is not tailgated either. The check-in stays held for the ten
  // minutes the introduction has the floor, so it cannot be read as part of it.
  const { rows } = await db.pool.query(
    `SELECT sent_at, hold_reason FROM outbox WHERE idempotency_key = 'm-after-intro'`);
  assert.equal(rows[0].sent_at, null);
  assert.equal(rows[0].hold_reason, 'awaiting_introduction');
});

test('worker: a merged message costs ONE slot of the daily budget, not one per row', async () => {
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '2 hours' WHERE sent_at IS NULL`);
  await db.pool.query(`DELETE FROM outbox WHERE user_id = $1`, [user.id]);
  // TODAY, because the send under test stamps itself with the real clock and
  // the budget counts the day it is asked about. `daytime()` is noon today,
  // which is also inside the default window so nothing here is night-held.
  const today = daytime();
  // Two messages have already interrupted them, a minute apart, against a
  // budget of four.
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES
       ($1,'connection_request','{}','normal', now() - interval '5 minutes'),
       ($1,'connection_request','{}','normal', now() - interval '4 minutes')`,
    [user.id]
  );

  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'calendar_connected', payload: {}, idempotencyKey: 'b-cal',
  }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'how did it go' },
    idempotencyKey: 'b-checkin',
  }));
  const rec = recorder();
  await drainOnce(db.pool, rec.deliver, today);
  assert.equal(rec.sent.length, 1, 'the two rows are one message');
  const { rows: stamped } = await db.pool.query(
    `SELECT DISTINCT sent_at FROM outbox WHERE idempotency_key IN ('b-cal', 'b-checkin')`);
  assert.equal(stamped.length, 1,
    'one UPDATE stamps them, so they share a timestamp to the microsecond — which is what '
    + 'lets the budget count messages instead of rows');

  // Three messages have now reached them today, not four, so a fourth still
  // gets through. Counting rows would have spent the budget on the merge.
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', payload: {}, idempotencyKey: 'b-fourth',
  }));
  const out = await drainOnce(db.pool, recorder().deliver, today);
  assert.equal(out.delivered, 1, 'merging must not cost more budget than sending the same things apart');
  assert.equal(out.held, 0);
});

test('worker: a merged send that fails backs off every row it was carrying', async () => {
  await db.pool.query(`UPDATE outbox SET sent_at = now() - interval '2 hours' WHERE sent_at IS NULL`);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'calendar_connected', payload: {}, idempotencyKey: 'm-fail-a',
  }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'hi' }, idempotencyKey: 'm-fail-b',
  }));

  const out = await drainOnce(db.pool, async () => ({ ok: false, error: 'pipe down' }), NOON);
  assert.equal(out.failed, 1);

  const { rows } = await db.pool.query(
    `SELECT attempts, last_error, release_after FROM outbox
      WHERE idempotency_key IN ('m-fail-a', 'm-fail-b')`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.attempts === 1 && r.last_error && r.release_after),
    'one send is one failure for every row in it — the passenger must not be re-sent on its own '
    + 'in the same tick, spending the retry the backoff just scheduled');
});
