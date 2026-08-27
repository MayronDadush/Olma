'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { decide, withinWindow, msUntilWindowOpen } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const sweeps = require('../src/jobs/sweeps');
const { withTx } = require('../src/db/pool');

// ---------------- gate: pure policy tests (no DB) ----------------------------

const DAY = { start: '09:00', end: '20:00' };
const noonUTC = new Date('2026-08-16T12:00:00Z'); // 15:00 in Asia/Jerusalem (UTC+3)
const threeAmUTC = new Date('2026-08-16T00:00:00Z'); // 03:00 local

function row(overrides) {
  return { kind: 'checkin', urgency: 'normal', expires_at: null, ...overrides };
}
const baseFacts = {
  plan: 'free', blocked: false, window: DAY, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: noonUTC,
};

test('gate: healthy daytime message delivers', () => {
  assert.equal(decide({ ...baseFacts, row: row() }).action, 'deliver');
});

test('gate: blocked user holds everything except paid reminders and unblock', () => {
  const blocked = { ...baseFacts, blocked: true };
  assert.equal(decide({ ...blocked, row: row() }).holdReason, 'blocked');
  assert.equal(decide({ ...blocked, row: row({ kind: 'reminder' }) }).holdReason, 'blocked'); // free plan
  assert.equal(decide({ ...blocked, plan: 'paid', row: row({ kind: 'reminder' }) }).action, 'deliver'); // paid bypass
  assert.equal(decide({ ...blocked, row: row({ kind: 'unblock_summary' }) }).action, 'deliver');
});

test('gate: night holds until the personal window opens; user-chosen times bypass', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  const held = decide({ ...night, row: row() });
  assert.equal(held.holdReason, 'night');
  // 03:00 → 09:00 local = six hours away
  assert.equal(Math.round((held.releaseAfter - threeAmUTC) / 3600_000), 6);
  // A reminder was set FOR a moment by the person themselves — 03:00 is when
  // they asked to be reminded, so quiet hours must never move it.
  assert.equal(decide({ ...night, row: row({ kind: 'reminder' }) }).action, 'deliver');
  assert.equal(decide({ ...night, row: row({ kind: 'digest' }) }).action, 'deliver');
});

test('gate: someone who just wrote is awake — quiet hours do not silence a live conversation', () => {
  const night = { ...baseFacts, now: threeAmUTC };
  // 3am, well outside any window, but they messaged two minutes ago
  const justWrote = new Date(threeAmUTC.getTime() - 2 * 60_000).toISOString();
  assert.equal(decide({ ...night, row: row(), lastInboundAt: justWrote }).action, 'deliver');

  // ...the grace is 15 minutes, not "any time today"
  const longAgo = new Date(threeAmUTC.getTime() - 40 * 60_000).toISOString();
  assert.equal(decide({ ...night, row: row(), lastInboundAt: longAgo }).holdReason, 'night');

  // never written → no evidence they are awake → normal quiet hours
  assert.equal(decide({ ...night, row: row(), lastInboundAt: null }).holdReason, 'night');

  // the grace opens the window; it does not waive the daily budget
  const busy = { ...night, sentToday: 4, lastInboundAt: justWrote };
  assert.equal(decide({ ...busy, row: row() }).holdReason, 'budget');
});

test('gate: default quiet hours run 21:00 to 08:00', () => {
  const { DEFAULT_WINDOW } = require('../src/domain/preferences');
  const tz = 'UTC';
  const at = (h) => new Date(`2026-08-16T${String(h).padStart(2, '0')}:30:00Z`);
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(9)), true);
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(20)), true, '20:30 is still awake time');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(21)), false, 'quiet from 21:00');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(7)), false, 'still quiet at 07:30');
  assert.equal(withinWindow(DEFAULT_WINDOW, tz, at(8)), true, 'awake from 08:00');
});

test('gate: personal window beats the default one', () => {
  const lateOwl = { ...baseFacts, window: { start: '22:00', end: '06:00' }, now: threeAmUTC };
  assert.equal(decide({ ...lateOwl, row: row() }).action, 'deliver'); // 03:00 inside their overnight window
  const sameNowDefault = { ...baseFacts, now: threeAmUTC };
  assert.equal(decide({ ...sameNowDefault, row: row() }).action, 'hold');
});

test('gate: over budget folds normal, urgent passes', () => {
  const busy = { ...baseFacts, sentToday: 4, hasDigest: true };
  const held = decide({ ...busy, row: row() });
  assert.equal(held.holdReason, 'budget');
  assert.equal(held.releaseAfter, null); // waits for the next digest, not a clock
  assert.equal(decide({ ...busy, row: row({ urgency: 'urgent' }) }).action, 'deliver');
});

test('gate: a budget hold on someone with no digest is never orphaned', () => {
  // sweepDigests only visits users who HAVE digest_times, so for everyone else
  // "it rides along with the next digest" is a promise nothing keeps and the
  // row sits unsent forever. That happened for real: a connection request the
  // recipient never saw, so he never approved and no meeting could be made.
  const busy = { ...baseFacts, sentToday: 4, hasDigest: false };
  const held = decide({ ...busy, row: row() });
  assert.equal(held.holdReason, 'budget');
  assert.ok(held.releaseAfter, 'a row with no digest to ride must carry a release time');
  assert.equal(held.releaseAfter.toISOString(), '2026-08-17T00:00:00.000Z',
    'next UTC midnight — the moment the daily budget resets');
});

test('gate: expired rows never deliver live', () => {
  const r = row({ kind: 'reminder', expires_at: '2026-08-16T10:00:00Z' });
  assert.equal(decide({ ...baseFacts, row: r }).action, 'expire');
});

test('window math: overnight windows and reopen distance', () => {
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T23:30:00Z')), true);
  assert.equal(withinWindow({ start: '22:00', end: '06:00' }, 'UTC', new Date('2026-08-16T12:00:00Z')), false);
  const ms = msUntilWindowOpen({ start: '09:00', end: '20:00' }, 'UTC', new Date('2026-08-16T21:00:00Z'));
  assert.equal(ms / 3600_000, 12); // 21:00 → 09:00 next day
});

// ---------------- worker + sweeps: DB-backed lifecycle -----------------------

let db, user;
before(async () => {
  db = await freshDb();
  user = await makeUser(db.pool, '+972581000001', { firstName: 'Dana', timezone: 'UTC' });
});
after(async () => { await db.teardown(); });

function recorder() {
  const sent = [];
  return { sent, deliver: async (r) => { sent.push(r.kind); return { ok: true }; } };
}

// Each worker test starts from an empty pending set — a failed assertion in
// one test must not leak rows into the next one's drain.
async function flushOutbox() {
  await db.pool.query(`UPDATE outbox SET sent_at = now() WHERE sent_at IS NULL`);
}

test('worker delivers pending rows and records sent_at', async () => {
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { checkinInstruction: 'hi' },
    idempotencyKey: 'w1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
  assert.deepEqual(rec.sent, ['checkin']);
  const { rows } = await db.pool.query(`SELECT sent_at FROM outbox WHERE idempotency_key = 'w1'`);
  assert.ok(rows[0].sent_at);
});

test('idempotency: same key enqueues once, jobs are re-runnable', async () => {
  const r1 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  const r2 = await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'dup' }));
  assert.equal(r1.data.enqueued, true);
  assert.equal(r2.data.enqueued, false);
});

test('delivery failure → attempts + backoff, then success on retry', async () => {
  await flushOutbox();
  // kind=reminder: window-independent, so the retry (whose clock comes from
  // the DB's real now()) can't be night-held by the wall clock of the test run
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { title: 'x' }, idempotencyKey: 'flaky' }));
  let fail = true;
  const deliver = async () => fail ? { ok: false, error: 'gateway hiccup' } : { ok: true };
  let out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.failed, 1);
  const { rows } = await db.pool.query(`SELECT attempts, last_error, release_after FROM outbox WHERE idempotency_key = 'flaky'`);
  assert.equal(rows[0].attempts, 1);
  assert.match(rows[0].last_error, /hiccup/);
  fail = false;
  out = await drainOnce(db.pool, deliver, new Date(new Date(rows[0].release_after).getTime() + 1000));
  assert.equal(out.delivered, 1);
});

test('night hold: row waits, then releases when the window opens', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'checkin', idempotencyKey: 'night1' }));
  const rec = recorder();
  let out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T03:00:00Z')); // 3am UTC = user tz
  assert.equal(out.held, 1);
  assert.equal(rec.sent.length, 0);
  out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T09:30:00Z'));
  assert.equal(out.delivered, 1);
});

// Regression, from a real incident: a connection request was held for budget
// and never seen, so the recipient never approved and no meeting was possible.
// Five messages had gone out that day, and not one of them was subject to the
// budget it exhausted.
const BUDGET_DAY = '2026-08-16T12:00:00Z';
async function alreadySentThatDay(rows) {
  const values = rows.map((r, i) => `($1,'${r.kind}','{}','${r.urgency}',$2)`).join(', ');
  await db.pool.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, sent_at) VALUES ${values}`,
    [user.id, BUDGET_DAY]
  );
}

test('worker: sends that are exempt from the budget do not consume it', async () => {
  await flushOutbox();
  await alreadySentThatDay([
    { kind: 'reminder', urgency: 'urgent' },      // user chose this moment
    { kind: 'reminder', urgency: 'urgent' },
    { kind: 'reminder', urgency: 'urgent' },
    { kind: 'digest', urgency: 'normal' },        // user chose this slot
    { kind: 'meeting_invite', urgency: 'urgent' }, // live negotiation, bypasses
  ]);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', payload: {}, idempotencyKey: 'budget-exempt-1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date(BUDGET_DAY));
  assert.equal(out.delivered, 1, 'five exempt sends must not exhaust a budget of four');
  assert.deepEqual(rec.sent, ['connection_request']);
});

test('worker: ordinary sends still count, and the hold is still scheduled', async () => {
  await flushOutbox();
  await alreadySentThatDay([
    { kind: 'checkin', urgency: 'normal' }, { kind: 'checkin', urgency: 'normal' },
    { kind: 'checkin', urgency: 'normal' }, { kind: 'checkin', urgency: 'normal' },
  ]);
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', payload: {}, idempotencyKey: 'budget-count-1',
  }));
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date(BUDGET_DAY));
  assert.equal(out.held, 1, 'the budget must still bite for messages it governs');
  const { rows } = await db.pool.query(
    `SELECT hold_reason, release_after FROM outbox WHERE idempotency_key = 'budget-count-1'`
  );
  assert.equal(rows[0].hold_reason, 'budget');
  assert.ok(rows[0].release_after, 'this user has no digest, so the row must carry a release time');
});

test('reminder sweep: due → urgent outbox row + repeat spawns next occurrence', async () => {
  const tasks = require('../src/domain/tasks');
  const reminders = require('../src/domain/reminders');
  const { taskId } = await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, user.id, { title: 'daily pills' })).data.task;
    await reminders.setReminder(c, user.id, t.id, '2026-08-16T07:00:00Z', 'daily');
    return { taskId: t.id };
  });
  const swept = await withTx(db.pool, (c) => sweeps.sweepReminders(c, '2026-08-16T07:01:00Z'));
  assert.equal(swept.length, 1);
  const { rows } = await db.pool.query(
    `SELECT urgency, expires_at FROM outbox
     WHERE kind = 'reminder' AND user_id = $1 AND idempotency_key LIKE 'reminder:%'`, [user.id]);
  assert.equal(rows[0].urgency, 'urgent');
  assert.ok(rows[0].expires_at); // 2h staleness horizon
  const next = await db.pool.query(
    `SELECT remind_at FROM task_reminders WHERE task_id = $1 AND sent_at IS NULL`, [taskId]);
  assert.equal(new Date(next.rows[0].remind_at).toISOString(), '2026-08-17T07:00:00.000Z');
});

test('digest sweep fires on the user\'s local slot and folds budget-held rows', async () => {
  await flushOutbox();
  await db.pool.query(
    `UPDATE users SET digest_times = '08:00', digest_scope = 'summary', onboarded_at = now() WHERE id = $1`, [user.id]);
  // a budget-held row waiting to ride along
  await withTx(db.pool, (c) => enqueue(c, { userId: user.id, kind: 'system_update', idempotencyKey: 'held-b', payload: { note: 'x' } }));
  await db.pool.query(`UPDATE outbox SET hold_reason = 'budget' WHERE idempotency_key = 'held-b'`);

  const fired = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T08:01:00Z')));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].folded, 1);
  const missed = await withTx(db.pool, (c) => sweeps.sweepDigests(c, new Date('2026-08-16T11:00:00Z')));
  assert.equal(missed.length, 0); // wrong time → nothing
});

test('unblock sweep: consolidates held + stale, clears the block', async () => {
  const other = await makeUser(db.pool, '+972581000002', { timezone: 'UTC' });
  await db.pool.query(
    `UPDATE users SET quota_blocked_until = '2026-08-16T10:00:00Z' WHERE id = $1`, [other.id]);
  await withTx(db.pool, async (c) => {
    await enqueue(c, { userId: other.id, kind: 'reminder', idempotencyKey: 'ub-stale',
      payload: { title: 'pick up kid 16:00' }, expiresAt: '2026-08-16T09:00:00Z' });
    await enqueue(c, { userId: other.id, kind: 'system_update', idempotencyKey: 'ub-fresh', payload: { note: 'still relevant' } });
  });
  await db.pool.query(`UPDATE outbox SET hold_reason = 'blocked' WHERE user_id = $1`, [other.id]);

  const unblocked = await withTx(db.pool, (c) => sweeps.sweepUnblocks(c, '2026-08-16T10:05:00Z'));
  assert.deepEqual(unblocked.map(Number), [Number(other.id)]);

  const { rows } = await db.pool.query(
    `SELECT payload FROM outbox WHERE user_id = $1 AND kind = 'unblock_summary'`, [other.id]);
  const p = rows[0].payload;
  assert.equal(p.accumulated.length, 1);
  assert.equal(p.expired.length, 1); // the 16:00 pickup — listed as עבר זמנה, not live
  const u = await db.pool.query(`SELECT quota_blocked_until FROM users WHERE id = $1`, [other.id]);
  assert.equal(u.rows[0].quota_blocked_until, null);
});

test('retry backoff starts in seconds and is capped, so an outage cannot bury a message', async () => {
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: 'x' },
    idempotencyKey: 'reminder:backoff',
  }));
  const failing = async () => ({ ok: false, error: 'billing' });
  const state = async () => {
    const { rows } = await db.pool.query(
      `SELECT attempts, extract(epoch from (release_after - now())) AS secs
       FROM outbox WHERE idempotency_key = 'reminder:backoff'`);
    return { attempts: rows[0].attempts, secs: Number(rows[0].secs) };
  };

  // first retry in seconds — a welcome racing the config reload must not wait minutes
  await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
  let g = await state();
  assert.equal(g.attempts, 1);
  assert.ok(g.secs > 0 && g.secs <= 6, `first retry ~5s, got ${g.secs}`);

  // ...and it never grows past the cap, however long the outage lasts
  await db.pool.query(
    `UPDATE outbox SET attempts = 20, release_after = NULL WHERE idempotency_key = 'reminder:backoff'`);
  await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
  g = await state();
  assert.ok(g.secs <= 601, `capped at 10 minutes, got ${g.secs}`);

  // and it still delivers once the outage ends
  const rec = recorder();
  await db.pool.query(
    `UPDATE outbox SET release_after = NULL WHERE idempotency_key = 'reminder:backoff'`);
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
});

test('a long outage cannot push the backoff past what an interval can hold', async () => {
  // The gap the test above left: it checked attempts = 20, and the arithmetic
  // only blows up at 26. least() evaluates BOTH arguments, so the 10-minute cap
  // never protected the multiplication that produced the value being capped —
  // at 5s x 3^26 the interval overflowed int64 microseconds and the UPDATE
  // threw `interval out of range`, leaving the row unable to record even its
  // own failure. Live on 2026-08-23 after the Anthropic account ran dry.
  await flushOutbox();
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: 'x' },
    idempotencyKey: 'reminder:overflow',
  }));
  const failing = async () => ({ ok: false, error: 'credit balance is too low' });

  for (const attempts of [26, 40, 100]) {
    await db.pool.query(
      `UPDATE outbox SET attempts = $1, release_after = NULL WHERE idempotency_key = 'reminder:overflow'`,
      [attempts]);
    const out = await drainOnce(db.pool, failing, new Date('2026-08-16T12:00:00Z'));
    assert.equal(out.failed, 1, `attempts=${attempts} must record a failure, not throw`);
    assert.ok(!out.errored, `attempts=${attempts} must not error the row`);
    const { rows } = await db.pool.query(
      `SELECT attempts, extract(epoch from (release_after - now())) AS secs
       FROM outbox WHERE idempotency_key = 'reminder:overflow'`);
    assert.equal(rows[0].attempts, attempts + 1);
    assert.ok(Number(rows[0].secs) <= 601,
      `attempts=${attempts} still capped at 10 minutes, got ${rows[0].secs}`);
  }

  // and the message is still deliverable afterwards — the whole point of a cap
  await db.pool.query(
    `UPDATE outbox SET release_after = NULL WHERE idempotency_key = 'reminder:overflow'`);
  const rec = recorder();
  const out = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(out.delivered, 1);
});

test('one unprocessable row does not take the rest of the queue down with it', async () => {
  // The outage was not caused by rows failing — rows fail all the time. It was
  // caused by ONE row aborting the tick, oldest-first, so everything behind it
  // stopped too. 28 healthy messages sat behind two poisoned ones for a day.
  await flushOutbox();
  const ids = [];
  for (const n of ['poison', 'good1', 'good2']) {
    const r = await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: n },
      idempotencyKey: `reminder:isolation:${n}`,
    }));
    ids.push({ n, id: r.data ? r.data.id : null });
  }
  // the oldest row throws outright, the way the overflowing UPDATE used to
  const deliver = async (row) => {
    if (row.payload.text === 'poison') throw new Error('interval out of range');
    return { ok: true };
  };
  const out = await drainOnce(db.pool, deliver, new Date('2026-08-16T12:00:00Z'));

  assert.equal(out.delivered, 2, 'the two healthy messages must still go out');
  assert.ok(Array.isArray(out.errored) && out.errored.length === 1,
    'and the bad row must be reported, not silently swallowed');
  assert.match(out.errored[0].error, /interval out of range/);

  const { rows } = await db.pool.query(
    `SELECT count(*)::int AS n FROM outbox
     WHERE idempotency_key LIKE 'reminder:isolation:good%' AND sent_at IS NOT NULL`);
  assert.equal(rows[0].n, 2);
});

test('a tick delivers at most MAX_DELIVERIES_PER_TICK — a backlog drains in short beats, not one 20-minute gulp', async () => {
  const { MAX_DELIVERIES_PER_TICK } = require('../src/outbox/worker');
  await flushOutbox();
  for (let i = 0; i < MAX_DELIVERIES_PER_TICK + 3; i++) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'reminder', urgency: 'urgent', payload: { text: `b${i}` },
      idempotencyKey: `reminder:cap:${i}`,
    }));
  }
  const rec = recorder();
  const first = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(first.delivered, MAX_DELIVERIES_PER_TICK,
    'a real send is a model turn; the tick must hand the core back between batches');
  const second = await drainOnce(db.pool, rec.deliver, new Date('2026-08-16T12:00:00Z'));
  assert.equal(second.delivered, 3, 'the next tick finishes the backlog');
});
