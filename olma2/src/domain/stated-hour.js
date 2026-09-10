'use strict';
// The hour in the title, against the hour the row will actually fire at.
//
// `hasOffset` (domain/datetime) refuses a due_at with NO offset, and every
// task write path calls it. It does not — cannot — refuse a well-formed offset
// that is simply the wrong one, and CLAUDE.md has said since the beginning
// that "a well-formed-but-wrong time still needs a semantic cross-check".
// This is that cross-check, and until now nothing implemented it.
//
// Maya's three work shifts are the founding case: "משמרת עבודה - יום ראשון
// 16:00-22:00" stored as 16:00Z, which is 19:00 where she lives. A perfectly
// formed instant, three hours from what she said, and no guard in the system
// could see it — the words were right there in the row beside the number.
//
// **What this canNOT see, and it matters:** a fault that comes from
// `users.timezone` being wrong cancels out here, exactly as it does in
// reminder-promise.js. Sarah's brunch was stored as 14:00Z while her row said
// America/New_York, so it rendered as the 10:00 her title claimed and read as
// correct; it only became visible once somebody fixed the zone. The two halves
// of `promise_watch` share that blind spot because they share that column, and
// closing it is `users.setTimezone` → `timezone-repair.js`, which rewrites
// what the wrong zone wrote. This check is for the other class: the stored
// instant disagreeing with the person's own words INDEPENDENTLY of the zone.
//
// Measured against all 93 dated tasks on the box (2026-09-11): 11 titles carry
// a clock, 7 agree, and the 4 that disagree are the 4 known faults. No false
// positives — see tests/stated-hour.test.js, which keeps the seven agreeing
// shapes as the rows that would have killed a looser rule.

// A clock as people write it, bounded on both sides so a score or a date
// fragment cannot masquerade as one. Same shape as reminder-promise's TIME_RE,
// kept separate for the same reason that one was: these answer different
// questions about different authors, and one must be free to move.
const TITLE_CLOCK_RE = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/;

// Deliberately the FIRST clock only. A title naming a span — "16:00-22:00",
// "בין 14:00 ל-16:00" — is naming when the thing STARTS and when it ends, and
// due_at is the start. Reading them all would report every range ever written.
//
// Deliberately a full HH:MM and never a bare hour. "ב-16" is far more often a
// day of the month than an hour, and a detector that fires on ordinary input
// is worse than no detector.
function statedHour(title) {
  const m = String(title || '').match(TITLE_CLOCK_RE);
  return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : null;
}

// `dueLocal` is 'HH:MM' in the OWNER's zone — rendered by the caller, in
// Postgres, so there is no offset arithmetic here to break at a DST boundary.
// Returns null when there is nothing to say: no clock in the title, or the two
// agree.
function statedHourMismatch({ title, dueLocal }) {
  const stated = statedHour(title);
  if (!stated || typeof dueLocal !== 'string' || !/^\d{2}:\d{2}$/.test(dueLocal)) return null;
  if (stated === dueLocal) return null;
  return { stated, stored: dueLocal };
}

module.exports = { statedHourMismatch, statedHour, TITLE_CLOCK_RE };
