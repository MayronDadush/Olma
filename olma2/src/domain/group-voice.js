'use strict';
// The three things a room hears about its own coordination without being asked.
//
// The owner named five moments (2026-09-07): when she starts coordinating,
// when she has a base, mid-way when she wants to speed it up, when it
// succeeds, and reminders on the day. The first is said in her own turn — she
// was tagged, the model answers — and the day-of reminders are a separate
// thing with a clock of their own. What is left is these three, and they are
// proactive: nobody asked, so each is held to the group's own hours by the
// caller, and each is said ONCE per coordination — with one exception, added
// 2026-09-22. The TABLE moving is the only thing here that can happen again
// and again and be news every time, so that line is watermarked rather than
// flagged; everything else stays a stamp that is set once and read as a
// boolean.
//
// The decision is pure and the sending is not, for the usual reason: every
// judgement here ("is there a base yet", "has this gone quiet") has to be
// testable without a room, a gateway or a clock that happens to be daytime.
//
// One line per pass, never two. A room that gets "there is a direction" and
// "who has not answered" in the same breath has been given a paragraph to
// read about a thing it asked for in four words.
const { MAX_TAGS } = require('./proactive-text');
const { onlinePlace } = require('./online-place');
const meetingTime = require('./meeting-time');

// How long she waits before saying anything about people who have not
// answered, when the coordination has no dated option to measure against.
// Deliberately long: silence in the first hours is not silence, it is people
// being at work.
const CHASE_FALLBACK_MS = 6 * 3600_000;
// And when there IS a dated option: an hour after she started, or half the
// distance to the thing itself when the thing is sooner than two hours away.
//
// It used to be half the distance FULL STOP, clamped to [1h, 24h], and that
// reads well and was wrong in the only direction that costs anything. מירון's
// padel game had its earliest option twenty-six hours out, so half was
// thirteen: the room was told she had started at 16:11, told there was a
// direction at 16:15, and then — through שבת 16:00 coming off the table, three
// times going on and two people turning Wednesday down — heard nothing at all,
// with the chase scheduled for 05:11 the next morning and the night in front
// of it (owner, 2026-09-22: they should have had an update by then). An hour
// is long enough that silence is still people being at work, and the `min`
// keeps the old instinct for the case it was actually written for: a game in
// ninety minutes is chased in forty-five, not in sixty.
const CHASE_AFTER_MS = 3600_000;
// How long the room waits after the table starts moving before it says so
// (owner, 2026-09-22: "החדר צריך לחכות לפחות רבע שעה עד שהוא מכריז על שינוי,
// בשביל שאם אנשים עושים שינויים נוספים בזמן הזה הקבוצה לא תקבל חפירה על כל
// דבר בנפרד"). The same quarter of an hour as the private side's
// `meeting-fanout.PACE_MS`, for the same reason and off the same afternoon:
// מירון's table moved at 16:14, 16:22, 16:23 and 16:25, and `group_voice`
// runs every sixty seconds, so an ungated line would have been four messages
// in the room in eleven minutes — the private complaint, said out loud.
//
// The clock starts at the FIRST change the room has not heard about, never at
// the newest one. Waiting for the table to go QUIET reads better and starves:
// a room that keeps adding times would never be told anything at all. Opening
// the window at the first change means everything that lands inside it is one
// sentence and the sentence always comes, a quarter of an hour in.
//
// Nothing else here waits. "She has started" is the line whose whole value is
// being early, and a base, a chase and a "סגור" are each said once in a
// coordination — only the two lines about the table MOVING can arrive in a
// burst, and they are the two this gates.
const TABLE_SETTLE_MS = 15 * 60_000;

// The moment the room may speak about a table that has moved since it was last
// told, or null when it has not moved at all. `co.tableChangedAts` is every
// moment any option was added or taken off (`group-meetings.statusOf`).
function tableSettledAt(co, tableSaidAtMs) {
  const unheard = (co.tableChangedAts || [])
    .map((t) => new Date(t).getTime())
    .filter((t) => t > tableSaidAtMs);
  return unheard.length ? Math.min(...unheard) + TABLE_SETTLE_MS : null;
}

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
  return startedAtMs + Math.min(CHASE_AFTER_MS, half);
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
// Priority is done > base > chase > table, and it is not a tie-break: a coordination
// that just confirmed makes "who has not answered" a wrong question, and
// saying the base of a plan that is already settled is worse than saying
// nothing.
function decideGroupLine(co, opts = {}) {
  return withClocks(decideLine(co, opts), co, opts);
}

// A room on more than one clock hears every time in each of them (owner,
// 2026-09-25, פנתרה). What the time IS rides the line — `at[field]` for each
// slot text it names, `zones` and `roomTz` — and the RENDERER draws the words
// at delivery, like every other room line. Only when the people this
// coordination is asking actually span zones at this moment: anywhere else the
// line is exactly what it was, field for field.
const SLOT_FIELDS = ['slot', 'was', 'added', 'lead'];
function withClocks(line, co, { timezone, nowMs } = {}) {
  if (!line || line.kind === 'none' || line.kind === 'calendar' || line.kind === 'chase') return line;
  const zones = (co && co.zones) || [];
  const roomTz = (co && co.roomTz) || timezone || null;
  if (!meetingTime.spansZones(zones, roomTz, new Date(nowMs || Date.now()))) return line;
  const at = {};
  for (const f of SLOT_FIELDS) {
    if (line[f] && co.moments && co.moments[line[f]]) at[f] = co.moments[line[f]];
  }
  return { ...line, multiZone: true, zones, roomTz, at };
}

function decideLine(co, {
  saidStarted, saidBase, saidBaseSlot, saidChase, saidDone, saidCalendar, saidDayOf, saidHour, saidTime,
  pendingRelay, startedAtMs, nowMs, timezone, tableSaidAtMs,
} = {}) {
  if (!co) return { kind: 'none', reason: 'nothing being coordinated' };
  if (co.status === 'confirmed') {
    // `placeAsk`: nobody has said where, so the done line asks — only then
    // (owner, 2026-09-20: "פוקר אצל יוסי" already says it). A name or a time
    // that says it happens ON Zoom has said where too (2026-09-23, "פוקר
    // בזום"): new coordinations carry it as their location from the start, and
    // this covers the ones opened before that, and a time like "שישי בזום".
    const saidOnline = onlinePlace(co.title) || onlinePlace(co.confirmedSlot);
    if (!saidDone) {
      // `timeAsk`: it settled on a whole day or a part of one, so the same
      // line asks ONCE whether they want an exact hour (owner, 2026-09-24).
      // Once because this line is stamped once; an answer goes through
      // add_group_coordination_option, which sets it on a settled meeting.
      return {
        kind: 'done', slot: co.confirmedSlot, who: whoIsIn(co), placeAsk: !co.location && !saidOnline,
        timeAsk: Boolean(co.confirmedAllDay || co.confirmedDaypart),
      };
    }
    // Somebody gave it its exact hour in a private chat. Said once; set in
    // the room, it is stamped as heard at once (meeting-fanout.afterTimeSet).
    if (co.timeSetAt && !saidTime) return { kind: 'time', slot: co.confirmedSlot };
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
    // A whole day is still "today" after its stand-in 09:00 (087); anything
    // else is over at its start.
    const sameDay = at && localDay(nowMs, timezone) === localDay(at, timezone);
    if (!at || (nowMs >= at && !(co.confirmedAllDay && sameDay))) {
      return { kind: 'none', reason: 'nothing left to remind about' };
    }
    // A whole day or a part of one sits on a stand-in hour, so "in an hour"
    // off it would be a time nobody named — 08:00 for an all-day meeting —
    // and the three-hour lead the day-of line wants of an exact time would
    // leave a morning one with no line at all. Those get the day-of line,
    // any time that day before it is over.
    const exact = !co.confirmedAllDay && !co.confirmedDaypart;
    if (exact && !saidHour && nowMs >= at - HOUR_BEFORE_MS) return { kind: 'soon', slot: co.confirmedSlot };
    if (!saidDayOf && sameDay && (!exact || at - nowMs > DAY_OF_MIN_LEAD_MS)) {
      return { kind: 'dayof', slot: co.confirmedSlot };
    }
    return { kind: 'none', reason: 'already reminded, or not yet due' };
  }
  if (co.status !== 'negotiating') return { kind: 'none', reason: `coordination is ${co.status}` };

  // First, once: she has started asking (owner, 2026-09-22). It comes before
  // everything else in this branch because it is the only line that is true the
  // moment the coordination exists — `base` waits for two people to agree on a
  // time, which in the rooms measured so far took hours, and until then the room
  // that asked her for something heard nothing at all.
  if (!saidStarted) {
    return { kind: 'started', title: co.title, asked: co.participants, outside: co.outside || 0 };
  }

  // Then anything a MEMBER asked her to say here (owner, 2026-09-22). It comes
  // before her own three lines because it is the only one somebody actually
  // requested, and it is bounded where it is written — one per person per
  // coordination, `group-meetings.relayToRoom` — not here: this function can see
  // that there is one to say and could never judge whether it was worth saying.
  if (pendingRelay && pendingRelay.phone && pendingRelay.what) {
    // `added`/`was` ride along when that same person changed the table — the
    // reason and the change are one piece of news, and שרון's room got neither.
    return {
      kind: 'relay', userId: pendingRelay.userId,
      from: pendingRelay.phone, what: pendingRelay.what,
      added: pendingRelay.added || null, was: pendingRelay.was || null,
    };
  }

  const lead = leadingOption(co.options);
  // The room was told a time, and that time is no longer on the table (owner,
  // 2026-09-22: "יש אנשים שסימנו אותו ועכשיו הוא לא רלוונטי"). `group_base_at`
  // alone could not see this — it says the line was SAID and not which time it
  // said — so Padel Gang went on holding שבת 16:00 for as long as the
  // coordination ran, eleven minutes after Sharon deleted it and replaced it
  // with 17:00. `saidBaseSlot` is that slot text, and this is deliberately the
  // narrowest trigger that answers the owner's reason: a leading time merely
  // OVERTAKEN by another leaves the room's picture true, and only a time that
  // stopped existing makes it false. It is also what bounds the line — one per
  // named slot that disappeared, not one per change of lead — and why nothing
  // is said until there is a new direction to say: the stamp keeps naming the
  // gone slot, so the line simply waits for `enough` and goes out then.
  //
  // It waits out the settle like the table line below, and for the owner's own
  // reason: the removal that makes this true is itself a movement of the table,
  // and a time deleted and replaced thirty seconds later is ONE thing that
  // happened. Said immediately, the room would read "שבת 16:00 כבר לא על
  // השולחן" and then, a minute later, that the table had moved again.
  const settledAt = tableSettledAt(co, tableSaidAtMs || 0);
  const settled = settledAt !== null && nowMs >= settledAt;
  const namedGone = Boolean(saidBase && saidBaseSlot && lead && saidBaseSlot !== lead.slot
    && !(co.options || []).some((o) => o.slot === saidBaseSlot) && settled);
  if ((!saidBase || namedGone) && lead) {
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
      const line = { slot: lead.slot, yes: lead.yes.length, missing: missing.slice(0, MAX_TAGS) };
      return namedGone ? { kind: 'moved', was: saidBaseSlot, ...line } : { kind: 'base', ...line };
    }
  }

  // Mid-way, to speed it up: only ever about people who have answered NOTHING.
  // Somebody who said no to every option has answered — chasing them would be
  // asking them to change their mind in front of the room.
  const silent = (co.silent || []).filter(said).map((p) => p.phone).filter(Boolean);
  if (!saidChase && silent.length && nowMs >= chaseDueAt(startedAtMs, earliestStart(co))) {
    return { kind: 'chase', missing: silent.slice(0, MAX_TAGS) };
  }

  // …and the table itself moving is news, however many times it moves. Every
  // other line here is said ONCE, which is right for each of them — she has
  // started, there is a direction, who has not answered — and left מירון's room
  // with nothing to read for the hour in which שבת 16:00 came off, three times
  // went on, and the coordination it had asked for changed shape completely
  // (owner, 2026-09-22).
  //
  // `tableSaidAtMs` is a WATERMARK and not a boolean, because this is the one
  // line that repeats: it is the moment the room was last told what is on the
  // table, which the caller resolves as the newer of `group_table_at` and the
  // base line — so the very option the base line was about never reads as a
  // change, and a table that stops moving goes quiet on its own. Nobody's
  // ANSWER is in it, only the shape: how many times are on the table and which
  // one is furthest along (`rules/groups.md` — whether Dana said no is Dana's
  // to say).
  //
  // It needs a table to have been SAID first, which is why the watermark is
  // the base line and never the started line: the first time somebody puts a
  // time up, one person agreeing with themselves, the table has not moved —
  // it has been laid, and the base line is what speaks when that becomes a
  // direction (`tests/group-voice.test.js` asserted exactly this and caught
  // the first cut of this branch saying "השולחן זז — עכשיו מועד אחד").
  const onTable = (co.options || []).length;
  if (onTable && tableSaidAtMs && settled) {
    return { kind: 'table', count: onTable, lead: lead ? lead.slot : null };
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
  tableSettledAt,
  CHASE_FALLBACK_MS, CHASE_AFTER_MS, HOUR_BEFORE_MS, DAY_OF_MIN_LEAD_MS, TABLE_SETTLE_MS,
};
