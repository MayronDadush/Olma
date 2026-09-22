'use strict';
// Everything it takes to answer "is this moment inside a day they keep quiet",
// and — since 2026-09-22 — "if it is, when is the next moment that is not".
//
// The facts lived inside outbox/worker.js and the predicate inside outbox/gate.js,
// which was right while the delivery gate was the only thing that ever asked.
// It is not any more: a repeating reminder whose next occurrence lands on such
// a day is SCHEDULED for the next day they keep, and that decision is made by
// a sweep, hours or a week before any row reaches the gate. Two copies of this
// would be two answers to one question — the exact shape `quietDayReason`
// already refuses between the hold and the release, one comment above itself.
//
// `gate.js` re-exports the three predicates below so every existing caller and
// `tests/group-window.test.js` keep importing them from where they were.
const preferences = require('./preferences');
const holidays = require('./holidays');
const dt = require('./datetime');

// Which day of the week it is where THEY are — 0 = Sunday, matching
// preferences.DAY_NAMES. Fail-open: a broken zone falls back to UTC rather
// than throwing inside the gate.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function weekdayInTz(tz, date = new Date()) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', weekday: 'short',
    }).format(date);
    const d = WEEKDAYS[s];
    return d === undefined ? date.getUTCDay() : d;
  } catch {
    return date.getUTCDay();
  }
}

// The local calendar date where THEY are. Same fail-open shape, and the same
// reason the weekday is asked in their zone rather than the server's: 23:00
// UTC on the 20th is already the 21st in Jerusalem, and Yom Kippur is a DATE,
// not an instant.
function localDateInTz(tz, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// Is this a day they keep? A weekday they named, or — only for somebody who
// asked for it — a date the calendar says is a yom tov. One predicate for both
// so the hold and the RELEASE can never disagree about which days exist:
// Rosh Hashana runs into Shabbat often enough that a release computed from
// weekdays alone would wake a row in the middle of a three-day run.
//
// `facts.shabbatWindow` is the one exception to "a day": for an Israeli zone
// whose Saturday is quiet, the caller already resolved candle-lighting →
// havdalah and dropped 6 out of `quietDays` (holidays.shabbatWindow), so the
// weekday check below never also fires for Saturday and extend the hold past
// nightfall into a plain calendar-day boundary.
function quietDayReason(facts, tz, date) {
  const sw = facts.shabbatWindow;
  if (sw && date >= sw.start && date < sw.end) return 'quiet_day';
  const days = facts.quietDays || [];
  if (days.includes(weekdayInTz(tz, date))) return 'quiet_day';
  const dates = facts.quietDates || [];
  if (dates.length && dates.includes(localDateInTz(tz, date))) return 'quiet_holiday';
  return null;
}

// ---- the facts, in two halves -----------------------------------------------
//
// The split is what makes the walk below affordable. Which days somebody keeps
// is a property of the PERSON and costs a query; which window Shabbat occupies
// and which dates are yom tov are properties of a MOMENT, and a walk that
// re-read the person on every candidate day would ask the same question eight
// times to cross Pesach.

// One query. Nothing here depends on when you are asking.
async function quietPrefsFor(client, user) {
  // No extra query for an unstated quiet day: Saturday for somebody on a
  // Jewish calendar, Sunday for a Christian one (domain/holidays.js). A person
  // who STATED days — "none" included — is never overlaid with a guess.
  const quiet = await preferences.quietDays(client, user.id, {
    locale: user.locale, timezone: user.timezone,
  });
  return { tz: user.timezone, quiet: quiet.data };
}

// …and the half that moves. `at` matters: `quietDates` is a forward-looking
// list from that moment and `shabbatWindow` is the one Shabbat around it, so a
// caller asking about a moment next week must pass that moment, not the clock.
async function quietFactsAt(prefs, at = new Date()) {
  const { tz, quiet } = prefs;
  // Only for somebody who asked for it, and only then is the calendar read at
  // all: `holidays` is false for everybody until they say so, so the common
  // caller costs one `if` and no import work.
  const quietDates = quiet.holidays
    ? await holidays.quietDates(quiet.calendar, { tz, from: at, il: holidays.isIsrael(tz) })
    : [];
  // An Israeli zone with Saturday among its quiet days gets the real Shabbat
  // window (candle-lighting → havdalah) instead of the plain calendar day —
  // `null` only when hebcal itself could not load, in which case 6 stays in
  // `quietDays` and the whole-day check covers that week.
  const shabbatWindow = holidays.isIsrael(tz) && quiet.days.includes(6)
    ? await holidays.shabbatWindow(tz, at)
    : null;
  const quietDays = shabbatWindow ? quiet.days.filter((d) => d !== 6) : quiet.days;
  return { quietDays, quietDates, shabbatWindow };
}

// { quietDays, quietDates, shabbatWindow } for one person, at one instant.
async function quietFactsFor(client, user, now = new Date()) {
  return quietFactsAt(await quietPrefsFor(client, user), now);
}

// ---- moving a repeating reminder off a quiet day ----------------------------
//
// The owner's rule, 2026-09-22: "אם זה לא תזכורת ספציפית ליום שבת - אז היא לא
// צריכה להגיע כמו שהמשימות של הדיגסט בוקר לא מגיעות." A repeating reminder
// that merely LANDS on a day they keep waits for the next one they do not; one
// whose rule NAMES that day still goes out, because that day is what they
// asked for.
//
// Why this is here and not in the gate, which is where every other quiet-day
// decision is made: the gate's order is paused → eval → EXPIRY → … → quiet
// day, and a repeating reminder is always rung 1, whose row expires at
// `remind_at + 2h`. A hold over Shabbat would come back on Sunday morning,
// meet the expiry check first, and delete the message rather than delay it.
// And a "held until Sunday" DAILY reminder would land in the same hour as
// Sunday's own occurrence. So the moment moves, not the message.
//
// It is a SHIFT and never a skip. Skipping is what makes a monthly reminder
// vanish for a month, which is the same thing `reminders.nextOccurrence`
// already refuses to do when February is short.
const SHIFT_MAX_DAYS = 21;

// The moment this should actually fire at. Returns the original when it is
// already on a day they keep, or when the rule NAMES the weekday it falls on.
//
// `namedDays` is what the rule says out loud (reminders.daysNamedBy) — an
// empty list for 'daily', plain 'weekly' and every 'monthly:*', which is
// exactly right: a rule that names no day cannot have asked for this one.
//
// The same local HOUR on the next kept day, never a flat +24h: an 08:00
// promise is a wall-clock promise, and a DST boundary inside a run of quiet
// days would otherwise move it to 07:00 (domain/reminders.nextOccurrence, same
// argument).
async function keptMomentFor(client, user, moment, { namedDays = [], maxDays = SHIFT_MAX_DAYS } = {}) {
  const at = new Date(moment);
  if (Number.isNaN(at.getTime())) return { at: new Date(moment), movedFrom: null, reason: null };
  const tz = user.timezone || 'UTC';
  const prefs = await quietPrefsFor(client, user);
  if (!prefs.quiet.days.length && !prefs.quiet.holidays) {
    return { at, movedFrom: null, reason: null };   // nobody keeps anything
  }

  const reason = quietDayReason(await quietFactsAt(prefs, at), tz, at);
  if (!reason) return { at, movedFrom: null, reason: null };
  // They asked for THIS day. A quiet day somebody names is a day they want to
  // hear on, and the whole point of naming it.
  if (namedDays.includes(weekdayInTz(tz, at))) return { at, movedFrom: null, reason: null };

  const p = dt.partsInZone(tz, at);
  for (let step = 1; step <= maxDays; step++) {
    // Anchored on the local calendar day, so the hour survives DST.
    const cand = dt.instantInZone(tz, { y: p.y, m: p.m, d: p.d + step, hh: p.hh, mi: p.mi, ss: p.ss });
    if (!quietDayReason(await quietFactsAt(prefs, cand), tz, cand)) {
      return { at: cand, movedFrom: at, reason };
    }
  }
  // Unreachable in practice — parseQuietDays refuses all seven weekdays and no
  // run of yom tov comes close to three weeks. Answering with the ORIGINAL is
  // the fail-open half: a reminder that arrives on a quiet day is a nuisance,
  // and one that never arrives at all is the bug this is not allowed to be.
  return { at, movedFrom: null, reason: null };
}

module.exports = {
  quietFactsFor, quietPrefsFor, quietFactsAt,
  weekdayInTz, localDateInTz, quietDayReason,
  keptMomentFor, SHIFT_MAX_DAYS,
};
