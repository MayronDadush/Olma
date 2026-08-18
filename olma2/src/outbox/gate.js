'use strict';
// The respectful delivery gate — ONE decision function every proactive
// message passes through. Pure: takes facts, returns an action. The worker
// gathers the facts; this file never touches the DB, which is what makes the
// whole policy unit-testable in milliseconds.
//
// Policy (each rule traces to an explicit design decision):
//   blocked user     → hold, except paid-plan reminders and the unblock summary
//   outside personal availability window → hold until window opens
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

// ---- the decision -----------------------------------------------------------

// facts: { row, plan, blocked, window, tz, sentToday, budget, now }
// returns { action: 'deliver' | 'hold' | 'expire', holdReason?, releaseAfter? }
function decide(facts) {
  const { row, plan, blocked, window, tz, sentToday, budget } = facts;
  const now = facts.now || new Date();

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
  if (!userChoseThisTime && !withinWindow(window, tz, now)) {
    return {
      action: 'hold', holdReason: 'night',
      releaseAfter: new Date(now.getTime() + msUntilWindowOpen(window, tz, now)),
    };
  }

  if (row.urgency !== 'urgent' && !userChoseThisTime && sentToday >= budget) {
    // No release_after: a budget-held row is picked up by the next digest,
    // not retried on a clock.
    return { action: 'hold', holdReason: 'budget', releaseAfter: null };
  }

  return { action: 'deliver' };
}

module.exports = { decide, withinWindow, msUntilWindowOpen, minutesInTz, parseHHMM };
