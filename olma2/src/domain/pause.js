'use strict';
// Stopping, without deleting.
//
// A user wrote "אני רוצה להפסיק את השירות", was asked "בטוח?", answered "זהו",
// and got a warm goodbye — followed by a proactive check-in the next morning
// and a medication reminder still armed for that evening. The agent had handled
// the conversation exactly right and then called nothing, because there was
// nothing to call: no tool, no dashboard control, and `checkin_enabled` was a
// column one query read and nothing on earth wrote.
//
// The design rule here is that pausing is REVERSIBLE and never destructive.
// Someone who is done with a product is not asking to be erased, and treating
// "stop messaging me" as "delete my account" would be a second thing done to
// them that they did not ask for. Their tasks, facts, preferences and history
// all stay exactly where they are. If they come back, everything is still
// theirs.
//
// What pause actually means: **Olma never initiates again.** Every proactive
// path — check-ins, reminders, digests, and another user's fan-out landing on
// them — is off. Replying when they write is not initiating, and stays on: a
// person who writes wants something, and answering them is not the thing they
// asked us to stop.
const { ok, err } = require('./results');
const audit = require('./audit');
const reminders = require('./reminders');

// A repeating reminder cancelled by a pause has to come back at the right
// time, not the time it was frozen at. Walking the rule forward from its own
// last occurrence — rather than just adding the interval to `now` — is what
// keeps "18:00 every day" landing at 18:00 rather than at whatever hour the
// person happened to press resume.
const MAX_CATCHUP_STEPS = 800; // ~2 years of daily; a guard, never a limit in practice

function nextOccurrenceAfter(from, rule, notBefore) {
  let cursor = new Date(from);
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    const next = reminders.nextOccurrence(cursor, rule);
    if (!next) return null; // one-off: nothing to re-arm
    if (next > notBefore) return next;
    cursor = next;
  }
  return null;
}

async function isPaused(client, userId) {
  const { rows } = await client.query(`SELECT paused_at FROM users WHERE id = $1`, [userId]);
  return Boolean(rows[0] && rows[0].paused_at);
}

// note: what they actually said, stored on the audit row only. It is their
// words about our product, so it belongs in the trail an operator reads — not
// on their card, where it would become something the agent brings up.
async function pauseUser(client, userId, { note = null, now = new Date() } = {}) {
  const { rows } = await client.query(
    `UPDATE users SET paused_at = COALESCE(paused_at, $2) WHERE id = $1
      RETURNING id, paused_at`, [userId, now]);
  if (!rows[0]) return err('not_found', 'no such user');

  // Everything already armed against them. Cancelling rather than leaving them
  // to be filtered at send time is deliberate: a pause that shows five pending
  // reminders on the dashboard has not visibly stopped anything, and the rows
  // keep their repeat_rule, which is what resume reads to put them back.
  const pending = (await client.query(
    `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL`, [userId])).rows;
  for (const r of pending) await reminders.cancelReminder(client, userId, r.id);

  // Queued messages are cancelled the way the dashboard cancels one: an UPDATE
  // carrying the idempotency key, never a DELETE, or the sweep that produced
  // the row simply produces it again on the next tick.
  const queued = (await client.query(
    `UPDATE outbox SET sent_at = now(), hold_reason = 'paused'
      WHERE user_id = $1 AND sent_at IS NULL RETURNING id`, [userId])).rows;

  await audit.record(client, userId, 'user.paused', {
    note: note ? String(note).slice(0, 500) : null,
    remindersCancelled: pending.map((r) => Number(r.id)),
    outboxCancelled: queued.map((r) => Number(r.id)),
    dataDeleted: false,
  });
  return ok({
    pausedAt: rows[0].paused_at,
    remindersCancelled: pending.length,
    outboxCancelled: queued.length,
  });
}

// Puts back what the pause took down, and nothing else. Reminders return at
// their own next real occurrence; a one-off whose moment passed while they were
// away is NOT resurrected, because firing it now would be a notification about
// a time that is already gone.
async function resumeUser(client, userId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT id, paused_at FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return err('not_found', 'no such user');
  if (!rows[0].paused_at) return err('invalid', 'they are not paused', { reason: 'not_paused' });
  const pausedAt = rows[0].paused_at;

  // Only what THIS pause took down, and only one row per task — a task whose
  // reminder was cancelled and re-cancelled across two pauses must not come
  // back twice.
  const frozen = (await client.query(
    `SELECT DISTINCT ON (r.task_id) r.task_id, r.remind_at, r.repeat_rule
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.cancelled_at >= $2
        AND r.repeat_rule IS NOT NULL
        AND t.status = 'open' AND t.archived_at IS NULL
      ORDER BY r.task_id, r.cancelled_at DESC`, [userId, pausedAt])).rows;

  const rearmed = [];
  for (const f of frozen) {
    const next = nextOccurrenceAfter(f.remind_at, f.repeat_rule, now);
    if (!next) continue;
    const res = await reminders.setReminder(client, userId, f.task_id, next, f.repeat_rule);
    if (res.ok) rearmed.push({ taskId: Number(f.task_id), remindAt: next.toISOString() });
  }

  await client.query(`UPDATE users SET paused_at = NULL WHERE id = $1`, [userId]);
  await audit.record(client, userId, 'user.resumed', {
    pausedAt, remindersRearmed: rearmed.map((r) => r.taskId),
  });
  return ok({ rearmed });
}

module.exports = { pauseUser, resumeUser, isPaused, nextOccurrenceAfter };
