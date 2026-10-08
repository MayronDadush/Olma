'use strict';
// A person's day is their own, in their zone, whatever the server's clock
// says. Every "today" in this service is asked here, never with `new Date()`
// alone.
//
// And a food day ends at 04:00, not at midnight: a plate eaten at 00:41 is the
// tail of the evening they are still in, not a snack on a day that has not
// started for them. Until 2026-10-08 it was filed on the next date as a snack,
// and that day's page then opened with a meal on it before breakfast. 04:00 is
// where slotAt's breakfast already began, so the two agree on when a day turns.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function partsIn(tz, at = new Date()) {
  let f;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  } catch {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  }
  const o = Object.fromEntries(f.formatToParts(at).map(p => [p.type, p.value]));
  return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), minute: Number(o.minute) };
}

const DAY_ENDS_AT = 4;
const today = (tz, at) => { const p = partsIn(tz, at); return p.hour < DAY_ENDS_AT ? addDays(p.day, -1) : p.day; };
const hourIn = (tz, at) => partsIn(tz, at).hour;

// Date arithmetic on a plain date, in UTC so no zone can move it.
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekday = day => new Date(day + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
// The Israeli week: Sunday to Saturday.
const weekStart = day => addDays(day, -weekday(day));
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

const isDay = v => typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(new Date(v + 'T12:00:00Z').getTime());

// The slot a meal eaten now most likely is. Evening after dinner is a snack;
// a late plate with no dinner yet IS dinner, past midnight too.
function slotAt(hour, { hasDinner = false } = {}) {
  if (hour >= DAY_ENDS_AT && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 18) return 'snack';
  return hasDinner ? 'snack' : 'dinner';
}

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const heDate = day => `יום ${HE_DAYS[weekday(day)]}, ${Number(day.slice(8))} ב${HE_MONTHS[Number(day.slice(5, 7)) - 1]}`;

module.exports = { DAY_ENDS_AT, today, hourIn, partsIn, addDays, weekday, weekStart, daysBetween, isDay, slotAt, heDate, HE_DAYS };
