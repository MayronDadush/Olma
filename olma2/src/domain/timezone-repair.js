'use strict';
// Correcting a timezone must also correct what was written under the wrong
// one: the wall clock the person actually said, re-instantiated in the new
// zone, row by row (so a DST boundary is handled per row, never by one
// global offset).
//
//   tasks.due_at, task_reminders.remind_at   repaired (future rows, attempts = 0)
//   meetings.proposed_start_at / confirmed   REPORTED, never moved — the other
//                                            side agreed to that exact instant
//   digest_times, live_subscriptions         nothing to do — stored as local
//                                            wall clocks, resolved per run
//   past rows, user_facts.expires_at         left alone
//
// A reminder mid-escalation (attempts > 0) is a derived gap, not a chosen
// wall clock, and is not shifted. The story — a brunch reminder at 06:00,
// and nine of ten users on a zone nobody confirmed — is in docs/incidents.md,
// "A phone number is not a location (2026-08-31)".
const { partsInZone, instantInZone } = require('./datetime');
const audit = require('./audit');

// The instant whose wall clock in `toTz` reads the same as `instant`'s does in
// `fromTz`. Both conversions are Intl's, so each row gets the offset actually
// in force at its own moment.
function shiftInstant(instant, fromTz, toTz) {
  return instantInZone(toTz, partsInZone(fromTz, instant));
}

function knownZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

// Rewrites this user's own future-dated instants so their wall clock survives
// the zone change, and reports the cross-user ones it refuses to touch.
//
// The caller decides WHETHER to call this; see setTimezone for the gate. Doing
// nothing is always a valid outcome and returns empty lists, never null — "the
// repair found nothing" and "the repair did not run" must not look alike to
// whoever reads the result.
async function repairAfterZoneChange(client, userId, fromTz, toTz, { now = new Date() } = {}) {
  const empty = { tasks: [], reminders: [], meetings: [], fromTz, toTz };
  if (!knownZone(fromTz) || !knownZone(toTz) || fromTz === toTz) return empty;

  const { rows: tasks } = await client.query(
    `SELECT id, title, due_at FROM tasks
      WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL
        AND due_at IS NOT NULL AND due_at > $2
      ORDER BY due_at`,
    [userId, now]
  );
  const { rows: reminders } = await client.query(
    `SELECT r.id, r.remind_at, t.title FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
        AND r.attempts = 0 AND r.remind_at > $2
      ORDER BY r.remind_at`,
    [userId, now]
  );

  const movedTasks = [];
  for (const t of tasks) {
    const to = shiftInstant(t.due_at, fromTz, toTz);
    if (to.getTime() === t.due_at.getTime()) continue;   // same offset both sides
    await client.query(`UPDATE tasks SET due_at = $2 WHERE id = $1`, [t.id, to]);
    movedTasks.push({ id: t.id, title: t.title, from: t.due_at.toISOString(), to: to.toISOString() });
  }
  const movedReminders = [];
  for (const r of reminders) {
    const to = shiftInstant(r.remind_at, fromTz, toTz);
    if (to.getTime() === r.remind_at.getTime()) continue;
    await client.query(`UPDATE task_reminders SET remind_at = $2 WHERE id = $1`, [r.id, to]);
    movedReminders.push({ id: r.id, title: r.title, from: r.remind_at.toISOString(), to: to.toISOString() });
  }

  // Reported, not moved. `title` can be null on an untitled negotiation.
  const { rows: meetings } = await client.query(
    `SELECT m.id, m.title, m.proposed_slot,
            COALESCE(m.confirmed_start_at, m.proposed_start_at) AS starts_at
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = $1
      WHERE m.status IN ('negotiating', 'confirmed')
        AND mp.state <> 'opted_out'
        AND COALESCE(m.confirmed_start_at, m.proposed_start_at) > $2
      ORDER BY starts_at`,
    [userId, now]
  );

  if (movedTasks.length || movedReminders.length || meetings.length) {
    await audit.record(client, userId, 'user.timezone_repaired', {
      fromTz, toTz,
      tasks: movedTasks, reminders: movedReminders,
      meetingsUntouched: meetings.map((m) => m.id),
    });
  }
  return {
    fromTz, toTz,
    tasks: movedTasks,
    reminders: movedReminders,
    meetings: meetings.map((m) => ({
      id: m.id, title: m.title, slot: m.proposed_slot, startsAt: m.starts_at.toISOString(),
    })),
  };
}

module.exports = { repairAfterZoneChange, shiftInstant };
