'use strict';
// The calendar half of the personal dashboard. Deliberately its own module and
// its own route, for one reason: this is the only thing the page shows that
// does not live in our database. Every event here is fetched from Google on
// the request, so folding it into /me/data would have put a third-party
// network call in front of the whole page — a Google outage would then look
// like a dashboard outage, and the list, the friends and the settings would
// all wait behind a calendar nobody asked to see yet.
//
// So the page loads, and the days fill in after.
//
// What comes back is other people's writing. Titles and locations are text
// somebody else typed, and it is rendered — never obeyed, never fed anywhere
// that treats text as an instruction. The projection calendar.listEvents
// already makes (no attendees, no email addresses, no organiser) is kept
// exactly as it is; this adds nothing back.
const { ok, err } = require('./results');
const calendar = require('./calendar');
const { partsInZone } = require('./datetime');

// Four weeks. The page's own day grid pages a fortnight at a time and its
// week strip looks a week ahead, so this covers what can be reached without
// asking again — and Google is asked once rather than per screen.
const DAYS_AHEAD = 28;

const iso = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const hhmm = (p) => `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;

// Whole days between two calendar DATES, counted as dates rather than as
// elapsed hours. A DST night is 23 hours long and would otherwise round to
// zero days, putting tomorrow's events on today.
function dayGap(fromIso, toIso) {
  const [ay, am, ad] = fromIso.split('-').map(Number);
  const [by, bm, bd] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// An all-day event carries a DATE, not an instant. Reading it as an instant
// puts it at midnight UTC, which in a zone behind UTC is the day before — the
// classic off-by-one that makes a birthday land on the wrong day.
function bucketOf(ev, zone, todayIso) {
  if (ev.allDay) {
    const date = String(ev.start || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { day: dayGap(todayIso, date), at: '', end: '' } : null;
  }
  const startAt = new Date(ev.start);
  if (Number.isNaN(startAt.getTime())) return null;
  const p = partsInZone(zone, startAt);
  const endAt = ev.end ? new Date(ev.end) : null;
  return {
    day: dayGap(todayIso, iso(p)),
    at: hhmm(p),
    end: endAt && !Number.isNaN(endAt.getTime()) ? hhmm(partsInZone(zone, endAt)) : '',
  };
}

// `connected: false` is a different answer from an empty calendar, and the two
// must never collapse: one means "there is nothing to show you", the other
// means "we cannot see it". The page says something different for each.
async function loadEvents(client, userId, opts = {}) {
  const { rows } = await client.query(
    `SELECT timezone FROM users WHERE id = $1 AND status != 'blocked' AND is_eval = false`,
    [userId]
  );
  if (!rows[0]) return err('not_found', 'no such user');
  const zone = rows[0].timezone || 'UTC';

  const list = opts.listEvents || calendar.listEvents;
  const res = await list(client, userId, opts.days || DAYS_AHEAD, opts);
  if (!res.ok) {
    // Not connected, revoked, or Google unreachable — all of them mean the
    // same thing to the page and none of them is an error worth breaking it
    // over. The reason travels so the page can offer connecting when that is
    // actually the problem.
    return ok({ connected: false, reason: res.error.reason || res.error.code, days: {} });
  }

  const todayIso = iso(partsInZone(zone, new Date()));
  const days = {};
  for (const ev of res.data.events || []) {
    const b = bucketOf(ev, zone, todayIso);
    // Behind us by more than the strip can reach, or unparseable: dropped
    // rather than bucketed into day 0, where it would read as happening today.
    if (!b || b.day < 0 || b.day > DAYS_AHEAD) continue;
    (days[b.day] = days[b.day] || []).push({
      id: ev.id,
      title: ev.title,
      at: b.at,
      end: b.end,
      allDay: Boolean(ev.allDay),
      where: ev.location || null,
    });
  }
  for (const k of Object.keys(days)) {
    days[k].sort((a, b) => (a.allDay ? '' : a.at || '99:99').localeCompare(b.allDay ? '' : b.at || '99:99'));
  }
  return ok({ connected: true, zone, days });
}

module.exports = { loadEvents, bucketOf, dayGap, DAYS_AHEAD };
