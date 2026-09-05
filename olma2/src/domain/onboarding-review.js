'use strict';
// What the first hours actually looked like, checked by code.
//
// On 2026-09-05 a new user's first evening was reconstructed by hand — the
// gateway transcript, the database rows and the gateway log, cross-read
// against each other. It took an afternoon and found nine things, two of them
// user-visible faults nobody would ever have noticed: a reminder Olma
// PROMISED for 19:00 and armed for 18:00, and a message that was read and
// answered with nothing at all.
//
// Almost none of that needed judgement. "She said a time, and no reminder was
// set for it" is a comparison. "He wrote and nothing went out" is a log line.
// So the review is code, and it runs itself for every person who joins —
// three hours in, once, while their first conversation is still what the
// system is being judged on.
//
// This file is PURE: evidence in, findings out. Everything that touches a
// database, a transcript or a log lives in jobs/onboarding-review.js, which
// is what makes the checks below testable in milliseconds and, more to the
// point, arguable — a check whose failing case cannot be written down in a
// test is a check nobody will trust six weeks from now (CLAUDE.md, "The
// detection layer nobody trusts").
//
// Severity is about who must act, not about how interesting it is:
//   bad  — a person was told something untrue, or got nothing. Act today.
//   warn — the system did something nobody asked for, or missed an obvious
//          opening. Worth a look this week.
//   note — a fact for the record. Never an alert.

const SEVERITY_ORDER = ['note', 'warn', 'bad'];

function worstOf(findings) {
  let worst = null;
  for (const f of findings) {
    if (worst === null || SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(worst)) {
      worst = f.severity;
    }
  }
  return worst || 'clean';
}

// ---- helpers ----------------------------------------------------------------

// Clock times as a person writes them, in either script's punctuation:
// "ב-19:00", "at 7:30", "11:30". Bare hours ("בשבע") are deliberately out of
// scope — a check that guesses at words would be wrong in both directions.
const TIME_RE = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;

function timesIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(TIME_RE)) {
    out.add(`${String(Number(m[1])).padStart(2, '0')}:${m[2]}`);
  }
  return out;
}

// Does this sentence claim a reminder? Only these messages are held to the
// armed times — a message that merely mentions an hour ("the meeting is at
// 19:00") promises nothing.
const REMINDER_WORDS = /אזכיר|תזכורת|אזכור|להזכיר|remind/i;
// "an hour before", "earlier" — a message that says WHEN relative to the thing
// is telling the truth without naming the hour, and must not be flagged for it.
const RELATIVE_WORDS = /שעה לפני|לפני האירוע|קודם לכן|קצת לפני|before|earlier/i;

function hhmm(iso, tz, partsInZone) {
  const p = partsInZone(tz || 'UTC', new Date(iso));
  return `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

// ---- the checks -------------------------------------------------------------
//
// Each takes the assembled evidence and returns zero or more findings. Adding
// one is an entry in CHECKS plus its test; nothing else in the system needs to
// know it exists.

// The fault that started this. Olma tells people when she will remind them,
// and until 2026-09-05 the only times on the tool result were the due date and
// a UTC instant — so the sentence was assembled from whichever was nearer to
// hand, and for Yahav it was the due date. The code fix makes the right time
// available; this makes the wrong one visible if it comes back by another
// route, in a paraphrase no schema can constrain.
function promisedTimeNotArmed(e) {
  const { partsInZone } = e.helpers;
  const tz = e.user.timezone;
  const armed = new Set(
    (e.reminders || []).filter((r) => !r.cancelledAt).map((r) => hhmm(r.remindAt, tz, partsInZone))
  );
  const due = new Set(
    (e.tasks || []).filter((t) => t.dueAt).map((t) => hhmm(t.dueAt, tz, partsInZone))
  );
  const out = [];
  for (const m of e.outbound || []) {
    if (!REMINDER_WORDS.test(m.text)) continue;
    const said = timesIn(m.text);
    if (said.size === 0) continue;
    if ([...said].some((t) => armed.has(t))) continue;          // she said an armed hour
    if (RELATIVE_WORDS.test(m.text)) continue;                  // "an hour before" names no hour
    const saidDue = [...said].filter((t) => due.has(t));
    out.push({
      id: 'promised_time_not_armed',
      // Naming the DUE hour while a different one is armed is the exact
      // 2026-09-05 signature and is always a false promise. Any other
      // mismatch may be a paraphrase this check cannot read, so it asks
      // rather than asserts.
      severity: saidDue.length && armed.size ? 'bad' : 'warn',
      title: 'told them an hour no reminder is set for',
      detail: {
        at: m.at,
        said: [...said],
        armed: [...armed],
        matchedTheDueHourInstead: saidDue,
        text: String(m.text).slice(0, 300),
      },
    });
  }
  return out;
}

// The gateway read their message, ran the turn, and put nothing on the wire.
// jobs/unanswered.js repairs this within minutes now; the review records that
// it happened at all, because a repaired drop is still a drop and the rate is
// the thing worth watching.
function droppedTurns(e) {
  if (!(e.droppedTurns || []).length) return [];
  return [{
    id: 'dropped_turn',
    severity: 'bad',
    title: `${e.droppedTurns.length} message(s) of theirs produced no reply at all`,
    detail: {
      messages: e.droppedTurns.map((d) => ({ messageId: d.messageId, at: d.at })),
      repaired: e.repairs || 0,
    },
  }];
}

// Their tool calls were failing while they were typing. Distinct from a drop:
// the turn may still have produced words, and those words were written by a
// model that had just been refused by its own tools.
function toolsFailed(e) {
  if (!e.toolErrors) return [];
  return [{
    id: 'tools_failed',
    severity: e.toolErrors >= 3 ? 'bad' : 'warn',
    title: `${e.toolErrors} tool call(s) failed during their first hours`,
    detail: { count: e.toolErrors, deployedDuringWindow: e.deployedDuringWindow },
  }];
}

// A deploy restarts brokerd, and brokerd is what every tool call goes to. It
// is nobody's fault and entirely avoidable: a person's first conversation is
// the one hour of their life with this system that they will remember.
function deployedDuringOnboarding(e) {
  if (e.deployedDuringWindow !== true) return [];   // false OR null; null is "could not tell"
  return [{
    id: 'deployed_during_onboarding',
    severity: 'warn',
    title: 'a release landed while they were being onboarded',
    detail: { release: e.release || null },
  }];
}

// Their zone was guessed from a phone prefix and never confirmed with them.
// Right for Israel by construction; a guess everywhere a country has more
// than one zone, and the guess is invisible until a reminder is hours out.
function timezoneUnconfirmed(e) {
  if (e.user.timezoneConfirmed) return [];
  return [{
    id: 'timezone_unconfirmed',
    severity: 'note',
    title: `zone is still the phone-prefix guess (${e.user.timezone})`,
    detail: { timezone: e.user.timezone },
  }];
}

// Tasks nobody asked for. The extraction sweep reads the conversation and
// files what looks like a commitment — which is right often enough to keep,
// and wrong in a way the person never sees: Yahav was ASKED "shall I save
// this as a task?", the sweep had already saved it 73 minutes earlier, and
// his "לא תודה" removed nothing.
function tasksNobodyConfirmed(e) {
  const extracted = (e.tasks || []).filter((t) => t.source === 'extracted' && t.status === 'open');
  if (!extracted.length) return [];
  return [{
    id: 'tasks_nobody_confirmed',
    severity: 'note',
    title: `${extracted.length} task(s) filed by the extraction sweep, never confirmed out loud`,
    detail: { tasks: extracted.map((t) => ({ id: t.id, title: t.title })) },
  }];
}

// Three hours of talking and nothing learned about them. The card the agent
// reads every turn is built from these; an empty one means every later
// conversation starts from zero.
function nothingLearned(e) {
  if (e.facts > 0 || e.preferences > 0) return [];
  if ((e.inbound || []).length < 4) return [];   // they barely spoke; nothing to learn is honest
  return [{
    id: 'nothing_learned',
    severity: 'warn',
    title: `${(e.inbound || []).length} messages from them and not one fact or preference saved`,
    detail: { inbound: (e.inbound || []).length },
  }];
}

// The calendar offer is a rung on a clock — eight hours in, whoever they are
// and whatever they have said. When somebody hands over two or three dated
// commitments in their first evening, the opening was earlier and evidence-
// shaped: the trigger should be what they gave, not how long they have been
// here. Yahav gave three in two hours and the offer was still queued for
// 04:58 the next morning.
function calendarOpeningMissed(e) {
  if ((e.integrations || []).some((i) => /google/.test(i.provider) && i.status === 'connected')) return [];
  const dated = (e.tasks || []).filter((t) => t.dueAt).length;
  if (dated < 2 || e.calendarOffered) return [];
  return [{
    id: 'calendar_opening_missed',
    severity: 'note',
    title: `${dated} dated commitments in their first hours and the calendar was never mentioned`,
    detail: { datedTasks: dated, offered: Boolean(e.calendarOffered) },
  }];
}

// A tool mark went onto their message and words about the same fact followed
// it. One thing happening, told twice (CLAUDE.md, Doctrine).
// `\b` is an ASCII word boundary and there is none after a Hebrew letter, so
// it matched nothing at all here — the check ran clean for the wrong reason,
// which is the failure mode this file exists to catch.
const CONFIRMATION_ONLY = /^(רשמתי|נרשם|שמרתי|נשמר|בוצע|מחקתי|נמחק|עדכנתי|done|saved|noted)(?!\p{L})/iu;
function saidWhatTheMarkSaid(e) {
  const out = [];
  for (const m of e.outbound || []) {
    if (!m.markPlaced) continue;
    const first = String(m.text || '').split('\n')[0].replace(/[✅👍⏰\s]+$/u, '').trim();
    if (!CONFIRMATION_ONLY.test(first)) continue;
    out.push({
      id: 'said_what_the_mark_said',
      severity: 'note',
      title: 'a confirmation line under a tool mark that already said it',
      detail: { at: m.at, line: first.slice(0, 120) },
    });
  }
  return out;
}

const CHECKS = [
  promisedTimeNotArmed,
  droppedTurns,
  toolsFailed,
  deployedDuringOnboarding,
  nothingLearned,
  tasksNobodyConfirmed,
  calendarOpeningMissed,
  timezoneUnconfirmed,
  saidWhatTheMarkSaid,
];

// evidence.helpers carries the pure date functions rather than importing them,
// so a test can pin a zone without pinning the clock.
function review(evidence) {
  const e = { helpers: require('./datetime'), ...evidence };
  const findings = [];
  for (const check of CHECKS) {
    // One broken check must not cost the other eight. A check that threw is
    // reported as itself — silence here would be the review passing a person
    // it never actually looked at.
    try {
      findings.push(...check(e));
    } catch (err) {
      findings.push({
        id: 'check_failed', severity: 'note',
        title: `a check could not run: ${check.name}`,
        detail: { error: String((err && err.message) || err).slice(0, 200) },
      });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
  return { findings, worst: worstOf(findings) };
}

module.exports = { review, worstOf, timesIn, CHECKS, SEVERITY_ORDER };
