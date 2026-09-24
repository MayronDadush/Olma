'use strict';
// "תעזור לי עד שבוע הבא" — the DEADLINE half of a chase, decided by code.
//
// חיים, 2026-09-22: "…אני רוצה שעד שבוע הבא היא תהיה מוכנה תעזור לי בתזכורת".
// The chase itself existed from that day (reminders.startChase), but whether it
// was armed was left to the model, and the model read the sentence two ways.
// On the eval's first real nights it chased once (run 79) and then, six times
// out of six, dated "take it in" for tomorrow and armed one reminder (runs 81-82).
// The owner's answer (2026-09-24): this goes through code.
//
// So the gateway hook (gateway-hooks/olma-turn-open) reads the message, and
// only a VERDICT leaves the gateway — which deadline was said, never the words:
//
//   { kind: 'days', n }            מחר / מחרתיים
//   { kind: 'weekday', weekday }   עד (יום) ראשון … שבת, 0 = Sunday
//   { kind: 'next_week' }          עד שבוע הבא
//   { kind: 'end_of_week' }        עד סוף השבוע
//   { kind: 'end_of_month' }       עד סוף החודש
//   { kind: 'next_month' }         עד חודש הבא
//   { kind: 'date', day, month? }  עד ה-15 / עד 15.10
//
// plus `namedHour`, whether the message carried a clock time of its own. This
// module is the other half: it validates what arrived over the socket and
// turns it into a DAY in the person's own zone. It never sees text.
//
// Measured before it was written, on every real inbound message on the box
// (861, live and archived, eval and test users excluded, 2026-09-24): 112 ask
// for a reminder or for help, 10 contain "עד", and exactly ONE does both —
// חיים's. The other nine are hour ranges, trips and work shifts, and none of
// them asks for anything; they are in tests/chase-deadline.test.js, reworded,
// as the readings this must never make.
const dt = require('./datetime');

const KINDS = new Set(['days', 'weekday', 'next_week', 'end_of_week', 'end_of_month', 'next_month', 'date']);

// A far horizon is what a misread looks like ("עד 2030" is not a chase), and a
// chase a year long is a drum nobody asked for.
const MAX_DAYS_AHEAD = 120;

function clean(v) {
  if (!v || typeof v !== 'object' || !KINDS.has(v.kind)) return null;
  const int = (x, lo, hi) => (Number.isInteger(x) && x >= lo && x <= hi ? x : null);
  const out = { kind: v.kind, namedHour: v.namedHour === true };
  if (v.kind === 'days') { out.n = int(v.n, 1, 7); if (out.n === null) return null; }
  if (v.kind === 'weekday') { out.weekday = int(v.weekday, 0, 6); if (out.weekday === null) return null; }
  if (v.kind === 'date') {
    out.day = int(v.day, 1, 31); if (out.day === null) return null;
    if (v.month !== undefined && v.month !== null) { out.month = int(v.month, 1, 12); if (out.month === null) return null; }
  }
  return out;
}

// The day a week starts on, where they are. Israel's week starts on Sunday and
// "שבוע הבא" said on a Wednesday means the Sunday coming; elsewhere a week
// starts on Monday. Only the zone is known here, and the zone is enough.
function weekStartsOn(timezone) {
  return timezone === 'Asia/Jerusalem' || timezone === 'Asia/Tel_Aviv' ? 0 : 1;
}

// Local midnight of the deadline DAY, as an instant — the same shape a
// day-shaped due_at already has ("עד שבוע הבא" is stored that way), so the
// chase ends with that day (reminders.chaseUntil) and the task is due on it.
// Null when the verdict is unusable or lands today, in the past, or too far.
function resolve(verdict, { now = new Date(), timezone = 'UTC' } = {}) {
  const v = clean(verdict);
  if (!v) return null;
  const tz = timezone || 'UTC';
  const today = dt.partsInZone(tz, new Date(now));
  const wd = dt.weekdayOfParts(today);
  const day = (y, m, d) => dt.instantInZone(tz, { y, m, d, hh: 0, mi: 0, ss: 0 });
  const ahead = (n) => day(today.y, today.m, today.d + n);
  const start = weekStartsOn(tz);
  const toNextWeek = ((start - wd + 7) % 7) || 7;
  let at = null;
  switch (v.kind) {
    case 'days': at = ahead(v.n); break;
    case 'weekday': at = ahead(((v.weekday - wd + 7) % 7) || 7); break;
    case 'next_week': at = ahead(toNextWeek); break;
    case 'end_of_week': at = ahead(toNextWeek - 1); break;
    case 'end_of_month': at = day(today.y, today.m, dt.daysInMonth(today.y, today.m)); break;
    case 'next_month': at = today.m === 12 ? day(today.y + 1, 1, 1) : day(today.y, today.m + 1, 1); break;
    case 'date': {
      if (v.month) {
        const late = v.month < today.m || (v.month === today.m && v.day <= today.d);
        const y = late ? today.y + 1 : today.y;
        if (v.day > dt.daysInMonth(y, v.month)) return null;
        at = day(y, v.month, v.day);
      } else {
        let y = today.y; let m = today.m;
        if (v.day <= today.d) { m += 1; if (m > 12) { m = 1; y += 1; } }
        if (v.day > dt.daysInMonth(y, m)) return null;
        at = day(y, m, v.day);
      }
      break;
    }
    default: return null;
  }
  if (!at || Number.isNaN(at.getTime())) return null;
  const todayStart = day(today.y, today.m, today.d);
  if (at.getTime() <= todayStart.getTime()) return null;
  if (at.getTime() - todayStart.getTime() > MAX_DAYS_AHEAD * 86400_000) return null;
  return at;
}

// What brokerd keeps on the pending open, resolved ONCE at the moment the
// message arrived (a turn that runs past midnight must not move the deadline):
// the local day for the hint, the instant for the task, and whether they named
// an hour. Null when there is nothing to chase to.
function forTurn(verdict, { now = new Date(), timezone = 'UTC' } = {}) {
  const v = clean(verdict);
  const at = v && resolve(v, { now, timezone });
  if (!at) return null;
  const p = dt.partsInZone(timezone || 'UTC', at);
  const pad = (n) => String(n).padStart(2, '0');
  return { day: `${p.y}-${pad(p.m)}-${pad(p.d)}`, dueAt: at.toISOString(), namedHour: v.namedHour, at: new Date(now).getTime() };
}

// How long a verdict stays armable on the connection that adopted it. The shim
// keeps ONE turn object for hours (rules/doctrine.md, "The shim's connection
// outlives the turn"), so a chase the model never used must not wait there for
// the next add_task somebody makes about something else.
const TURN_CHASE_TTL_MS = 15 * 60_000;

// The chase this tool call should arm, or null: present, not yet spent, and
// still from this message.
function pending(turn, now = Date.now()) {
  const c = turn && turn.chase;
  if (!c || turn.chaseUsed) return null;
  if (!Number.isFinite(c.at) || now - c.at > TURN_CHASE_TTL_MS) return null;
  return c;
}

// Whether an instant falls on the deadline's own local day — the one case the
// model's due_at is kept, because it may carry an hour the day alone does not.
function onDay(value, day, timezone) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const p = dt.partsInZone(timezone || 'UTC', d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` === day;
}

module.exports = { clean, resolve, forTurn, pending, onDay, weekStartsOn, KINDS, MAX_DAYS_AHEAD, TURN_CHASE_TTL_MS };
