'use strict';
// The three things it takes to answer "is this moment inside a day they keep
// quiet", assembled in ONE place.
//
// It lived inside outbox/worker.js until 2026-09-22, which was right while the
// delivery gate was the only thing that ever asked. It is not any more: a
// repeating reminder whose next occurrence lands on such a day is scheduled
// for the next day they keep instead (domain/reminders.shiftOffQuietDays), and
// that decision is made by a sweep, hours or a week before any row reaches the
// gate. Two copies of this assembly would be two answers to one question —
// the exact shape `quietDayReason` already refused for the hold and the
// release, one comment above itself.
//
// Pairs with `gate.quietDayReason(facts, tz, date)`, which is the predicate;
// this is only the facts it reads.
const preferences = require('./preferences');
const holidays = require('./holidays');

// { quietDays, quietDates, shabbatWindow } for one person, at one instant.
//
// `now` matters: `quietDates` is a forward-looking list from that moment and
// `shabbatWindow` is the one Shabbat around it, so a caller asking about a
// moment next week must pass that moment, not the clock.
async function quietFactsFor(client, user, now = new Date()) {
  const tz = user.timezone;
  // No extra query for an unstated quiet day: Saturday for somebody on a
  // Jewish calendar, Sunday for a Christian one (domain/holidays.js). A person
  // who STATED days — "none" included — is never overlaid with a guess.
  const quiet = await preferences.quietDays(client, user.id, { locale: user.locale, timezone: tz });
  // Only for somebody who asked for it, and only then is the calendar read at
  // all: `holidays` is false for everybody until they say so, so the common
  // caller costs one `if` and no import work.
  const quietDates = quiet.data.holidays
    ? await holidays.quietDates(quiet.data.calendar, { tz, from: now, il: holidays.isIsrael(tz) })
    : [];
  // An Israeli zone with Saturday among its quiet days gets the real Shabbat
  // window (candle-lighting → havdalah) instead of the plain calendar day —
  // `null` only when hebcal itself could not load, in which case 6 stays in
  // `quietDays` and the whole-day check covers that week.
  const shabbatWindow = holidays.isIsrael(tz) && quiet.data.days.includes(6)
    ? await holidays.shabbatWindow(tz, now)
    : null;
  const quietDays = shabbatWindow ? quiet.data.days.filter((d) => d !== 6) : quiet.data.days;
  return { quietDays, quietDates, shabbatWindow };
}

module.exports = { quietFactsFor };
