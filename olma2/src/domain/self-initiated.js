'use strict';
// Which turns Olma started itself.
//
// A turn that WE spawn — an outbox delivery, a housekeeping run — reaches the
// agent through the same gateway, the same agent and the same session key as a
// message the person typed. Nothing in the MCP call distinguishes them, so
// `turn_start` treated both as "the person just wrote to us" and wrote the
// inbound record on turns where nobody wrote anything.
//
// What that cost, all from one wrong bit (2026-09-04, walking a cold start on
// a real account):
//
//   - `last_inbound_at` moved on our own check-in, so `isDeafOnDayOne` — which
//     asks whether they answered — could never return true, and the day-one
//     ladder's one protection against nagging a silent person was dead.
//   - `checkin_misses` reset to 0 on the very message it was counting, so the
//     "every unanswered check-in doubles the wait" backoff never backed off.
//   - `message.received` was recorded, which is the north-star numerator: the
//     response-rate metric counted every check-in as its own reply.
//   - and the one that made it visible: the first-turn signal was spent by the
//     15-minute onboarding rung, so a person's welcome arrived unprompted
//     before they had said a word, and their actual first message got the
//     ordinary greeting.
//
// The fix is a bit that only the code spawning the turn can know, so that is
// where it is set. In-process on purpose: the outbox worker and the tool
// handlers are the same brokerd process (see brokerd/server.js), so this needs
// no column and no migration, and a restart — which kills any in-flight
// delivery anyway — cannot leave a stale marker behind.
//
// A depth counter rather than a boolean: two deliveries for one person can
// overlap (a sweep and a retry), and the first one to finish must not clear
// the mark the second is still relying on.
const depth = new Map();

function begin(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  depth.set(id, (depth.get(id) || 0) + 1);
}

function end(userId) {
  const id = Number(userId);
  const n = depth.get(id);
  if (!n) return;
  if (n <= 1) depth.delete(id);
  else depth.set(id, n - 1);
}

function isActive(userId) {
  return (depth.get(Number(userId)) || 0) > 0;
}

// Run `fn` with the mark held, and release it however fn ends. Callers must
// use this rather than begin/end by hand: a delivery that threw and left the
// mark set would make every later message from that person invisible to the
// record, which is a worse bug than the one this fixes.
async function around(userId, fn) {
  begin(userId);
  try { return await fn(); } finally { end(userId); }
}

// Tests only — a leaked mark is a cross-test ghost.
function _reset() { depth.clear(); }

module.exports = { begin, end, isActive, around, _reset };
