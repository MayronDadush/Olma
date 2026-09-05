'use strict';
// The dashboard picks a candidate time as {day, part | time, allDay}: a day
// offset from the person's TODAY (their zone), and either a clock time, a
// daypart, or a whole day. The server needs one instant per option — for
// "has it passed", for clashes, for sorting, for the calendar — and words the
// other participants' agents can relay. Both are built here, in the person's
// own zone, so a Tuesday picked in Tel Aviv is Tuesday in Tel Aviv.
const { ok, err } = require('./results');
const { partsInZone, instantInZone, weekdayOfParts, daysInMonth } = require('./datetime');

// Representative clock time for a daypart. Only the instant is a guess; the
// daypart itself travels in `daypart` and is what the page shows.
const PART_HOURS = Object.freeze({ morning: 9, noon: 13, evening: 19, night: 21 });
const PART_HE = Object.freeze({ morning: 'בבוקר', noon: 'בצהריים', evening: 'בערב', night: 'בלילה' });
const DAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MAX_DAYS_AHEAD = 90;

function pad(n) { return String(n).padStart(2, '0'); }

// Adds `days` to a Y/M/D triple by calendar arithmetic (no zone involved).
function addDays({ y, m, d }, days) {
  let yy = y, mm = m, dd = d + days;
  while (dd > daysInMonth(yy, mm)) { dd -= daysInMonth(yy, mm); mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
  while (dd < 1) { mm -= 1; if (mm < 1) { mm = 12; yy -= 1; } dd += daysInMonth(yy, mm); }
  return { y: yy, m: mm, d: dd };
}

// ISO-8601 with the zone's offset at that instant — the shape the tools want.
function isoWithOffset(instant, tz) {
  const p = partsInZone(tz, instant);
  const offsetMin = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss) - instant.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const a = Math.abs(offsetMin);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mi)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// { day, part, time, allDay } → { startsAt, slotText, daypart, allDay }
function momentFor(tz, pick, now = new Date()) {
  const day = Number(pick && pick.day);
  if (!Number.isInteger(day) || day < 0 || day > MAX_DAYS_AHEAD) return err('invalid', 'day must be 0..90 days from today', { reason: 'bad_day' });
  const today = partsInZone(tz || 'UTC', now);
  const date = addDays(today, day);
  const weekday = DAYS_HE[weekdayOfParts(date)];
  const dateHe = `${date.d}.${date.m}`;
  const allDay = pick.allDay === true;
  let hh, mi, daypart = null, when;
  if (allDay) {
    hh = 9; mi = 0; when = 'כל היום';
  } else if (pick.time) {
    const mt = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(pick.time).trim());
    if (!mt) return err('invalid', 'time must be HH:MM', { reason: 'bad_time' });
    hh = Number(mt[1]); mi = Number(mt[2]); when = `${pad(hh)}:${pad(mi)}`;
  } else {
    daypart = String(pick.part || 'evening');
    if (!Object.hasOwn(PART_HOURS, daypart)) return err('invalid', 'part must be morning|noon|evening|night', { reason: 'bad_part' });
    hh = PART_HOURS[daypart]; mi = 0; when = PART_HE[daypart];
  }
  const instant = instantInZone(tz || 'UTC', { y: date.y, m: date.m, d: date.d, hh, mi, ss: 0 });
  return ok({
    startsAt: isoWithOffset(instant, tz || 'UTC'),
    slotText: `יום ${weekday} ${dateHe} ${when}`,
    daypart, allDay,
  });
}

// The reverse, for the page: an instant → { day, time } in the person's zone,
// where `day` is the offset from their today.
function pickFor(tz, startsAt, now = new Date()) {
  if (!startsAt) return { day: null, time: null };
  const t = partsInZone(tz || 'UTC', new Date(startsAt));
  const today = partsInZone(tz || 'UTC', now);
  const dayNo = (p) => Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86400000);
  return { day: dayNo(t) - dayNo(today), time: `${pad(t.hh)}:${pad(t.mi)}` };
}

module.exports = { momentFor, pickFor, PART_HOURS, MAX_DAYS_AHEAD };
