'use strict';
// When a task carries a moment, Olma sets the reminder itself.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// Miron walked his own onboarding on 2026-09-04 and dumped five tasks. One of
// them — "לאסוף את הילדים", tomorrow 16:00 — came back as a question:
// "רוצה שאזכיר לך מחר על האיסוף של הילדים?" He said yes, and only then did a
// reminder exist. A second task in the same dump ("דייט עם מאיה ליום ראשון")
// also had a due date and was never offered one at all.
//
// Both halves of that are the bug. The doctrine said "offer a reminder", so
// whether a timed task ended up with one depended on the model remembering to
// ask AND the person remembering to answer — which is why two tasks created in
// the same call got different treatment. A due date IS the request; asking
// permission to act on it is the "act first, ask second" rule being broken by
// the one paragraph that told the model to ask.
//
// So the offer becomes a default, and the interesting decision moves here,
// where it is deterministic and testable, instead of into a prompt.
//
// ── The rule, in the shape Miron stated it ───────────────────────────────────
// "שעה לפני או באותו יום בבוקר" — an hour before, or that morning. Those are
// two cases because due dates come in two kinds, and the difference is visible
// in the data:
//
//   - A moment ("tomorrow at 16:00") stores a real local time. An hour before
//     is the useful warning: enough to leave, not so early it is forgotten.
//   - A DAY ("Sunday", "the 3rd") is stored as local midnight, because that is
//     what a date with no time means. Reminding someone an hour before local
//     midnight is 23:00 the night before — the single worst moment available.
//     A day-shaped task earns a morning instead.
//
// Local midnight is therefore the discriminator, and it is read in the
// PERSON's zone, never UTC: 2026-09-05T21:00:00Z is 21:00 for a user in London
// and midnight for one in Tel Aviv, and only the second is a day-shaped task.
const { partsInZone, instantInZone } = require('./datetime');

// An hour is the lead Miron asked for. The morning hour is 08:00 because that
// is when the default digest runs — a day-shaped reminder lands in the same
// part of the morning the person already hears from Olma, rather than
// inventing a second "Olma o'clock".
const LEAD_MINUTES = 60;
const MORNING_HOUR = 8;

// Far-future tasks get no reminder now. Not a spam guard — a correctness one:
// a due date months out is a note about a plan, and a reminder written today
// for March would sit through every rescheduling in between. Reminders for
// those are worth setting when the moment is actually near, and until then
// the digest and the task list already carry them.
const HORIZON_DAYS = 60;

// A dump has to stay a dump. Somebody pasting a term's worth of deadlines in
// one `add_tasks_bulk` should not thereby arm thirty separate messages — the
// per-call cap keeps the reflex useful for a normal dump and refuses to turn a
// big one into a firehose. The caller REPORTS what it skipped rather than
// swallowing it (CLAUDE.md: no silent caps), so the model can offer the rest.
const BULK_CAP = 8;

// Is this due date day-shaped (local midnight) rather than moment-shaped?
function isDayShaped(dueAt, timezone) {
  const p = partsInZone(timezone, new Date(dueAt));
  return p.hh === 0 && p.mi === 0;
}

// The moment to remind at, as an ISO string with a real offset, or null when
// no reminder should be created. Null is a real answer: "nothing to do here"
// and "something went wrong" must never be the same value, so anything
// unparseable returns null and the caller carries on without a reminder.
//
// `now` is a parameter and not Date.now() so the tests can state the hour they
// mean — this file would otherwise pass or fail depending on when it runs,
// which the suite has been burned by before (CLAUDE.md, Testing).
function autoReminderAt(dueAt, timezone, now = new Date()) {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (!Number.isFinite(due.getTime())) return null;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return null;

  // Already past, or too far out to be worth arming yet.
  if (due.getTime() <= nowMs) return null;
  if (due.getTime() - nowMs > HORIZON_DAYS * 86400_000) return null;

  const tz = timezone || 'UTC';
  let at;
  if (isDayShaped(due, tz)) {
    // That morning, in their zone — the same calendar day the task is for.
    const p = partsInZone(tz, due);
    at = new Date(instantInZone(tz, { y: p.y, m: p.m, d: p.d, hh: MORNING_HOUR, mi: 0, ss: 0 }));
  } else {
    at = new Date(due.getTime() - LEAD_MINUTES * 60_000);
  }

  // The computed moment can land in the past even though the due date has not:
  // a task added at 15:30 for 16:00 today, or a day-shaped one added at noon
  // for later the same day. Reminding retroactively is worse than not
  // reminding, and the task is visible in the list either way.
  if (at.getTime() <= nowMs) return null;
  return at.toISOString();
}

module.exports = { autoReminderAt, isDayShaped, LEAD_MINUTES, MORNING_HOUR, HORIZON_DAYS, BULK_CAP };
