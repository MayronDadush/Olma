'use strict';
// The three things a room hears about its own coordination without being asked.
//
// The owner named five moments (2026-09-07): when she starts coordinating,
// when she has a base, mid-way when she wants to speed it up, when it
// succeeds, and reminders on the day. The first is said in her own turn — she
// was tagged, the model answers — and the day-of reminders are a separate
// thing with a clock of their own. What is left is these three, and they are
// proactive: nobody asked, so each is said ONCE per coordination and each is
// held to the group's own hours by the caller.
//
// The decision is pure and the sending is not, for the usual reason: every
// judgement here ("is there a base yet", "has this gone quiet") has to be
// testable without a room, a gateway or a clock that happens to be daytime.
//
// One line per pass, never two. A room that gets "there is a direction" and
// "who has not answered" in the same breath has been given a paragraph to
// read about a thing it asked for in four words.
const { MAX_TAGS } = require('./proactive-text');

// How long she waits before saying anything about people who have not
// answered, when the coordination has no dated option to measure against.
// Deliberately long: silence in the first hours is not silence, it is people
// being at work.
const CHASE_FALLBACK_MS = 6 * 3600_000;
// And the bounds when there IS a dated option. Half the distance to the thing
// itself, so a game tomorrow evening is chased in hours and a dinner next
// month is not chased today — never sooner than an hour after she started
// (people are still answering) and never later than a day.
const CHASE_MIN_MS = 3600_000;
const CHASE_MAX_MS = 24 * 3600_000;
// The two reminders about a coordination that is already set. "An hour
// before" is exactly that; the day-of line is skipped when the thing is
// already close, because two messages three hours apart about the same
// evening is the room being nagged about a plan it made itself.
const HOUR_BEFORE_MS = 3600_000;
const DAY_OF_MIN_LEAD_MS = 3 * 3600_000;

// The calendar day a moment falls on, in a given zone. Comparing timestamps
// would call 23:00 and 01:00 the same night, which is right for people and
// wrong for "today".
function localDay(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(0, 10); }
}

function chaseDueAt(startedAtMs, earliestStartMs) {
  if (!earliestStartMs || earliestStartMs <= startedAtMs) return startedAtMs + CHASE_FALLBACK_MS;
  const half = (earliestStartMs - startedAtMs) / 2;
  return startedAtMs + Math.min(CHASE_MAX_MS, Math.max(CHASE_MIN_MS, half));
}

// A person the room may name. On 2026-09-22 coordination 38 chased three
// people by tag one minute before the second of them was asked and nine hours
// after the third was dropped as quiet: "עוד לא שמעתי מ@X" about somebody
// nobody had written to. `asked` comes off `group-meetings.statusOf`; a caller
// that does not carry it (a fixture, an older payload) is taken at its word,
// because the failure of being over-careful here is a line that is not said.
const said = (p) => p && p.asked !== false;

// The option the room is closest to agreeing on: most yeses, and the earliest
// of those when two are level. Null when nothing has a yes on it yet — the
// adder's own yes counts, so that is a table nobody has answered at all.
function leadingOption(options) {
  const withYes = (options || []).filter((o) => (o.yes || []).length > 0);
  if (!withYes.length) return null;
  return withYes.slice().sort((a, b) => (b.yes.length - a.yes.length)
    || (new Date(a.startsAt || 0) - new Date(b.startsAt || 0)))[0];
}

// `co` is domain/group-meetings.coordinationStatus's `coordination`, plus the
// three stamps off the meeting row. Returns the one line to say, or none.
//
// Priority is done > base > chase, and it is not a tie-break: a coordination
// that just confirmed makes "who has not answered" a wrong question, and
// saying the base of a plan that is already settled is worse than saying
// nothing.
function decideGroupLine(co, {
  saidBase, saidChase, saidDone, saidCalendar, saidDayOf, saidHour, startedAtMs, nowMs, timezone,
} = {}) {
  if (!co) return { kind: 'none', reason: 'nothing being coordinated' };
  if (co.status === 'confirmed') {
    // `placeAsk`: nobody has said where, so the done line asks — only then
    // (owner, 2026-09-20: "פוקר אצל יוסי" already says it).
    if (!saidDone) return { kind: 'done', slot: co.confirmedSlot, who: whoIsIn(co), placeAsk: !co.location };
    // Once, after the done line, and only when a SHARED calendar event exists
    // for this coordination — `calendar_event_id` is written by nothing but
    // calendar.createSharedMeetingEvent. "הוספתי ליומן של כולם" would have
    // been a lie in coordination 35, where one person had a calendar
    // (owner, 2026-09-20). The line still says who got an invitation:
    // whoever connected one, not everybody.
    if (!saidCalendar && co.calendarEventId) return { kind: 'calendar' };
    // Then the two reminders, and the NEARER one wins when both are due in
    // the same pass: "in an hour" is true and "today" is merely also true.
    const at = co.confirmedStartAt ? new Date(co.confirmedStartAt).getTime() : 0;
    if (!at || nowMs >= at) return { kind: 'none', reason: 'nothing left to remind about' };
    if (!saidHour && nowMs >= at - HOUR_BEFORE_MS) return { kind: 'soon', slot: co.confirmedSlot };
    if (!saidDayOf && localDay(nowMs, timezone) === localDay(at, timezone)
      && at - nowMs > DAY_OF_MIN_LEAD_MS) {
      return { kind: 'dayof', slot: co.confirmedSlot };
    }
    return { kind: 'none', reason: 'already reminded, or not yet due' };
  }
  if (co.status !== 'negotiating') return { kind: 'none', reason: `coordination is ${co.status}` };

  const lead = leadingOption(co.options);
  if (!saidBase && lead) {
    // What "a base" is depends on what the room said it needs. A game has a
    // number and it is that number; anywhere else two people who can both make
    // the same time IS the direction, and one person agreeing with themselves
    // is not.
    const enough = lead.quorum && lead.quorum.known && lead.quorum.min !== null
      ? lead.quorum.met
      : lead.yes.length >= 2;
    const missing = [...lead.missing, ...lead.no].filter(said).map((p) => p.phone).filter(Boolean);
    // "מחכה ל 🤞" went out to nobody: Yuval's yes made it unanimous, the
    // settle minute was running, and twelve seconds later the base line
    // named an empty list (coordination 37, 2026-09-20). A base is a thing
    // to say while somebody is still owed; with nobody missing, or the
    // grace already armed, the next thing this room hears is "סגור".
    if (enough && missing.length && !co.settleDueAt) {
      return { kind: 'base', slot: lead.slot, yes: lead.yes.length, missing: missing.slice(0, MAX_TAGS) };
    }
  }

  // Mid-way, to speed it up: only ever about people who have answered NOTHING.
  // Somebody who said no to every option has answered — chasing them would be
  // asking them to change their mind in front of the room.
  const silent = (co.silent || []).filter(said).map((p) => p.phone).filter(Boolean);
  if (!saidChase && silent.length && nowMs >= chaseDueAt(startedAtMs, earliestStart(co))) {
    return { kind: 'chase', missing: silent.slice(0, MAX_TAGS) };
  }
  return { kind: 'none', reason: 'nothing new to say' };
}

// Who can make the time the coordination closed on: everybody still in, or
// the tags of those who said yes (owner, 2026-09-20). `all` is the whole
// sentence's difference — "כולם" is said, a list is tagged — and null means
// the confirmed option could not be found, which draws nothing rather than a
// guess.
function whoIsIn(co) {
  const o = co.confirmedOption;
  if (!o || !Array.isArray(o.yes)) return null;
  const phones = o.yes.map((p) => p.phone).filter(Boolean);
  const all = Number(co.participants) > 0 && o.yes.length >= Number(co.participants);
  return { all, phones: all ? [] : phones };
}

function earliestStart(co) {
  const times = (co.options || []).map((o) => (o.startsAt ? new Date(o.startsAt).getTime() : 0))
    .filter((t) => t > 0);
  return times.length ? Math.min(...times) : 0;
}

module.exports = {
  decideGroupLine, leadingOption, chaseDueAt, localDay, whoIsIn,
  CHASE_FALLBACK_MS, CHASE_MIN_MS, CHASE_MAX_MS, HOUR_BEFORE_MS, DAY_OF_MIN_LEAD_MS,
};
