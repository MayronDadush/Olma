'use strict';
// A reply that says it saved something, on a turn where nothing was saved.
//
// Nightly eval #91 (2026-09-25) had the model answer a brain-dump with "רשמתי
// לך הכל" and make no tool call at all — the person reads a 👍-shaped promise
// and nothing is on their list. Read against real traffic the same day, 4,636
// user turns held 126 replies claiming a save and 11 of those had no tool call
// behind them, and every one of the 11 was a turn Olma had STARTED (a delivery,
// where "רשמתי" is a report of an earlier turn's write) or not a claim at all.
// So it has not been seen hurting a real person yet — which is exactly when a
// detector is cheap to build and its fire rate can still be read before it is
// trusted (CLAUDE.md, "A detector that can no longer fail is not a detector").
//
// REPORT-ONLY. The gateway plugin notices the words and tells brokerd, which
// alone knows whether a tool ran on this turn, and files what it decided. The
// reply goes out either way, and nothing here may ever delay it.
//
// The plugin carries a PORT of `claimedWrite` (gateway-plugin/olma-turn,
// `claimedWrite`), like `reply-leak.gateReply`, and
// `tests/phantom-save.test.js` holds one corpus against both.

// First person, past tense, the verbs a save is announced with. A ו or ש
// prefix is still the claim ("ורשמתי"); a Hebrew letter on either side is a
// different word. `\b` is dead against Hebrew — Hebrew letters are not `\w` —
// hence the explicit letter class (.claude/rules/turns-and-replies.md).
const HE_CLAIM_RE = /(?:^|[^֐-׿])[וש]?(רשמתי|שמרתי|הוספתי|קבעתי|עדכנתי|מחקתי|ביטלתי|תזמנתי|הגדרתי)(?![֐-׿])/;
const EN_CLAIM_RE = /\bI(?:'ve| have)\s+(saved|added|noted|scheduled|updated|deleted|removed|cancel+ed|set)\b/i;

function claimedWrite(text) {
  const s = String(text == null ? '' : text);
  const he = HE_CLAIM_RE.exec(s);
  if (he) return he[1];
  const en = EN_CLAIM_RE.exec(s);
  return en ? en[1].toLowerCase() : null;
}

// How long an open stays the turn a reply belongs to. A turn that has run this
// long without replying is not one this can speak for.
const OPEN_WINDOW_MS = 15 * 60 * 1000;

// Four answers, and `unknown` is not `unbacked` (CLAUDE.md, "Absence of
// evidence scored as evidence"): brokerd keeps its memory of opens and tool
// calls in process, so a restart between the open and the reply leaves nothing
// to judge by, and that must never read as "no tool ran".
//
// `opens` is every gateway open for this person inside the window, newest
// last. Two messages close together are two turns (queue mode `followup`), and
// a reply to the first can be sent after the second has opened — so a tool
// call since the EARLIEST open in the window backs it. That errs towards
// silence, which is the right side for a report nobody has calibrated yet.
function judge({ ourTurn = false, opens = [], lastToolAt = null, now }) {
  if (ourTurn) return { verdict: 'ours' };
  const live = opens.filter((t) => now - t <= OPEN_WINDOW_MS);
  if (!live.length) return { verdict: 'unknown' };
  const earliest = Math.min(...live);
  const openedAgoMs = now - Math.max(...live);
  const toolAgoMs = lastToolAt == null ? null : now - lastToolAt;
  const backed = lastToolAt != null && lastToolAt >= earliest;
  return { verdict: backed ? 'backed' : 'unbacked', openedAgoMs, toolAgoMs, opens: live.length };
}

module.exports = { claimedWrite, judge, OPEN_WINDOW_MS, HE_CLAIM_RE, EN_CLAIM_RE };
