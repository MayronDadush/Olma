'use strict';
// The respectful delivery gate — ONE decision function every proactive
// message passes through. Pure: takes facts, returns an action. The worker
// gathers the facts; this file never touches the DB, which is what makes the
// whole policy unit-testable in milliseconds.
//
// Policy (each rule traces to an explicit design decision):
//   paused user      → drop. They asked Olma to stop initiating; there is no
//                      kind and no urgency that earns an exception, including
//                      another user's fan-out landing on them
//   blocked user     → hold, except paid-plan reminders and the unblock summary
//   outside personal availability window → hold until window opens, UNLESS
//                      they wrote to us in the last 15 minutes (see below)
//                      (reminders + digest bypass: the user chose those times)
//   over daily proactive budget → normal severity folds into next digest,
//                      urgent bypasses (user-requested reminders, live meetings)
//   past expires_at  → never delivered as live; folded as "עבר זמנה"

// ---- timezone helpers -------------------------------------------------------

function minutesInTz(tz, date = new Date()) {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes(); // bad tz → UTC, never crash
  }
}

function parseHHMM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function withinWindow(window, tz, date = new Date()) {
  const now = minutesInTz(tz, date);
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  if (start <= end) return now >= start && now < end;
  return now >= start || now < end; // overnight window ("22:00-06:00")
}

// Milliseconds until the window next opens (approximate across DST — a
// minute of drift is fine for "wait until morning").
function msUntilWindowOpen(window, tz, date = new Date()) {
  if (withinWindow(window, tz, date)) return 0;
  const now = minutesInTz(tz, date);
  const start = parseHHMM(window.start);
  const deltaMin = ((start - now) % 1440 + 1440) % 1440;
  return deltaMin * 60_000;
}

// Which day of the week it is where THEY are — 0 = Sunday, matching
// preferences.DAY_NAMES. Same fail-open shape as minutesInTz: a broken zone
// falls back to UTC rather than throwing inside the gate.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function weekdayInTz(tz, date = new Date()) {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', weekday: 'short',
    }).format(date);
    const d = WEEKDAYS[s];
    return d === undefined ? date.getUTCDay() : d;
  } catch {
    return date.getUTCDay();
  }
}

// The local calendar date where THEY are. Same fail-open shape as the two
// above, and the same reason the weekday is asked in their zone rather than
// the server's: 23:00 UTC on the 20th is already the 21st in Jerusalem, and
// Yom Kippur is a DATE, not an instant.
function localDateInTz(tz, date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// Is this a day they keep? A weekday they named, or — only for somebody who
// asked for it — a date the calendar says is a yom tov. One predicate for both
// so the hold and the RELEASE can never disagree about which days exist:
// Rosh Hashana runs into Shabbat often enough that a release computed from
// weekdays alone would wake a row in the middle of a three-day run.
function quietDayReason(facts, tz, date) {
  const days = facts.quietDays || [];
  if (days.includes(weekdayInTz(tz, date))) return 'quiet_day';
  const dates = facts.quietDates || [];
  if (dates.length && dates.includes(localDateInTz(tz, date))) return 'quiet_holiday';
  return null;
}

// Milliseconds until the first moment past a run of quiet days that is also
// inside their window. Approximate across DST for the same reason
// msUntilWindowOpen is, and safe for a second reason: `releaseAfter` only says
// when to LOOK at the row again — decide() then runs in full, so an answer
// that lands an hour early simply holds again.
//
// The probe runs to 21 days rather than 7 now that a holiday can be quiet: a
// weekly pattern cannot outlast a week, but Pesach in the diaspora plus the
// Shabbat either side is eight days, and returning "a week" for that would
// wake the row inside the run it is waiting out.
const QUIET_RUN_MAX_DAYS = 21;

function msUntilQuietDaysEnd(facts, window, tz, date = new Date()) {
  const DAY_MS = 86_400_000;
  for (let d = 1; d <= QUIET_RUN_MAX_DAYS; d++) {
    const probe = new Date(date.getTime() + d * DAY_MS);
    if (quietDayReason(facts, tz, probe)) continue;
    return (probe.getTime() - date.getTime()) + msUntilWindowOpen(window, tz, probe);
  }
  // Unreachable in practice: parseQuietDays refuses all seven weekdays and no
  // run of yom tov comes close to three weeks. Answering with the cap rather
  // than never is the fail-open half — a row that looks again too early holds
  // again, a row that never looks again is lost.
  return QUIET_RUN_MAX_DAYS * DAY_MS;
}

// Start of the next UTC day — the moment the daily send budget resets, since
// the count is taken over sent_at::date.
function nextUtcMidnight(date) {
  const d = new Date(date);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

// ---- the decision -----------------------------------------------------------

// Quiet hours are about not waking someone, not about refusing to answer
// someone who is right there. Within this long after their own message, they
// are demonstrably awake and mid-conversation, so the window does not apply.
const CONVERSATION_GRACE_MS = 15 * 60_000;

// How long an introduction has the floor to itself. Somebody meeting Olma for
// the first time is reading one thing; a second message a minute behind it is
// read as part of the first, and whatever it asked for is answered by nobody.
// Ten minutes is the owner's call (2026-09-08) — long enough to be a separate
// message, short enough that the day-one ladder still happens that morning.
const INTRODUCTION_ROOM_MS = 10 * 60_000;

// The narrowest thing in the system that still counts as "they asked for
// this": rung 1 of a reminder whose payload says a person put it there in
// words, not a due date the model inferred. Two separate rules need exactly
// this line — somebody who stopped answering, and a day they marked quiet —
// and writing it twice is how the two would drift apart.
function askedForInWords(row) {
  const rung = Number(row.payload && row.payload.rung) || 1;
  return row.kind === 'reminder' && rung <= 1
    && Boolean(row.payload) && row.payload.auto === false;
}

// facts: { row, plan, blocked, paused, window, quietDays, tz, sentToday, budget, now, lastInboundAt }
// returns { action: 'deliver' | 'hold' | 'expire' | 'drop', holdReason?, releaseAfter? }
function decide(facts) {
  const { row, plan, blocked, paused, window, tz, sentToday, budget } = facts;
  const now = facts.now || new Date();

  // First, and with no exceptions. This is the whole guarantee behind the pause
  // feature: sweeps skip paused users so these rows are mostly never created,
  // but a message can also be enqueued for them by somebody ELSE's action — a
  // connection request, a meeting slot, a calendar callback — and none of those
  // paths know or should have to know about this. One chokepoint, checked here.
  //
  // 'drop', not 'hold': holding means delivering later, and there is no later.
  // Not 'expire' either — that means the moment passed and folds the row into a
  // digest as "עבר זמנה", which would then be delivered.
  if (paused) {
    return { action: 'drop', holdReason: 'paused' };
  }

  // The eval user's phone number is fake by construction — a delivery attempt
  // can only fail, climb the retry counter, and trip the stuck-outbox alarm
  // with noise. Same chokepoint logic as pause: sweeps skip it, but a row can
  // be enqueued by paths that neither know nor should know about evals.
  if (facts.evalUser) {
    return { action: 'drop', holdReason: 'eval_user' };
  }

  if (row.expires_at && new Date(row.expires_at) <= now) {
    return { action: 'expire' };
  }

  // ── Somebody who has stopped answering ────────────────────────────────────
  // `checkin_misses >= 1` means the ladder already asked "את פה?" and got
  // nothing back. From that moment nothing Olma decided to say goes out —
  // not a reminder rung, not a digest, not another user's fan-out — until
  // they write (openRecord resets the counter on a real inbound message).
  // What still passes: the ladder's own check-in, which IS the three-day and
  // the weekly "מה איתך" (jobs/checkin.js, requiredGapMs), and rung 1 of a
  // reminder they asked for IN WORDS (`payload.auto === false`) — the moment
  // they named is theirs, and finding a week later that it never came is a
  // disappointment, not a relief. An automatic reminder — the model's
  // inference from a due date — is Olma's idea and stops with the rest.
  //
  // 'drop' on the OUTBOX row only, and the reminder and the task behind it
  // stay exactly as they were: the owner's rule is "stop them arriving, cancel
  // nothing" (Vered, 2026-09-07: eighteen messages on her second day and no
  // answer to any; `incidents.md`, "Eighteen messages, no answer"). A rung
  // the gate dropped is never chased (dueForSending), so the ladder simply
  // ends where it stood. Never 'hold': they may write back in a month, and
  // a month of held rows released together is the morning she already had.
  // `groupWroteAt` is the one thing that answers back. The worker sets it ONLY
  // for a row about a coordination in a room this person wrote in since that
  // coordination started (outbox/worker.js) — so the exception is scoped by
  // its own absence, and the gate does not have to know what a meeting is.
  // A person who spoke in the room a minute ago has not stopped answering and
  // has not been left alone by a quiet hour; the owner's rule, 2026-09-08, and
  // the same argument `midConversation` already makes about a DM. What it is
  // NOT is a general reopening: nothing else Olma decided to say gets through
  // on it, the reminder and the ladder keep standing where they stood, and a
  // paused user is refused above this line without reading any of it.
  const wroteInRoom = facts.groupWroteAt ? new Date(facts.groupWroteAt).getTime() : 0;
  const inRoomGrace = wroteInRoom > 0 && (now.getTime() - wroteInRoom) < CONVERSATION_GRACE_MS;

  // An `introduction` is exempt for the same reason the ladder's own check-in
  // is: it is the one thing Olma OWES rather than something she decided to
  // say, and somebody who has not answered is the likeliest person never to
  // have been told who was writing to them in the first place. ג.ב would have
  // lost his to this rule on the morning it was queued for (2026-09-08).
  if ((Number(facts.checkinMisses) || 0) >= 1
    && row.kind !== 'checkin' && row.kind !== 'introduction') {
    if (!askedForInWords(row) && !inRoomGrace) return { action: 'drop', holdReason: 'quiet' };
  }

  // ── A day they said they want nothing on ─────────────────────────────────
  // The same sentence as above about WHAT survives, and the opposite answer
  // about what happens to the rest. Somebody who stopped answering has no
  // bounded "later", so their rows are dropped; a quiet day ends on a known
  // morning, so these are held for it — the shape of the night window, one
  // rung up.
  //
  // What does NOT pass is the whole difference between a quiet day and quiet
  // hours. A DIGEST does not: quiet hours exempt it because they picked the
  // hour, but a day off is a day off, and a morning picture of a day they
  // asked not to hear about is the message they were opting out of. Nor does
  // an AUTOMATIC reminder, which is the model's inference from a due date
  // rather than a moment anybody named (owner, 2026-09-08: "רק 1").
  //
  // Nor an INTRODUCTION, and the exemption it has one branch up does not
  // transfer, because that branch DROPS and this one HOLDS: the reason an
  // introduction survives somebody who stopped answering is that it would
  // otherwise be lost for good, and here it simply lands on the next day they
  // kept. `inRoomGrace` stays out for the same reason — speaking in a room is
  // not asking Olma for the things this day was set aside from, and nothing
  // is lost by it waiting.
  //
  // A HOLIDAY reaches this line by exactly the same route and is held for
  // exactly the same reasons — only the hold_reason differs, so the dashboard
  // can tell "Saturday" from "Yom Kippur" without a second rule to keep in
  // step. It is opt-in and nothing else about it is special (owner,
  // 2026-09-11): asked once, and the calendar is yom tov only.
  const quietReason = !askedForInWords(row) && quietDayReason(facts, tz, now);
  if (quietReason) {
    return {
      action: 'hold', holdReason: quietReason,
      releaseAfter: new Date(now.getTime() + msUntilQuietDaysEnd(facts, window, tz, now)),
    };
  }

  // ── Nothing before the introduction ──────────────────────────────────────
  // An `introduction` row is Olma saying who she is to somebody who never
  // heard it — normally the intake greeter's job, and a hand-queued repair
  // when the greeter missed (ג.ב, 2026-09-08: greeted with the greeter's own
  // words instead of the copy, so `opening_sent_at` was stamped and his own
  // agent was then told the introduction was done).
  //
  // While one is queued, nothing Olma DECIDED to say goes out in front of it.
  // Order by creation time is what decided this before, which is an accident:
  // his introduction and the day-one calendar offer were both due at 08:00 and
  // the offer came from an assistant that had not yet said what she was.
  //
  // Held, never dropped — the introduction lands and the queue moves. A moment
  // THEY chose still passes, the same line the gate draws everywhere else: a
  // person who asked for a 10:45 reminder in words knows perfectly well who is
  // sending it, and making them wait for an introduction would be absurd.
  //
  // And it does not merely go FIRST — it gets the room to be read. The hold
  // used to release the instant the introduction was stamped sent, so the very
  // next row in the same drain went out on its heels: ג.ב read who Olma was at
  // 08:00:27 and was asked which city he lives in at 08:01:19. The gap is
  // measured from the moment the introduction actually LANDED, never from the
  // last time the waiting row happened to be looked at — held on a plain
  // "while one is pending" clock, a row evaluated just after the introduction
  // went out is released seconds later all the same, which is the bug wearing
  // a longer number.
  if (row.kind !== 'introduction') {
    const r = Number(row.payload && row.payload.rung) || 1;
    const theirs = row.kind === 'digest' || (row.kind === 'reminder' && r <= 1);
    if (!theirs) {
      if (facts.introductionPending) {
        return { action: 'hold', holdReason: 'awaiting_introduction', releaseAfter: null };
      }
      if (facts.introductionSentAt) {
        const readyAt = new Date(new Date(facts.introductionSentAt).getTime() + INTRODUCTION_ROOM_MS);
        if (readyAt > now) {
          return { action: 'hold', holdReason: 'awaiting_introduction', releaseAfter: readyAt };
        }
      }
    }
  }

  if (blocked) {
    const paidReminder = row.kind === 'reminder' && plan !== 'free';
    if (!paidReminder && row.kind !== 'unblock_summary') {
      return { action: 'hold', holdReason: 'blocked', releaseAfter: facts.blockedUntil || null };
    }
  }

  // ── Which moments are THEIRS ─────────────────────────────────────────────
  // A digest runs at an hour they set, and rung 1 of a reminder is the moment
  // they named — quiet hours have never applied to either, because the whole
  // point of quiet hours is not to wake somebody with something WE decided to
  // say. Every later rung is something we decided to say: rung 2 is "three
  // hours after rung 1 landed" and rung 3 is "the next day", and neither
  // number came from the person. Vered asked for a reminder at 22:32 on her
  // first evening and was asked "בוצע?" at 01:33 (`incidents.md`, "The rung
  // nobody asked for, at half past one"). `sweepReminders` already draws this
  // exact line for the daily budget — "Only the moment THEY chose is urgent
  // enough to skip it" — and the night window simply never got the same
  // sentence. Rung 1 is also bounded: it expires two hours past its own
  // moment, so the exemption cannot place a message far from what they picked,
  // while a later rung expires two hours from NOW and could land anywhere.
  const rung = Number(row.payload && row.payload.rung) || 1;
  const userChoseThisTime = row.kind === 'digest' || (row.kind === 'reminder' && rung <= 1);
  const lastInbound = facts.lastInboundAt ? new Date(facts.lastInboundAt).getTime() : 0;
  const midConversation = (lastInbound > 0 && (now.getTime() - lastInbound) < CONVERSATION_GRACE_MS)
    || inRoomGrace;
  if (!userChoseThisTime && !midConversation && !withinWindow(window, tz, now)) {
    return {
      action: 'hold', holdReason: 'night',
      releaseAfter: new Date(now.getTime() + msUntilWindowOpen(window, tz, now)),
    };
  }

  // The introduction is exempt from the daily budget, and it is the only kind
  // exempt for a reason that is not about whose moment it is. Everything else
  // in this person's queue is held BEHIND it, so a budget-held introduction is
  // a deadlock that only the two-day bound in the worker breaks — and it is
  // not one of Olma's four daily initiatives in the first place. It is the
  // sentence that makes the other four make sense.
  if (row.kind !== 'introduction'
    && row.urgency !== 'urgent' && !userChoseThisTime && sentToday >= budget) {
    // A budget-held row is picked up by the next digest rather than retried on
    // a clock — but sweepDigests only visits users who HAVE digest_times, so
    // for everyone else that pickup never comes and the row sits unsent
    // forever. That is not theoretical: a connection request to a user with no
    // digest was orphaned this way and the person never learned anyone had
    // asked. Those users get the next day instead, where the budget has reset
    // and the night rule below then lands it at a humane hour. Never "now" —
    // the budget is still spent, and a same-day retry would just spin.
    return {
      action: 'hold', holdReason: 'budget',
      releaseAfter: facts.hasDigest ? null : nextUtcMidnight(now),
    };
  }

  return { action: 'deliver' };
}

module.exports = {
  decide, withinWindow, msUntilWindowOpen, minutesInTz, parseHHMM, nextUtcMidnight,
  weekdayInTz, localDateInTz, msUntilQuietDaysEnd, quietDayReason, askedForInWords,
  CONVERSATION_GRACE_MS,
};
