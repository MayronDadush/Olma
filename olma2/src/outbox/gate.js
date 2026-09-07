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

// facts: { row, plan, blocked, paused, window, tz, sentToday, budget, now, lastInboundAt }
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
  //
  // An `introduction` is exempt for the same reason the ladder's own check-in
  // is: it is the one thing Olma OWES rather than something she decided to
  // say, and somebody who has not answered is the likeliest person never to
  // have been told who was writing to them in the first place. ג.ב would have
  // lost his to this rule on the morning it was queued for (2026-09-08).
  if ((Number(facts.checkinMisses) || 0) >= 1
    && row.kind !== 'checkin' && row.kind !== 'introduction') {
    const rung = Number(row.payload && row.payload.rung) || 1;
    const askedInWords = row.kind === 'reminder' && rung <= 1
      && row.payload && row.payload.auto === false;
    if (!askedInWords) return { action: 'drop', holdReason: 'quiet' };
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
  if (facts.introductionPending && row.kind !== 'introduction') {
    const r = Number(row.payload && row.payload.rung) || 1;
    const theirs = row.kind === 'digest' || (row.kind === 'reminder' && r <= 1);
    if (!theirs) return { action: 'hold', holdReason: 'awaiting_introduction', releaseAfter: null };
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
  const midConversation = lastInbound > 0 && (now.getTime() - lastInbound) < CONVERSATION_GRACE_MS;
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
  CONVERSATION_GRACE_MS,
};
