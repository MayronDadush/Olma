'use strict';
// ── The same thing does not go out twice inside a few minutes ────────────────
//
// The founding case, 2026-09-10: Miron read a picture of his evening at 18:01
// and read it again at 18:02. That particular repeat is prevented one level up,
// by never handing one turn both a block and a card (tests/digest-card.test.js);
// this is the rule underneath it, and it is the owner's, in his words —
// something that is the same thing may not go out twice in so short a time
// unless the person asked for it.
//
// Both halves are pinned here, and both directions of each: the guard has to
// still FIRE for the real case and still let everything else past, or it is the
// detection layer nobody trusts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb, makeUser } = require('./helpers');
const { decide, REPEAT_WINDOW_MS } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const repeatGuard = require('../src/domain/repeat-guard');
const selfInitiated = require('../src/domain/self-initiated');
const { BY_NAME } = require('../src/adapters/mcp/registry');

// ---- the gate: two rows of the same kind ------------------------------------

const noonUTC = new Date('2026-08-16T12:00:00Z'); // 15:00 in Asia/Jerusalem
const baseFacts = {
  plan: 'free', blocked: false, window: { start: '09:00', end: '20:00' },
  tz: 'Asia/Jerusalem', sentToday: 0, budget: 4, now: noonUTC,
};
const minutesAgo = (m) => new Date(noonUTC.getTime() - m * 60_000).toISOString();
const row = (kind, extra) => ({ kind, urgency: 'normal', expires_at: null, ...extra });

test('a second digest minutes behind the first is dropped, not delivered', () => {
  const v = decide({
    ...baseFacts, row: row('digest'),
    lastSentByKind: { digest: minutesAgo(1) },
  });
  assert.equal(v.action, 'drop');
  assert.equal(v.holdReason, 'duplicate');
});

test('...and past the window it is a new morning, not a repeat', () => {
  const v = decide({
    ...baseFacts, row: row('digest'),
    lastSentByKind: { digest: new Date(noonUTC.getTime() - REPEAT_WINDOW_MS - 1000).toISOString() },
  });
  assert.equal(v.action, 'deliver');
});

test('the guard reads the kind it is deciding about, not the newest thing sent', () => {
  // The worker gathers one map for the whole transaction and re-decides
  // siblings of other kinds against it. A check-in behind a digest sent a
  // minute ago is not a repeat of anything.
  const v = decide({
    ...baseFacts, row: row('checkin'),
    lastSentByKind: { digest: minutesAgo(1) },
  });
  assert.equal(v.action, 'deliver');
});

test('a reminder rung is never a duplicate — the ladder is meant to come back', () => {
  const v = decide({
    ...baseFacts, row: row('reminder', { payload: { rung: 2, auto: true } }),
    lastSentByKind: { reminder: minutesAgo(1) },
  });
  assert.equal(v.action, 'deliver');
});

test('another person writing twice is them, not Olma repeating herself', () => {
  const v = decide({
    ...baseFacts, row: row('relayed_message'),
    lastSentByKind: { relayed_message: minutesAgo(1) },
  });
  assert.equal(v.action, 'deliver');
});

// ---- the gate, end to end ---------------------------------------------------

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972500000933', { firstName: 'Miron' });
  await db.pool.query(
    `UPDATE users SET timezone = 'Asia/Jerusalem', onboarded_at = now(),
       last_inbound_at = now() WHERE id = $1`,
    [user.id]
  );
});
after(async () => { await db.teardown(); });

test('two digest rows for one person: one goes out, the other is stamped duplicate', async () => {
  const client = await db.pool.connect();
  try {
    await enqueue(client, { userId: user.id, kind: 'digest', payload: { scope: 'summary' }, idempotencyKey: 'dup-test-a' });
    await enqueue(client, { userId: user.id, kind: 'digest', payload: { scope: 'summary' }, idempotencyKey: 'dup-test-b' });
  } finally { client.release(); }

  const sent = [];
  const out = await drainOnce(db.pool, async (r) => { sent.push(r.id); return { ok: true }; });

  assert.equal(sent.length, 1, 'exactly one digest reaches the person');
  assert.equal(out.dropped, 1);
  const { rows } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'digest' ORDER BY id`, [user.id]
  );
  assert.deepEqual(rows.map((r) => r.hold_reason), [null, 'duplicate']);

  // It leaves something to count. A guard nobody can measure is one nobody
  // will trust in six weeks.
  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'delivery.duplicate_suppressed'`,
    [user.id]
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.kind, 'digest');
});

// ---- the card tool: the same picture twice in one turn ----------------------

function tmpWorkspace(id) {
  return { id, workspace_path: fs.mkdtempSync(path.join(os.tmpdir(), 'olma-repeat-ws-')) };
}
function sample(overrides = {}) {
  return {
    title: 'תמונת מצב',
    sections: [{ title: 'השבוע', items: [{ date: '19 באוג׳', text: 'לנקות מזגנים', icon: 'cleaning' }] }],
    ...overrides,
  };
}

test('a turn OLMA started may not draw the same card twice', async () => {
  repeatGuard._reset();
  selfInitiated._reset();
  selfInitiated._setGraceMs(0);
  const ws = tmpWorkspace(4001);
  const tool = BY_NAME.get('render_schedule_card');

  await selfInitiated.around(ws.id, async () => {
    const first = await tool.handler(null, ws, sample(), {});
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);

    const again = await tool.handler(null, ws, sample(), {});
    assert.equal(again.ok, false, 'the same card, moments later, is the message twice');
    assert.equal(again.error.code, 'conflict');
    assert.match(again.error.next_step, /NO_REPLY/);

    // A redraw the doctrine actually asks for — the range narrowed after a
    // refusal — is a different card and passes untouched.
    const narrower = await tool.handler(null, ws, sample({ subtitle: 'רק השבוע' }), {});
    assert.equal(narrower.ok, true, narrower.ok ? '' : narrower.error.message);
  });
});

test('a turn the PERSON started may draw it again: they asked twice', async () => {
  repeatGuard._reset();
  selfInitiated._reset();
  const ws = tmpWorkspace(4002);
  const tool = BY_NAME.get('render_schedule_card');

  const first = await tool.handler(null, ws, sample(), {});
  assert.equal(first.ok, true, first.ok ? '' : first.error.message);
  const second = await tool.handler(null, ws, sample(), {});
  assert.equal(second.ok, true, 'answering someone who asked again is answering, not repeating');
  assert.notEqual(second.data.path, first.data.path);
});

test('a refused render is not remembered as something that went out', () => {
  repeatGuard._reset();
  const sig = repeatGuard.signature({ a: 1 });
  assert.equal(repeatGuard.repeatAge(9, sig), null);
  repeatGuard.remember(9, sig, Date.now());
  assert.ok(repeatGuard.repeatAge(9, sig, Date.now()) !== null);
  // and it ages out rather than blocking that person's card for ever
  assert.equal(repeatGuard.repeatAge(9, sig, Date.now() + REPEAT_WINDOW_MS + 1), null);
});
