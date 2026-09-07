'use strict';
// Vered, 2026-09-07: eighteen messages on her second day — three onboarding
// steps released together at 08:00, nine reminders, their second rungs, and
// an evening "you have six overdue tasks, want to trim?" — and not one answer
// to any of them. The owner's rule: a person who has stopped answering hears
// nothing Olma decided to say until they write, and NOTHING on their record is
// cancelled — the reminders stay, the tasks stay; only the delivery stops.
// The check-in ladder still asks "מה איתך" after three days and after a week,
// a reminder they asked for in words still comes at its hour, and after three
// unanswered check-ins the ladder pauses them — a pause the first message they
// send ends by itself (`incidents.md`, "Eighteen messages, no answer").
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, makeUser } = require('./helpers');
const { withTx } = require('../src/db/pool');
const { decide } = require('../src/outbox/gate');
const { enqueue } = require('../src/outbox/enqueue');
const { drainOnce } = require('../src/outbox/worker');
const sweeps = require('../src/jobs/sweeps');
const checkin = require('../src/jobs/checkin');
const pause = require('../src/domain/pause');
const turn = require('../src/domain/turn');
const tasks = require('../src/domain/tasks');
const reminders = require('../src/domain/reminders');

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

const HOUR = 3600_000;
const deliverAll = (sent) => async (row) => { sent.push(row); return { ok: true }; };

// ---------------- the gate: pure policy ------------------------------------

const base = {
  plan: 'free', blocked: false, window: { start: '00:00', end: '23:59' }, tz: 'Asia/Jerusalem',
  sentToday: 0, budget: 4, now: new Date('2026-09-08T09:00:00Z'), // 12:00 local, so night is beside the point
};

test('gate: once a check-in went unanswered, nothing Olma decided to say goes out — and nothing is cancelled', () => {
  const quiet = { ...base, checkinMisses: 1 };
  for (const row of [
    { kind: 'reminder', urgency: 'urgent', payload: { rung: 1, auto: true } },  // the model's inference from a due date
    { kind: 'reminder', urgency: 'normal', payload: { rung: 2, auto: false, attempt: 2 } }, // Olma's follow-up, even on one they asked for
    { kind: 'reminder', urgency: 'normal', payload: { rung: 3, auto: false, attempt: 3, finalAttempt: true } },
    { kind: 'reminder', urgency: 'urgent', payload: { title: 'x' } },           // an old row with no rung and no auto: not provably theirs
    { kind: 'digest', urgency: 'normal', payload: {} },
    { kind: 'connection_request', urgency: 'urgent', payload: {} },             // somebody ELSE's action
  ]) {
    const v = decide({ ...quiet, row });
    assert.equal(v.action, 'drop', `${row.kind} ${JSON.stringify(row.payload)} must not reach them`);
    assert.equal(v.holdReason, 'quiet', 'a drop on the OUTBOX row, by name — not a hold, not a cancel');
  }
  // What still passes: the ladder's own "מה איתך", and rung 1 of a reminder they asked for in words.
  assert.equal(decide({ ...quiet, row: { kind: 'checkin', urgency: 'normal', payload: { rung: 'silence' } } }).action, 'deliver');
  assert.equal(decide({ ...quiet, row: { kind: 'reminder', urgency: 'urgent', payload: { rung: 1, auto: false } } }).action, 'deliver');
  // Two misses and three are the same silence.
  assert.equal(decide({ ...quiet, checkinMisses: 3, row: { kind: 'digest', urgency: 'normal', payload: {} } }).holdReason, 'quiet');
  // And a person who answers gets all of it.
  for (const row of [
    { kind: 'reminder', urgency: 'urgent', payload: { rung: 1, auto: true } },
    { kind: 'reminder', urgency: 'normal', payload: { rung: 2, auto: true, attempt: 2 } },
    { kind: 'digest', urgency: 'normal', payload: {} },
  ]) {
    assert.equal(decide({ ...base, checkinMisses: 0, row }).action, 'deliver');
    assert.equal(decide({ ...base, row }).action, 'deliver', 'a caller that never heard of the fact is not quiet');
  }
});

test('gate: pause and expiry are judged before the quiet, so their reasons keep their names', () => {
  const quiet = { ...base, checkinMisses: 1, row: { kind: 'digest', urgency: 'normal', payload: {} } };
  assert.equal(decide({ ...quiet, paused: true }).holdReason, 'paused');
  assert.equal(decide({ ...quiet, row: { ...quiet.row, expires_at: new Date(base.now.getTime() - 1000) } }).action, 'expire');
});

// ---------------- the worker: what actually happens to her reminders --------

test('an automatic reminder is dropped as quiet, stays on her record, and its ladder is never chased; one asked for in words still comes', async () => {
  const u = await makeUser(db.pool, '+972661000001', { firstName: 'ורד' });
  // The auto reminder refuses a moment already past, so both are armed half an
  // hour ahead and the sweep runs at a `now` past them.
  //
  // The due moment is nudged off local midnight first. A due date AT local
  // midnight is DAY-shaped (auto-reminder.isDayShaped: hh === 0 && mi === 0)
  // and earns 08:00 that morning instead of an hour before, which is correct
  // product behaviour and would silently change what this test is about — the
  // auto reminder would not be due at `now` and the sweep would find one
  // reminder instead of two. This user has no timezone, so the zone is UTC,
  // and `now + 90m` lands inside that minute for one minute of every day. The
  // on-box suite ran inside it on 2026-09-08 and the deploy went red on bytes
  // that had passed twice (CLAUDE.md, Testing: never let a test depend on the
  // hour it runs).
  let dueAt = new Date(Date.now() + 90 * 60_000);
  if (dueAt.getUTCHours() === 0 && dueAt.getUTCMinutes() === 0) {
    dueAt = new Date(dueAt.getTime() + 60_000);
  }
  const armedAt = new Date(dueAt.getTime() - 60 * 60_000);
  const now = new Date(armedAt.getTime() + 5 * 60_000);
  // The brain-dump shape: a task the model dated, so an automatic reminder an
  // hour before it.
  await withTx(db.pool, (c) => tasks.addTask(c, u.id, {
    title: 'לבדוק משימות נוספות', dueAt: dueAt.toISOString(),
  }));
  // And one she asked for: "תזכירי לי" — no due date, an explicit reminder.
  const asked = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'להתקשר לרופא' }));
  await withTx(db.pool, (c) => reminders.setReminder(c, u.id, asked.data.task.id, armedAt.toISOString()));
  const { rows: armed } = await db.pool.query(
    `SELECT r.id, r.task_id, r.auto, r.remind_at FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 ORDER BY r.id`, [u.id]);
  assert.equal(armed.length, 2);
  const autoRow = armed.find((r) => r.auto);
  const wordsRow = armed.find((r) => !r.auto);
  assert.ok(autoRow && wordsRow, 'one automatic, one asked for');
  // Says out loud what the nudge above is protecting: an hour before the
  // moment, not 08:00. If this ever reads as the morning again, the failure
  // names its own cause instead of surfacing as a miscount further down.
  assert.equal(new Date(autoRow.remind_at).getTime(), armedAt.getTime(),
    'the dated task is moment-shaped, so its reminder is an hour before — not the 08:00 a day-shaped one earns');

  // She let a check-in pass.
  await db.pool.query(`UPDATE users SET checkin_misses = 1 WHERE id = $1`, [u.id]);

  const swept = await withTx(db.pool, (c) => sweeps.sweepReminders(c, now));
  assert.equal(swept.length, 2, 'the sweep does not know about the quiet — the gate is the chokepoint');
  const { rows: queued } = await db.pool.query(
    `SELECT idempotency_key, payload FROM outbox WHERE user_id = $1 ORDER BY id`, [u.id]);
  assert.equal(queued.find((q) => q.idempotency_key === `reminder:${autoRow.id}`).payload.auto, true, 'the payload says whose idea it was');
  assert.equal(queued.find((q) => q.idempotency_key === `reminder:${wordsRow.id}`).payload.auto, false);

  const sent = [];
  const out = await drainOnce(db.pool, deliverAll(sent), now);
  assert.equal(out.dropped, 1);
  assert.equal(sent.length, 1, 'only the one she asked for reached the deliverer');
  assert.equal(sent[0].payload.taskId, Number(asked.data.task.id));
  const { rows: [auto] } = await db.pool.query(
    `SELECT sent_at, hold_reason, attempts, last_error FROM outbox WHERE idempotency_key = $1`, [`reminder:${autoRow.id}`]);
  assert.ok(auto.sent_at, 'stamped, so the sweep cannot recreate it');
  assert.equal(auto.hold_reason, 'quiet');
  assert.equal(auto.attempts, 0);
  assert.equal(auto.last_error, null, 'a gate drop, not a dead pipe — so nothing will redo it');

  // Cancel nothing: the reminder and the task are exactly as she left them.
  const { rows: [still] } = await db.pool.query(
    `SELECT r.cancelled_at, r.sent_at, t.status FROM task_reminders r JOIN tasks t ON t.id = r.task_id WHERE r.id = $1`, [autoRow.id]);
  assert.equal(still.cancelled_at, null);
  assert.equal(still.sent_at, null);
  assert.equal(still.status, 'open');

  // And the ladder ends where it stood: three hours on, no rung 2 for the dropped one.
  const later = await withTx(db.pool, (c) => sweeps.sweepReminders(c, new Date(now.getTime() + 3.5 * HOUR)));
  const { rows: rung2 } = await db.pool.query(
    `SELECT idempotency_key FROM outbox WHERE user_id = $1 AND idempotency_key LIKE 'reminder:%:2'`, [u.id]);
  assert.ok(!rung2.some((r) => r.idempotency_key === `reminder:${autoRow.id}:2`), 'a rung the gate dropped is never chased');
  // (the one that landed does climb — and rung 2 is Olma's moment, so the gate drops that too)
  assert.ok(later.length >= 1);
  const sent2 = [];
  const out2 = await drainOnce(db.pool, deliverAll(sent2), new Date(now.getTime() + 3.5 * HOUR));
  assert.equal(sent2.length, 0, 'rung 2 of the reminder she asked for is Olma\'s follow-up, not her hour');
  assert.equal(out2.dropped, 1);
});

// ---------------- the ladder: what it says, and where it ends ---------------

test('after one miss, Olma\'s opinions step aside — overload and a stalled goal do not outrank the quiet; a deadline still does', async () => {
  const u = await makeUser(db.pool, '+972661000002', { firstName: 'דנה' });
  await withTx(db.pool, async (c) => {
    for (let i = 0; i < 6; i++) {
      const t = (await tasks.addTask(c, u.id, { title: 'old ' + i, dueAt: new Date(Date.now() - 24 * HOUR).toISOString() })).data.task;
      await c.query(`UPDATE tasks SET created_at = now() - interval '5 days' WHERE id = $1`, [t.id]);
    }
  });
  assert.equal((await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 0))).rung, 'overload', 'six overdue: Olma would offer to trim');
  const quiet = await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 1));
  assert.equal(quiet.rung, 'silence', 'but not to somebody who did not answer the last time she asked');
  assert.match(quiet.instruction, /no question mark/);

  // A deadline tomorrow is THEIRS and still comes first.
  await withTx(db.pool, async (c) => {
    const t = (await tasks.addTask(c, u.id, { title: 'להגיש דוח', dueAt: new Date(Date.now() + 12 * HOUR).toISOString() })).data.task;
    await c.query(`UPDATE tasks SET created_at = now() - interval '2 days' WHERE id = $1`, [t.id]);
  });
  assert.equal((await withTx(db.pool, (c) => checkin.pickRung(c, u.id, 1))).rung, 'deadline_risk');
});

test('the third unanswered check-in pauses them — cancelling nothing — and the check-in itself is not delivered', async () => {
  const u = await makeUser(db.pool, '+972661000003', { firstName: 'ורד' });
  const t = await withTx(db.pool, (c) => tasks.addTask(c, u.id, { title: 'לארגן אימון', dueAt: new Date(Date.now() + 3 * 24 * HOUR).toISOString() }));
  await db.pool.query(
    `UPDATE users SET onboarded_at = now() - interval '20 days', created_at = now() - interval '20 days',
            checkin_misses = 2, last_checkin_at = now() - interval '8 days' WHERE id = $1`, [u.id]);
  await db.pool.query(`UPDATE audit_log SET created_at = now() - interval '20 days' WHERE actor_id = $1`, [u.id]);

  const results = await withTx(db.pool, (c) => checkin.run(c));
  assert.ok(results.some((r) => Number(r.userId) === Number(u.id)), 'the weekly one-liner is asked');
  const { rows: [after3] } = await db.pool.query(`SELECT checkin_misses, paused_at, paused_reason FROM users WHERE id = $1`, [u.id]);
  assert.equal(after3.checkin_misses, 3);
  assert.ok(after3.paused_at, 'paused');
  assert.equal(after3.paused_reason, 'quiet_ladder', 'and the record says who paused them');
  const { rows: [rem] } = await db.pool.query(
    `SELECT cancelled_at FROM task_reminders WHERE task_id = $1`, [t.data.task.id]);
  assert.equal(rem.cancelled_at, null, 'the pause the ladder makes takes nothing down');
  const { rows: audit } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.paused'`, [u.id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.reason, 'quiet_ladder');
  assert.deepEqual(audit[0].detail.remindersCancelled, []);

  // The check-in that was just enqueued meets the gate as a paused person's row.
  const sent = [];
  await drainOnce(db.pool, deliverAll(sent));
  assert.equal(sent.filter((r) => Number(r.user_id) === Number(u.id)).length, 0, '"this is the last one" would be one more');
  const { rows: [row] } = await db.pool.query(
    `SELECT hold_reason FROM outbox WHERE user_id = $1 AND kind = 'checkin' ORDER BY id DESC LIMIT 1`, [u.id]);
  assert.equal(row.hold_reason, 'paused');

  // Idempotent: the next tick neither asks again nor pauses again.
  const again = await withTx(db.pool, (c) => checkin.run(c));
  assert.ok(!again.some((r) => Number(r.userId) === Number(u.id)), 'a paused person is not on the ladder');
});

// ---------------- the way back ---------------------------------------------

test('a ladder pause ends on the first message they send; a pause they asked for does not', async () => {
  const ladder = await makeUser(db.pool, '+972661000004', { firstName: 'ורד' });
  const asked = await makeUser(db.pool, '+972661000005', { firstName: 'קפיש' });
  await withTx(db.pool, (c) => pause.quietPause(c, ladder.id));
  await withTx(db.pool, (c) => pause.pauseUser(c, asked.id, { note: 'said stop' }));

  // A turn that merely happened on their agent is not them writing.
  await withTx(db.pool, (c) => turn.openRecord(c, ladder, { wake: false }));
  let { rows: [l] } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [ladder.id]);
  assert.ok(l.paused_at, 'an inferred turn does not end it — the Sarah rule');

  await withTx(db.pool, (c) => turn.openRecord(c, ladder, { wake: true }));
  ({ rows: [l] } = await db.pool.query(`SELECT paused_at, paused_reason, checkin_misses FROM users WHERE id = $1`, [ladder.id]));
  assert.equal(l.paused_at, null, 'she wrote: the pause is over');
  assert.equal(l.paused_reason, null);
  assert.equal(l.checkin_misses, 0, 'and the ladder starts from the top');
  const { rows: resumed } = await db.pool.query(
    `SELECT detail FROM audit_log WHERE actor_id = $1 AND event = 'user.resumed'`, [ladder.id]);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].detail.reason, 'quiet_ladder');

  await withTx(db.pool, (c) => turn.openRecord(c, asked, { wake: true }));
  const { rows: [a] } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [asked.id]);
  assert.ok(a.paused_at, 'a pause THEY asked for is theirs to end');

  // Once resumed, proactive messages flow again.
  await withTx(db.pool, (c) => enqueue(c, { userId: ladder.id, kind: 'checkin', payload: {}, idempotencyKey: 'back-' + ladder.id }));
  const sent = [];
  await drainOnce(db.pool, deliverAll(sent), new Date(new Date().setUTCHours(12, 0, 0, 0)));
  assert.ok(sent.some((r) => Number(r.user_id) === Number(ladder.id)));
});

test('a person who says stop while ladder-paused owns the pause from then on', async () => {
  const u = await makeUser(db.pool, '+972661000006', { firstName: 'רון' });
  await withTx(db.pool, (c) => pause.quietPause(c, u.id));
  await withTx(db.pool, (c) => pause.pauseUser(c, u.id));
  const { rows: [r] } = await db.pool.query(`SELECT paused_at, paused_reason FROM users WHERE id = $1`, [u.id]);
  assert.ok(r.paused_at);
  assert.equal(r.paused_reason, null, 'theirs now');
  await withTx(db.pool, (c) => turn.openRecord(c, u, { wake: true }));
  const { rows: [still] } = await db.pool.query(`SELECT paused_at FROM users WHERE id = $1`, [u.id]);
  assert.ok(still.paused_at, 'writing does not undo a pause they asked for');
  // and quietPause over a pause already in place changes nothing
  const res = await withTx(db.pool, (c) => pause.quietPause(c, u.id));
  assert.equal(res.data.paused, false);
  // the way back is the one they have always had
  await withTx(db.pool, (c) => pause.resumeUser(c, u.id));
  const { rows: [back] } = await db.pool.query(`SELECT paused_at, paused_reason FROM users WHERE id = $1`, [u.id]);
  assert.equal(back.paused_at, null);
  assert.equal(back.paused_reason, null);
});

// ---------------- what the operator sees -----------------------------------

test('the admin page names both pauses and the quiet drop', async () => {
  const u = await makeUser(db.pool, '+972661000007', { firstName: 'ורד' });
  await withTx(db.pool, (c) => pause.quietPause(c, u.id));
  const { renderUserPage } = require('../src/adapters/http/admin/user-page');
  const { renderUsers } = require('../src/adapters/http/admin/sections/users');
  const { OUTBOX_STATE } = require('../src/adapters/http/admin/sections/planned');
  const c = await db.pool.connect();
  try {
    const page = await renderUserPage(c, u.id, {});
    assert.match(page, /מושהה — לא עונה/);
    assert.match(page, /שום דבר לא בוטל/);
    assert.doesNotMatch(page, /ביקש להפסיק/);
    const list = await renderUsers(c, 'csrf');
    assert.match(list, /מושהה — לא עונה/);
  } finally { c.release(); }
  assert.equal(OUTBOX_STATE.quiet, 'נעצרו — לא עונה');
});
