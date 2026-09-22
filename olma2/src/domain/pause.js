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
//
// ONE exception, and it is the owner's (2026-09-13): a paused person standing
// in a WhatsApp room where a coordination starts hears about it once per
// pause (`users.room_invite_sent_at`, migration 067). Being in the room is
// not something the pause can see, and silently counting them in — as the
// room did to Kapish — is worse than one message. Their first message after
// it, whenever it comes, ends the pause (resumeAfterRoomInvite); a day of
// silence takes them out of that coordination and every later one until then
// (group-meetings.sweepSilentPausedMembers).
const { ok, err } = require('./results');
const audit = require('./audit');
const reminders = require('./reminders');

// A repeating reminder cancelled by a pause has to come back at the right
// time, not the time it was frozen at. Walking the rule forward from its own
// last occurrence — rather than just adding the interval to `now` — is what
// keeps "18:00 every day" landing at 18:00 rather than at whatever hour the
// person happened to press resume.
// users.paused_reason for a pause the check-in ladder made (migration 049).
const QUIET_LADDER = 'quiet_ladder';

// How long a paused person's one coordination message keeps them in that
// coordination with no answer, and how long after answering a "leave me
// paused" still counts as the answer to it.
const ROOM_INVITE_ANSWER_MS = 24 * 3600_000;

// Has this pause already spent its one coordination message? Read off any row
// carrying both columns (users, or groups.listMembers).
function roomInviteSpent(row) {
  if (!row || !row.paused_at || !row.room_invite_sent_at) return false;
  return new Date(row.room_invite_sent_at).getTime() >= new Date(row.paused_at).getTime();
}

const MAX_CATCHUP_STEPS = 800; // ~2 years of daily; a guard, never a limit in practice

function nextOccurrenceAfter(from, rule, notBefore, tz) {
  let cursor = new Date(from);
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++) {
    const next = reminders.nextOccurrence(cursor, rule, tz);
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
// paused_at comes from Postgres `now()`, never from a JS Date, and that is
// load-bearing rather than stylistic. resumeUser finds what to put back with
// `cancelled_at >= paused_at`, and cancelReminder stamps cancelled_at with
// now() — the TRANSACTION timestamp, fixed at BEGIN. A JS `new Date()` taken
// here is read after BEGIN, so under load it lands a few milliseconds LATER
// than the cancellations it is supposed to bracket, the filter matches
// nothing, and resume silently brings nothing back. It failed about one run in
// thirty, only ever with the whole suite running in parallel. One clock, one
// transaction timestamp, and the two are now exactly equal.
async function pauseUser(client, userId, { note = null } = {}) {
  // paused_reason = NULL: this pause is THEIRS (or the admin's), so a ladder
  // pause already in place is taken over and stops ending on its own.
  //
  // Both room-invite stamps are carried forward when they answered their one
  // coordination message in the last 24 hours. Writing ended the pause
  // (resumeAfterRoomInvite) and "leave me paused" brings them here. Without
  // this the fresh paused_at is a fresh allowance, so the next coordination
  // reaches them again; and answered_at at the same moment is what keeps
  // their NEXT message from ending this pause too.
  const { rows } = await client.query(
    `UPDATE users SET paused_at = COALESCE(paused_at, now()), paused_reason = NULL,
            room_invite_sent_at = CASE WHEN room_invite_answered_at > now() - ($2::bigint * interval '1 millisecond')
              THEN now() ELSE room_invite_sent_at END,
            room_invite_answered_at = CASE WHEN room_invite_answered_at > now() - ($2::bigint * interval '1 millisecond')
              THEN now() ELSE room_invite_answered_at END
      WHERE id = $1
      RETURNING id, paused_at`, [userId, ROOM_INVITE_ANSWER_MS]);
  if (!rows[0]) return err('not_found', 'no such user');

  // Everything already armed against them. Cancelling rather than leaving them
  // to be filtered at send time is deliberate: a pause that shows five pending
  // reminders on the dashboard has not visibly stopped anything, and the rows
  // keep their repeat_rule, which is what resume reads to put them back.
  const pending = (await client.query(
    `SELECT r.id FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE COALESCE(r.user_id, t.owner_id) = $1
        AND r.sent_at IS NULL AND r.cancelled_at IS NULL`, [userId])).rows;
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
async function resumeUser(client, userId, { now = new Date(), reason = null } = {}) {
  const { rows } = await client.query(
    `SELECT id, paused_at FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) return err('not_found', 'no such user');
  if (!rows[0].paused_at) return err('invalid', 'they are not paused', { reason: 'not_paused' });
  const pausedAt = rows[0].paused_at;

  // Only what THIS pause took down, and only one row per task — a task whose
  // reminder was cancelled and re-cancelled across two pauses must not come
  // back twice.
  const frozen = (await client.query(
    `SELECT DISTINCT ON (r.task_id) r.task_id, r.remind_at, r.repeat_rule, r.repeat_until,
            r.repeat_seq, u.timezone
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
       JOIN users u ON u.id = $1
      WHERE COALESCE(r.user_id, t.owner_id) = $1 AND r.cancelled_at >= $2
        AND r.repeat_rule IS NOT NULL
        AND t.status = 'open' AND t.archived_at IS NULL
      ORDER BY r.task_id, r.cancelled_at DESC`, [userId, pausedAt])).rows;

  const rearmed = [];
  for (const f of frozen) {
    // A chase the pause caught before its first message ever went out has
    // nothing worth preserving about its moment: that moment was "the evening
    // of the day they asked", and that day is over. Starting it again is the
    // one path that re-derives the hour, the first moment and the end together
    // — and it declines outright if the deadline went by while they were away.
    if (Number(f.repeat_seq) === 0 && f.repeat_until) {
      const again = await reminders.startChase(client, userId, f.task_id, { now });
      if (again && again.ok) {
        rearmed.push({ taskId: Number(f.task_id), remindAt: new Date(again.data.reminder.remind_at).toISOString() });
      }
      continue;
    }
    const next = nextOccurrenceAfter(f.remind_at, f.repeat_rule, now, f.timezone);
    if (!next) continue;
    // A chase comes back as the chase it was, end included. Re-arming it
    // without `until` would leave a daily nag with nothing to stop it, which is
    // the one shape the end date exists to prevent; and a chase whose deadline
    // passed during the pause is not resurrected at all, for the same reason
    // the one-off above is not — the day it was about is gone.
    const until = f.repeat_until ? new Date(f.repeat_until) : null;
    if (until && next.getTime() > until.getTime()) continue;
    const res = await reminders.setReminder(client, userId, f.task_id, next, f.repeat_rule,
      { until, seq: Number(f.repeat_seq) || 1 });
    if (res.ok) rearmed.push({ taskId: Number(f.task_id), remindAt: next.toISOString() });
  }

  await client.query(`UPDATE users SET paused_at = NULL, paused_reason = NULL WHERE id = $1`, [userId]);
  await audit.record(client, userId, 'user.resumed', {
    pausedAt, remindersRearmed: rearmed.map((r) => r.taskId),
    ...(reason ? { reason } : {}),
  });
  return ok({ rearmed });
}

// The pause the check-in ladder makes after three unanswered check-ins. It
// is NOT pauseUser: nothing on their record is cancelled — not a reminder,
// not a queued row — because the owner's rule for somebody who has stopped
// answering is "stop it arriving, cancel nothing". paused_at alone does the
// stopping: the gate drops every row for a paused person, dueForSending and
// the sweeps skip them, and the dashboard says so. A pause already in place
// (theirs) is left exactly as it is, reason included.
async function quietPause(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET paused_at = now(), paused_reason = $2
      WHERE id = $1 AND paused_at IS NULL RETURNING paused_at`, [userId, QUIET_LADDER]);
  if (!rows[0]) return ok({ paused: false });
  await audit.record(client, userId, 'user.paused', {
    note: QUIET_LADDER, reason: QUIET_LADDER,
    remindersCancelled: [], outboxCancelled: [], dataDeleted: false,
  });
  return ok({ paused: true, pausedAt: rows[0].paused_at });
}

// Ends a ladder pause, and ONLY a ladder pause, on evidence that the person
// wrote. A pause they asked for is ended by them or by the admin, never here.
// Nothing to re-arm: quietPause took nothing down.
async function quietResume(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET paused_at = NULL, paused_reason = NULL
      WHERE id = $1 AND paused_reason = $2 RETURNING id`, [userId, QUIET_LADDER]);
  if (!rows[0]) return ok({ resumed: false });
  await audit.record(client, userId, 'user.resumed', { reason: QUIET_LADDER, remindersRearmed: [] });
  return ok({ resumed: true });
}

// They wrote, for the first time since the one coordination message their
// pause allows — whenever that is (owner, 2026-09-14: "until he writes
// again"). The owner's rule is that anything they say then — other than asking
// to stay paused — means they are interested, so the pause ends in full,
// whichever kind it was: a ladder pause the way quietResume ends one, their
// own the way resume_olma does (their repeating reminders come back). "Leave
// me paused" is the model's to hear, and pause_olma puts it back with the
// allowance still spent (pauseUser above).
//
// Called from openRecord({ wake: true }) only: a turn that merely happened on
// their agent is not them answering.
async function resumeAfterRoomInvite(client, userId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT paused_at, paused_reason, room_invite_sent_at, room_invite_answered_at FROM users WHERE id = $1`,
    [userId]);
  const u = rows[0];
  if (!u || !roomInviteSpent(u)) return ok({ resumed: false });
  // Already answered: this pause is the one they asked to keep after it.
  if (u.room_invite_answered_at
      && new Date(u.room_invite_answered_at).getTime() >= new Date(u.room_invite_sent_at).getTime()) {
    return ok({ resumed: false });
  }
  await client.query(`UPDATE users SET room_invite_answered_at = now() WHERE id = $1`, [userId]);
  if (u.paused_reason === QUIET_LADDER) {
    await client.query(`UPDATE users SET paused_at = NULL, paused_reason = NULL WHERE id = $1`, [userId]);
    await audit.record(client, userId, 'user.resumed', {
      reason: 'room_invite_answered', remindersRearmed: [],
    });
    return ok({ resumed: true });
  }
  const res = await resumeUser(client, userId, { now, reason: 'room_invite_answered' });
  return res.ok ? ok({ resumed: true, rearmed: res.data.rearmed }) : res;
}

module.exports = {
  pauseUser, resumeUser, quietPause, quietResume, resumeAfterRoomInvite, roomInviteSpent,
  isPaused, nextOccurrenceAfter, QUIET_LADDER, ROOM_INVITE_ANSWER_MS,
};
