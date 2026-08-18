'use strict';
// The watchdog's whole job is deciding when to abort a live user's session, so
// the tests care most about when it must NOT: a healthy slow run, a lane the
// gateway is still working on, a lane with nobody queued behind it.
const test = require('node:test');
const assert = require('node:assert');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const wd = require('../src/jobs/lane-watchdog');

const KEY = 'agent:u-3:whatsapp:direct:+972526269826';

// Verbatim shape of the lines the gateway wrote during the 2026-08-16 incident.
const stuckLine = (key, age, qd) =>
  `stuck session: sessionId=189621a5-f52f-4e71-89aa-5cd35d39dc86 sessionKey=${key} ` +
  `state=processing age=${age}s queueDepth=${qd} reason=queued_work_without_active_run ` +
  `classification=stale_session_state lastProgress=run:complete`;

const skippedLine = (key) =>
  `stuck session recovery outcome: status=skipped action=keep_lane ` +
  `sessionId=189621a5-f52f-4e71-89aa-5cd35d39dc86 sessionKey=${key} ` +
  `activeSessionId=189621a5-f52f-4e71-89aa-5cd35d39dc86 activeWorkKind=embedded_run reason=active_reply_work`;

const recoveredLine = (key) =>
  `stuck session recovery outcome: status=aborted action=abort_embedded_run sessionKey=${key}`;

const asJsonLog = (lines) =>
  lines.map((m) => JSON.stringify({ message: m, time: '2026-08-16T17:58:55.000+00:00' })).join('\n');

// ---- parsing / decision (pure, no DB) --------------------------------------

test('parses a declined stuck lane out of the gateway log', () => {
  const events = wd.parseEvents(asJsonLog([stuckLine(KEY, 148, 3), skippedLine(KEY)]));
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionKey, KEY);
  assert.equal(events[0].ageMs, 148_000);
  assert.equal(events[0].queueDepth, 3);
});

test('plain-text (journald) lines parse the same facts as JSON lines', () => {
  // Only the timestamp differs: a raw journald line carries no `time` field,
  // so `at` is null there. Everything the decision uses must match.
  const plain = wd.parseEvents([stuckLine(KEY, 148, 3), skippedLine(KEY)].join('\n'));
  const json  = wd.parseEvents(asJsonLog([stuckLine(KEY, 148, 3), skippedLine(KEY)]));
  const facts = (e) => ({ sessionKey: e.sessionKey, ageMs: e.ageMs, queueDepth: e.queueDepth });
  assert.deepEqual(plain.map(facts), json.map(facts));
  assert.equal(plain[0].at, null);
});

test('a lane the gateway has NOT declined is left alone', () => {
  // stuck, but no "skipped" verdict — the gateway may still free it itself
  assert.equal(wd.parseEvents(asJsonLog([stuckLine(KEY, 300, 2)])).length, 0);
});

test('a lane the gateway recovered on its own is left alone', () => {
  assert.equal(wd.parseEvents(asJsonLog([stuckLine(KEY, 300, 2), recoveredLine(KEY)])).length, 0);
});

test('a slow run below the age floor is not touched', () => {
  // 60s: inside the range a local voice-note transcription legitimately takes
  const events = wd.parseEvents(asJsonLog([stuckLine(KEY, 60, 1), skippedLine(KEY)]));
  assert.equal(wd.pickWedged(events, wd.DEFAULT_MIN_AGE_MS).length, 0);
});

test('nobody queued behind the lane means nothing to rescue', () => {
  const events = wd.parseEvents(asJsonLog([stuckLine(KEY, 600, 0), skippedLine(KEY)]));
  assert.equal(wd.pickWedged(events, wd.DEFAULT_MIN_AGE_MS).length, 0);
});

test('the worst observation in the window wins', () => {
  const events = wd.parseEvents(asJsonLog([
    stuckLine(KEY, 95, 1), stuckLine(KEY, 240, 3), skippedLine(KEY),
  ]));
  assert.equal(events[0].ageMs, 240_000);
});

// ---- the sweep (against a real database) -----------------------------------

test('lane watchdog: aborts the wedged lane, once, and records who it was for', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const user = await makeUser(pool, '+972526269826');

  const calls = [];
  const deps = {
    readLog: () => asJsonLog([stuckLine(KEY, 148, 3), skippedLine(KEY)]),
    abort: (a) => { calls.push(a); return { ok: true }; },
  };

  const res = await withTx(pool, (c) => wd.sweepLaneWatchdog(c, deps));
  assert.equal(res.aborted.length, 1);
  assert.deepEqual(calls, [{ agentId: 'u-3', key: KEY }]);

  const { rows } = await pool.query(
    `SELECT actor_id, detail FROM audit_log WHERE event = 'lane.watchdog_abort'`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].actor_id), Number(user.id));
  assert.equal(rows[0].detail.queueDepth, 3);
  assert.equal(rows[0].detail.ok, true);

  // Same lane still reported stuck on the next tick: the cooldown must hold,
  // otherwise a lane that re-wedges gets aborted every 30 seconds forever.
  const again = await withTx(pool, (c) => wd.sweepLaneWatchdog(c, deps));
  assert.equal(again.aborted.length, 0);
  assert.equal(calls.length, 1);
});

test('lane watchdog: a failed abort is still recorded', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await makeUser(pool, '+972526269826');

  const res = await withTx(pool, (c) => wd.sweepLaneWatchdog(c, {
    readLog: () => asJsonLog([stuckLine(KEY, 200, 2), skippedLine(KEY)]),
    abort: () => ({ ok: false, error: 'gateway unreachable' }),
  }));
  assert.equal(res.aborted.length, 0);

  const { rows } = await pool.query(
    `SELECT detail FROM audit_log WHERE event = 'lane.watchdog_abort'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail.ok, false);
  assert.match(rows[0].detail.error, /unreachable/);
});

test('lane watchdog: repeated wedging stops the watchdog and files an issue', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  await makeUser(pool, '+972526269826');

  // Pre-load the hour with aborts, as a melting system would.
  for (let i = 0; i < wd.HOURLY_CAP; i++) {
    await pool.query(
      `INSERT INTO audit_log (actor_id, event, detail) VALUES (NULL, 'lane.watchdog_abort', $1)`,
      [JSON.stringify({ sessionKey: `agent:u-${i}:whatsapp:direct:+9725000000${i}` })]
    );
  }

  let called = false;
  const res = await withTx(pool, (c) => wd.sweepLaneWatchdog(c, {
    readLog: () => asJsonLog([stuckLine(KEY, 300, 4), skippedLine(KEY)]),
    abort: () => { called = true; return { ok: true }; },
  }));

  assert.equal(res.capped, true);
  assert.equal(called, false, 'must stop acting rather than mask a systemic failure');

  const { rows } = await pool.query(
    `SELECT title FROM issues WHERE status = 'new'`);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /wedging repeatedly/);
});

test('lane watchdog: quiet log is a cheap no-op', async (t) => {
  const { pool, teardown } = await freshDb();
  t.after(teardown);
  const res = await withTx(pool, (c) => wd.sweepLaneWatchdog(c, {
    readLog: () => asJsonLog(['[whatsapp] Inbound message +9725 -> +9725 (direct, 12 chars)']),
    abort: () => { throw new Error('must not abort anything'); },
  }));
  assert.deepEqual(res, { wedged: 0, aborted: [] });
});

test('lane watchdog: a missing log file does not throw', () => {
  assert.equal(wd.readTail('/nonexistent/openclaw-2026-01-01.log'), '');
});
