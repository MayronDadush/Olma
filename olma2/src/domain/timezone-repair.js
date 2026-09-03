'use strict';
// Correcting a timezone corrected the SETTING and nothing already written.
//
// Sarah (user 17) joined on Aug 31 from a +1516 number — a Long Island area
// code — so provisioning guessed America/New_York. She is in Los Angeles. For
// her first 44 minutes every dated thing she said was converted through a zone
// three hours off: she said noon, the model correctly read her stored zone,
// wrote `-04:00`, and Postgres stored 09:00 her time. Her brunch reminder went
// off at 06:00. The zone was corrected that evening — and every row already
// written stayed exactly as wrong as it had been, because `setTimezone` wrote
// one column and stopped. One of those rows was still in the future three days
// later and was fixed by hand.
//
// This is not an edge case. Measured on the live box 2026-09-03: NINE of ten
// active users are carrying a zone nobody ever confirmed, with 11 future-dated
// rows underneath them. Every one of those is a Sarah the moment its owner says
// which city they are in.
//
// ---- what is repaired, and what deliberately is not ----
//
// The transformation is exact and needs no guessing: read the stored instant's
// WALL CLOCK in the old zone — that is the time the person actually said — and
// re-instantiate that same wall clock in the new one. Per row, so a DST
// boundary between two rows is handled by each on its own terms rather than by
// one global offset.
//
//   tasks.due_at, task_reminders.remind_at   repaired
//   meetings.proposed_start_at / confirmed   REPORTED, never moved
//   digest_times, live_subscriptions         nothing to do — self-healing
//   past rows                                left alone
//   user_facts.expires_at                    left alone
//
// **Meetings are another person's instant.** Both sides agreed to a specific
// moment; shifting one participant's copy would silently move a meeting for
// somebody who never heard about it, which is the whole failure that made
// meetings a hard-gated feature in the first place. They come back as a list so
// the agent can raise them with the person, who can re-propose. That is the
// person's call, not ours.
//
// **digest_times and live_subscriptions.local_hour are stored as local wall
// clocks** and resolved against whatever zone the user has AT THE TIME —
// `sweeps.js` matches HH:MM in their zone, `live-updates.computeNextRun` reads
// `sub.timezone` fresh every run. So both are already right the instant the
// column changes; a live subscription pays at most one cycle at the old hour.
// Nothing to repair, and repairing them would double-apply the shift.
//
// **Only rows in the future**, for two reasons. Rewriting history helps nobody
// — a reminder that already fired at the wrong hour cannot un-fire. And a
// reminder whose moment has passed already has an outbox row keyed to it;
// moving `remind_at` underneath a queued delivery changes nothing about when it
// goes out and only makes the two disagree.
//
// **Only reminders at `attempts = 0`.** A reminder mid-escalation has a rung
// scheduled three hours after the previous one LANDED — a derived gap, not a
// wall clock the person chose. Shifting it by a zone delta would be applying a
// timezone correction to an interval.
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
