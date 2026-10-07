'use strict';
// A person's day is their own: a meal at 00:30 in Jerusalem belongs to that
// date there, whatever the server's clock says. Every "today" in this service
// is asked here, with the person's zone, never with `new Date()` alone.

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

const today = (tz, at) => partsIn(tz, at).day;
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

// The slot a meal eaten now most likely is. Evening after dinner is a snack.
function slotAt(hour, { hasDinner = false } = {}) {
  if (hour >= 4 && hour < 11) return 'breakfast';
  if (hour >= 11 && hour < 16) return 'lunch';
  if (hour >= 16 && hour < 18) return 'snack';
  if (hour >= 18 && hour < 23) return hasDinner ? 'snack' : 'dinner';
  return 'snack';
}

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const heDate = day => `יום ${HE_DAYS[weekday(day)]}, ${Number(day.slice(8))} ב${HE_MONTHS[Number(day.slice(5, 7)) - 1]}`;

module.exports = { today, hourIn, partsIn, addDays, weekday, weekStart, daysBetween, isDay, slotAt, heDate, HE_DAYS };
