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

  if (row.expires_at && new Date(row.expires_at) <= now) {
    return { action: 'expire' };
  }

  if (blocked) {
    const paidReminder = row.kind === 'reminder' && plan !== 'free';
    if (!paidReminder && row.kind !== 'unblock_summary') {
      return { action: 'hold', holdReason: 'blocked', releaseAfter: facts.blockedUntil || null };
    }
  }

  // reminder/digest: the user picked those times.
  const userChoseThisTime = row.kind === 'reminder' || row.kind === 'digest';
  const lastInbound = facts.lastInboundAt ? new Date(facts.lastInboundAt).getTime() : 0;
  const midConversation = lastInbound > 0 && (now.getTime() - lastInbound) < CONVERSATION_GRACE_MS;
  if (!userChoseThisTime && !midConversation && !withinWindow(window, tz, now)) {
    return {
      action: 'hold', holdReason: 'night',
      releaseAfter: new Date(now.getTime() + msUntilWindowOpen(window, tz, now)),
    };
  }

  if (row.urgency !== 'urgent' && !userChoseThisTime && sentToday >= budget) {
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
