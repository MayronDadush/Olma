'use strict';
// The failure this whole feature exists for: a user asked to stop, was asked
// "בטוח?", confirmed, got a warm goodbye — and a proactive check-in the next
// morning, with his daily medication reminder still armed for that evening.
// The agent had handled the conversation right and then called nothing,
// because there was nothing to call.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser, daytime } = require('./helpers');
const { withTx } = require('../src/db/pool');
const pause = require('../src/domain/pause');
const reminders = require('../src/domain/reminders');
const tasks = require('../src/domain/tasks');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const { decide } = require('../src/outbox/gate');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const HOUR = 3600_000;

async function userWithDailyReminder(phone, { remindAt } = {}) {
  const u = await makeUser(db.pool, phone, { firstName: 'קפיש' });
  const at = remindAt || new Date(Date.now() + HOUR);
  const t = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'תרופות בשעה 6 בערב' }));
  await withTx(db.pool, (c) =>
    reminders.setReminder(c, u.id, t.data.task.id, at, 'daily'));
  return { user: u, taskId: Number(t.data.task.id), remindAt: at };
}

// ---- the gate ---------------------------------------------------------------

test('a paused user\'s message is dropped, whatever kind or urgency it carries', () => {
  // `daytime()`, not `new Date()`. withinWindow is half-open (`now < end`), so
  // an all-day window written as 00:00-23:59 excludes the final minute of the
  // day — and this test's last assertion is the one that needs `deliver`. At
  // 23:59 Asia/Jerusalem it got `hold`/night instead, which is a true answer
  // about the gate and a false one about pause.
  //
  // It cost a real deploy on 2026-09-04: CI ran at 20:59:33 UTC, exactly 23:59
  // in Jerusalem, `test` went red on main and `deploy` was skipped. One minute
  // in every 1440 — the same "green thirteen hours a day" shape the suite
  // already has a rule against, hiding in a window that reads as "always".
  const base = { window: { start: '00:00', end: '23:59' }, tz: 'Asia/Jerusalem',
                 sentToday: 0, budget: 4, plan: 'free', now: daytime() };
  for (const row of [
    { kind: 'checkin', urgency: 'normal' },
    { kind: 'reminder', urgency: 'urgent' },   // the user picked this time — still no
    { kind: 'digest', urgency: 'normal' },
    { kind: 'meeting_confirmed', urgency: 'urgent' }, // somebody ELSE's action
  ]) {
    const v = decide({ ...base, row, paused: true });
    assert.equal(v.action, 'drop', `${row.kind}/${row.urgency} must not reach a paused user`);
    assert.equal(v.holdReason, 'paused');
  }
  // and the same rows sail through when they are not paused
  assert.equal(decide({ ...base, row: { kind: 'checkin', urgency: 'normal' }, paused: false }).action,
    'deliver');
});

test('pause outranks everything else the gate could have said', () => {
  // expired AND blocked AND over budget AND the middle of the night: still
  // 'drop', because "paused" is the true reason and the others imply a later.
  const v = decide({
    row: { kind: 'checkin', urgency: 'normal', expires_at: new Date(Date.now() - HOUR) },
    paused: true, blocked: true, plan: 'free',
    window: { start: '09:00', end: '09:01' }, tz: 'Asia/Jerusalem',
    sentToday: 99, budget: 4, now: new Date(),
  });
  assert.equal(v.action, 'drop');
});

// ---- pausing ----------------------------------------------------------------

test('pausing disarms what was already aimed at them, and deletes nothing', async () => {
  const { user, taskId } = await userWithDailyReminder('+972557049001');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { rung: 'discovery' },
  }));

  const res = await withTx(db.pool, (c) =>
    pause.pauseUser(c, user.id, { note: 'זהו' }));
  assert.equal(res.ok, true);
  assert.equal(res.data.remindersCancelled, 1);
  assert.equal(res.data.outboxCancelled, 1);

  const { rows: pending } = await db.pool.query(
    `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL`, [user.id]);
  assert.equal(pending.length, 0, 'nothing is left armed');

  const { rows: queued } = await db.pool.query(
    `SELECT id FROM outbox WHERE user_id = $1 AND sent_at IS NULL`, [user.id]);
  assert.equal(queued.length, 0, 'and nothing is left queued');

  // the point of the whole design: their stuff is still theirs
  const { rows: stillThere } = await db.pool.query(
    `SELECT id, title, status FROM tasks WHERE id = $1`, [taskId]);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].status, 'open');

  const { rows: a } = await db.pool.query(
    `SELECT event, detail FROM audit_log WHERE actor_id = $1 AND event = 'user.paused'`, [user.id]);
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.note, 'זהו', 'their own words, on the trail only');
  assert.equal(a[0].detail.dataDeleted, false);
});

// ---- the stop that was heard but never confirmed --------------------------
//
// Gal, 2026-09-22: "dont send me messages bye" at 15:04. Olma asked "בטוח?"
// exactly as the doctrine said, he never answered, and because the pause
// waited on a yes his record said nothing at all. Four urgent coordination
// messages were dispatched over the next hour; three reached him. The owner's
// fix is to comply first and ask second (incidents.md, "The stop that waited
// for a yes").
test('an unconfirmed stop stops everything a confirmed one does', async () => {
  const { user, taskId } = await userWithDailyReminder('+972557049101');
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'meeting_slot_proposed', urgency: 'urgent',
    payload: { title: 'פאדל השבוע' },
  }));

  const res = await withTx(db.pool, (c) =>
    pause.pauseUser(c, user.id, { note: 'dont send me messages bye', confirmed: false }));
  assert.equal(res.ok, true);
  // The whole point: the queue is emptied at the moment of hearing, so no turn
  // is ever spawned and no later judgement has to save him.
  assert.equal(res.data.outboxCancelled, 1, 'the urgent coordination row is cancelled, not filtered later');
  assert.equal(res.data.remindersCancelled, 1);

  const { rows } = await db.pool.query(
    `SELECT paused_at, paused_reason FROM users WHERE id = $1`, [user.id]);
  assert.ok(rows[0].paused_at, 'paused the moment it was heard');
  assert.equal(rows[0].paused_reason, pause.SAID_STOP);
  // and nothing of theirs went anywhere
  const { rows: t } = await db.pool.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
  assert.equal(t[0].status, 'open');
});

test('their next message ends an unconfirmed stop and puts the reminders back', async () => {
  // A daily 12:00 frozen two days ago, so coming back has to WALK the rule
  // forward rather than just un-cancel a row whose moment is still ahead.
  const frozenAt = daytime(new Date(Date.now() - 2 * 24 * HOUR));
  const { user } = await userWithDailyReminder('+972557049102', { remindAt: frozenAt });
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id, { confirmed: false }));

  // openRecord's `wake` is the door a real inbound comes through; going
  // through turn.openRecord rather than calling stopResume directly is what
  // proves the wiring, not just the function.
  const turn = require('../src/domain/turn');
  const fresh = (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];
  await withTx(db.pool, (c) => turn.openRecord(c, fresh, { wake: true }));

  const { rows } = await db.pool.query(
    `SELECT paused_at, paused_reason FROM users WHERE id = $1`, [user.id]);
  assert.equal(rows[0].paused_at, null, 'writing again is them coming back');
  assert.equal(rows[0].paused_reason, null);

  const { rows: armed } = await db.pool.query(
    `SELECT r.remind_at, r.repeat_rule FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL`, [user.id]);
  assert.equal(armed.length, 1, 'the repeating reminder is re-armed, not lost');
  assert.ok(armed[0].remind_at > new Date(), 'at its own next real time, never one already gone');
  assert.equal(armed[0].remind_at.getUTCHours(), 12, 'and still at the hour they chose');
  assert.equal(armed[0].repeat_rule, 'daily');
});

test('a CONFIRMED stop is not ended by them writing again', async () => {
  // The difference that makes asking worth anything: "בטוח?" → "כן" has to
  // outlast the next message, or the question was theatre.
  const { user } = await userWithDailyReminder('+972557049103');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id, { confirmed: false }));
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id, { confirmed: true }));
  const mid = (await db.pool.query(`SELECT paused_reason FROM users WHERE id = $1`, [user.id])).rows[0];
  assert.equal(mid.paused_reason, null, 'the yes cleared the provisional reason');

  const turn = require('../src/domain/turn');
  const fresh = (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];
  await withTx(db.pool, (c) => turn.openRecord(c, fresh, { wake: true }));

  const { rows } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [user.id]);
  assert.ok(rows[0].paused_at, 'they confirmed; only they or an admin end this');
});

test('a turn that merely happened on their agent does not end an unconfirmed stop', async () => {
  // Same line openRecord already draws for the night window and the ladder
  // pause: a turn Olma started is not the person writing.
  const { user } = await userWithDailyReminder('+972557049104');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id, { confirmed: false }));
  const turn = require('../src/domain/turn');
  const fresh = (await db.pool.query(`SELECT * FROM users WHERE id = $1`, [user.id])).rows[0];
  await withTx(db.pool, (c) => turn.openRecord(c, fresh, { wake: false }));
  const { rows } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [user.id]);
  assert.ok(rows[0].paused_at, 'still paused');
});

test('nothing the worker drains reaches somebody whose stop is only heard', async () => {
  // The end-to-end shape of Gal's hour: an urgent cross-user row, enqueued
  // AFTER the stop, must not reach him either.
  const { user } = await userWithDailyReminder('+972557049105');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id, { confirmed: false }));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'meeting_slot_proposed', urgency: 'urgent',
    payload: { title: 'פאדל השבוע', slot: 'שבת 16:00' },
  }));
  await drainOnce(db.pool, { now: daytime(0) });
  const { rows } = await db.pool.query(
    `SELECT hold_reason, sent_at FROM outbox WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
  assert.equal(rows[0].hold_reason, 'paused', 'the gate is the chokepoint, not the model');
});

test('pausing twice is not a second pause', async () => {
  const { user } = await userWithDailyReminder('+972557049002');
  const first = await withTx(db.pool, (c) => pause.pauseUser(c, user.id));
  const second = await withTx(db.pool, (c) => pause.pauseUser(c, user.id));
  assert.equal(second.ok, true);
  assert.deepEqual(second.data.pausedAt, first.data.pausedAt,
    'the moment they asked is the moment they asked');
});

test('nothing the worker drains reaches a paused user', async () => {
  const { user } = await userWithDailyReminder('+972557049003');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));
  // somebody else's action lands on them AFTER the pause
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'connection_request', urgency: 'urgent', payload: {},
  }));

  const sent = [];
  const out = await drainOnce(db.pool, async (row) => { sent.push(row.id); return { ok: true }; });
  assert.equal(sent.length, 0, 'the deliverer is never called');
  assert.equal(out.dropped, 1);

  const { rows } = await db.pool.query(
    `SELECT sent_at, hold_reason FROM outbox WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
  assert.ok(rows[0].sent_at, 'stamped, so the sweep cannot recreate it');
  assert.equal(rows[0].hold_reason, 'paused', 'and recorded as never actually sent');
});

test('a dropped message does not spend their daily budget', async () => {
  const { user } = await userWithDailyReminder('+972557049004');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));
  for (let i = 0; i < 6; i++) {
    await withTx(db.pool, (c) => enqueue(c, {
      userId: user.id, kind: 'checkin', payload: { n: i }, idempotencyKey: `b:${i}` }));
  }
  await drainOnce(db.pool, async () => ({ ok: true }), daytime());
  await withTx(db.pool, (c) => pause.resumeUser(c, user.id));

  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: { after: true }, idempotencyKey: 'after' }));
  const sent = [];
  // Pinned to daytime: what is under test is the budget arithmetic, and
  // letting the drain read the wall clock made it a test of what hour it is.
  await drainOnce(db.pool, async (row) => { sent.push(row.id); return { ok: true }; }, daytime());
  assert.equal(sent.length, 1, 'six cancelled messages must not exhaust the budget on return');
});

// ---- the sweeps stop manufacturing for them ---------------------------------

test('a paused user\'s reminders never come due, so no successor is spawned', async () => {
  const { user } = await userWithDailyReminder('+972557049005',
    { remindAt: new Date(Date.now() - HOUR) });
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));

  const due = await withTx(db.pool, (c) => reminders.dueForSending(c, new Date().toISOString()));
  assert.equal(due.data.due.filter((d) => Number(d.owner_id) === Number(user.id)).length, 0);

  const { rows } = await db.pool.query(
    `SELECT count(*)::int n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1`, [user.id]);
  assert.equal(rows[0].n, 1, 'and no daily successor piles up while they are away');
});

// ---- resuming ---------------------------------------------------------------

test('resume brings a repeating reminder back at its own next real time', async () => {
  // 18:00 daily, frozen three days ago. Coming back must mean 18:00 — not
  // "now + 24h", which is how a medication reminder silently moves to 09:40.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * HOUR);
  threeDaysAgo.setUTCHours(18, 0, 0, 0);
  const { user, taskId } = await userWithDailyReminder('+972557049006', { remindAt: threeDaysAgo });
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));

  const res = await withTx(db.pool, (c) => pause.resumeUser(c, user.id));
  assert.equal(res.ok, true);
  assert.equal(res.data.rearmed.length, 1);

  const { rows } = await db.pool.query(
    `SELECT remind_at, repeat_rule FROM task_reminders
      WHERE task_id = $1 AND sent_at IS NULL AND cancelled_at IS NULL`, [taskId]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].remind_at > new Date(), 'in the future, never a moment already gone');
  assert.equal(rows[0].remind_at.getUTCHours(), 18, 'and still at the hour they chose');
  assert.equal(rows[0].repeat_rule, 'daily');

  const { rows: user2 } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [user.id]);
  assert.equal(user2[0].paused_at, null);
});

test('resume does not resurrect a one-off whose moment has passed', async () => {
  const u = await makeUser(db.pool, '+972557049007', { firstName: 'קפיש' });
  const t = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'תור רופא' }));
  await withTx(db.pool, (c) =>
    reminders.setReminder(c, u.id, t.data.task.id, new Date(Date.now() - 2 * HOUR), null));
  await withTx(db.pool, (c) => pause.pauseUser(c, u.id));

  const res = await withTx(db.pool, (c) => pause.resumeUser(c, u.id));
  assert.equal(res.data.rearmed.length, 0, 'a notification about a time already gone is noise');
});

test('resuming someone who never paused is refused, not silently accepted', async () => {
  const u = await makeUser(db.pool, '+972557049008', { firstName: 'קפיש' });
  const res = await withTx(db.pool, (c) => pause.resumeUser(c, u.id));
  assert.equal(res.ok, false);
  assert.equal(res.error.reason, 'not_paused');
});

test('after resume, proactive messages flow again', async () => {
  const { user } = await userWithDailyReminder('+972557049009');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));
  await withTx(db.pool, (c) => pause.resumeUser(c, user.id));
  await withTx(db.pool, (c) => enqueue(c, {
    userId: user.id, kind: 'checkin', payload: {}, idempotencyKey: 'back' }));
  const sent = [];
  await drainOnce(db.pool, async (row) => { sent.push(row.id); return { ok: true }; }, daytime());
  assert.equal(sent.length, 1);
});

// ---- the catch-up walk ------------------------------------------------------

test('nextOccurrenceAfter walks forward without drifting off the chosen time', () => {
  const start = new Date('2026-08-01T18:00:00.000Z');
  const notBefore = new Date('2026-08-22T07:00:00.000Z');
  const next = pause.nextOccurrenceAfter(start, 'daily', notBefore);
  assert.ok(next > notBefore);
  assert.equal(next.toISOString(), '2026-08-22T18:00:00.000Z');

  // a weekly rule lands on its weekday, not on the resume day
  const weekly = pause.nextOccurrenceAfter(
    new Date('2026-08-03T18:00:00.000Z'), 'weekly', notBefore);
  assert.equal(weekly.getUTCDay(), new Date('2026-08-03T18:00:00.000Z').getUTCDay());

  assert.equal(pause.nextOccurrenceAfter(start, null, notBefore), null, 'a one-off has no next');
});

// The flake this invariant exists to kill: paused_at used to come from a JS
// Date read after BEGIN, while cancelReminder stamps cancelled_at with the
// transaction timestamp. Under parallel load the JS value landed milliseconds
// later than the cancellations resumeUser brackets with `cancelled_at >=
// paused_at`, so resume silently re-armed nothing — about one full-suite run
// in thirty, and never when the file was run on its own.
test('pause stamps one clock, so resume can always find what it took down', async () => {
  const { user } = await userWithDailyReminder('+972557049010');
  await withTx(db.pool, (c) => pause.pauseUser(c, user.id));

  const { rows } = await db.pool.query(
    `SELECT u.paused_at, r.cancelled_at, (r.cancelled_at >= u.paused_at) AS brackets
       FROM users u JOIN tasks t ON t.owner_id = u.id JOIN task_reminders r ON r.task_id = t.id
      WHERE u.id = $1`, [user.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brackets, true, 'resumeUser filters on exactly this comparison');
  assert.deepEqual(rows[0].cancelled_at, rows[0].paused_at,
    'both must be the same transaction timestamp, not two reads of two clocks');
});
