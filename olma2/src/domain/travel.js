'use strict';
// Does this person's own calendar say they are about to be somewhere else?
//
// The ask, not the act. Everything here ends in a QUESTION — "you look like
// you are in Barcelona from the 14th, should I move you to that clock?" —
// because a timezone is the one setting where being wrong is worse than being
// silent: it moves every reminder, the morning digest and the quiet-hours
// window at once. A false positive here costs one slightly-off question. A
// false positive that ACTED would cost someone their 06:00 alarm.
//
// ---- why the obvious signal is not enough on its own ----
//
// Google puts a `timeZone` on every timed event, and it is tempting to read a
// foreign one as "they are abroad". It is not: that field carries the zone the
// event was DEFINED in, which for a meeting booked by a colleague in Berlin is
// Europe/Berlin while the user sits in Tel Aviv. Read naively it fires on
// every cross-border video call this person takes.
//
// So a single foreign-zone event is never enough. What is:
//
//   * a MULTI-DAY all-day event — the shape of "Barcelona 14-20" or a hotel
//     booking; nobody blocks four whole days for a call, and
//   * TWO OR MORE timed events in the same foreign clock on DIFFERENT days —
//     one is a call, a week of mornings is a trip.
//
// ---- and why the comparison is offsets, never names ----
//
// Europe/Madrid and Europe/Paris are different names for the same wall clock.
// Comparing zone strings would announce a trip to someone who flew Madrid to
// Paris and whose clock did not move at all. What matters is whether the
// person's day would read differently, which is the OFFSET at that instant —
// and per instant, so a trip that straddles a DST change is judged on each
// event's own terms.
const { zoneOffsetMs } = require('./datetime');

// Two timed events on separate days, or one all-day block of at least this
// many days. Both are deliberately blunt: this decides whether to ASK.
const MIN_TRIP_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function offsetFor(zone, at) {
  if (!zone) return null;
  try {
    return zoneOffsetMs(zone, at);
  } catch {
    return null; // an unparseable zone is not evidence of anything
  }
}

function dayKey(iso) {
  return String(iso || '').slice(0, 10);
}

// `events` is exactly what calendar.listEvents already returns — this function
// makes no network call of its own and is pure, so it can be tested against
// the real shapes without a Google account.
function detectTrip(events, userZone, now = new Date()) {
  if (!userZone || !Array.isArray(events) || !events.length) return null;
  const from = now instanceof Date ? now : new Date(now);

  const foreign = [];
  for (const e of events) {
    if (!e || !e.start) continue;
    const startsAt = new Date(e.allDay ? `${dayKey(e.start)}T12:00:00Z` : e.start);
    if (Number.isNaN(startsAt.getTime()) || startsAt <= from) continue;

    if (e.allDay) {
      // An all-day block long enough to be a stay rather than a birthday. It
      // carries no zone of its own — the evidence is its shape and its title.
      const endsAt = new Date(`${dayKey(e.end || e.start)}T12:00:00Z`);
      const days = Math.round((endsAt - startsAt) / DAY_MS);
      if (days >= MIN_TRIP_DAYS) foreign.push({ e, startsAt, zone: null, days });
      continue;
    }

    const theirs = offsetFor(e.timeZone, startsAt);
    const ours = offsetFor(userZone, startsAt);
    if (theirs === null || ours === null || theirs === ours) continue;
    foreign.push({ e, startsAt, zone: e.timeZone, days: 0 });
  }
  if (!foreign.length) return null;

  // A zone earns the question only on two separate days. All-day blocks stand
  // on their own and are grouped under a null zone, which never reaches the
  // two-day rule — that is what `days >= MIN_TRIP_DAYS` above already proved.
  const byZone = new Map();
  for (const f of foreign) {
    const key = f.zone || `stay:${f.e.id}`;
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key).push(f);
  }
  for (const [key, hits] of byZone) {
    const zone = hits[0].zone;
    if (zone && new Set(hits.map((h) => dayKey(h.e.start))).size < 2) continue;
    hits.sort((a, b) => a.startsAt - b.startsAt);
    return {
      // null when the evidence is an all-day stay: we know they are away and
      // deliberately do not know where. The agent asks the city; it never guesses.
      zone,
      key: `${key}:${dayKey(hits[0].e.start)}`,
      startsAt: hits[0].startsAt.toISOString(),
      // Titles and locations are other people's text. They travel to the agent
      // as quoted evidence and are labelled as data at the point of delivery.
      evidence: hits.slice(0, 3).map((h) => ({
        title: h.e.title, start: h.e.start, location: h.e.location || null,
      })),
    };
  }
  return null;
}

module.exports = { detectTrip, MIN_TRIP_DAYS };
