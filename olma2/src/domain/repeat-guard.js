'use strict';
// ── The same thing does not go out twice inside a few minutes ────────────────
//
// The owner's rule, 2026-09-10, after Miron read the same picture of his
// evening at 18:01 and again at 18:02: whatever Olma DECIDED to say, she says
// once. A person who asks for it again is a different matter entirely — they
// asked, and answering twice is answering, not repeating.
//
// So this file holds one window and one sentence about who it applies to, and
// the two places that can produce a repeat read them from here rather than
// each carrying its own number:
//
//   - outbox/gate.js   — two rows of the same kind for one person. Every
//                        proactive message passes the gate, so that is where a
//                        repeat is stopped for everything Olma decided to say.
//   - the card tool    — the same drawn card twice inside one self-initiated
//                        turn, which is the shape the rule was written for and
//                        the one the gate cannot see: a model turn puts every
//                        text block it emits on the phone by itself, and no
//                        outbox row is involved in the second one.
//
// What it does NOT cover is worth writing down, because a guard believed to
// cover more than it does is worse than none: nothing here can see the words a
// model chose. Two DIFFERENT renderings of the same facts — the drawn block
// and a card of the same list — are not caught by any signature, and are
// prevented one level up instead, by never handing a turn both of them
// (adapters/mcp/tools/digest.js).
//
// In-process, like domain/self-initiated.js and for the same reason: brokerd is
// one process, so this needs no column and no migration, and a restart — which
// ends any turn in flight anyway — cannot leave a stale entry behind.

const crypto = require('node:crypto');

// Ten minutes, the same number the introduction holds the floor for. Long
// enough that a second copy is unmistakably a repeat rather than a follow-up,
// short enough that a person who gets their morning digest at 09:00 and asks
// for their week at 09:15 is nowhere near it.
const REPEAT_WINDOW_MS = 10 * 60_000;

// userId → { sig, at }. One entry per person: only the LAST thing matters,
// because a repeat is by definition the thing that just went out. Bounded by
// the number of live users, and swept below so a quiet account is not held for
// ever.
const last = new Map();

// A stable fingerprint of what is about to be said. JSON.stringify of an object
// built in a fixed order by its caller, hashed so nothing about the person or
// their day is kept in memory a heap dump could read.
function signature(value) {
  return crypto.createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 32);
}

function prune(now) {
  for (const [id, entry] of last) {
    if (now - entry.at > REPEAT_WINDOW_MS) last.delete(id);
  }
}

// Has this exact thing been produced for this person inside the window? Returns
// the age in ms if so, null otherwise. Read-only — `remember` is separate so a
// caller that refuses does not also refresh the clock it refused against, which
// would let a model retrying in a loop push the window out for ever.
function repeatAge(userId, sig, now = Date.now()) {
  const entry = last.get(Number(userId));
  if (!entry || entry.sig !== sig) return null;
  const age = now - entry.at;
  return age >= 0 && age < REPEAT_WINDOW_MS ? age : null;
}

function remember(userId, sig, now = Date.now()) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  prune(now);
  last.set(id, { sig, at: now });
}

// Tests only — a leaked entry is a cross-test ghost.
function _reset() { last.clear(); }

module.exports = { REPEAT_WINDOW_MS, signature, repeatAge, remember, _reset };
