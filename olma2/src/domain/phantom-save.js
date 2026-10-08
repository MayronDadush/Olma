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
//
// Since 2026-10-08 the verbs of PASSING SOMETHING ON and of marking are in it
// too: three of the five false claims the weekly reviews found in three
// weeks were "שלחתי להם", "החברים עודכנו", "סימנתי" — not a save word among
// them (`incidents.md`, "שלחתי להם, and nothing was sent").
const HE_CLAIM_RE = /(?:^|[^֐-׿])[וש]?(רשמתי|שמרתי|הוספתי|קבעתי|עדכנתי|מחקתי|ביטלתי|תזמנתי|הגדרתי|שלחתי|הודעתי|העברתי|תיעדתי|סימנתי|שיתפתי|הזמנתי|ארכבתי|עודכנו)(?![֐-׿])/;
const EN_CLAIM_RE = /\bI(?:'ve| have)\s+(saved|added|noted|scheduled|updated|deleted|removed|cancel+ed|set|sent|told|passed|shared|marked|let)\b/i;

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
//
// …but "a tool since the earliest open" is also what called Dov's reply
// "backed" (2026-09-27): during a burst of eight messages the pill reminder's
// set_task_reminder had succeeded twelve seconds earlier, on the PREVIOUS
// message's turn, and his own turn's set_task_reminder had FAILED ("remind_at
// is already past") — and Olma told him "רשמתי — כל צהריים ב-12:00". So the
// burst case keeps its leniency under its own name, and two answers are
// sharper than it: `backed` needs a success since the NEWEST open, and
// `failed` is a write that failed since the newest open — the phantom save in
// its plainest form.
//
// `failed` is asked PER TOOL since 2026-10-08 (`unresolved`, kept by brokerd):
// a WRITE whose last call failed and was not retried successfully. Read off
// "the last tool call" it never fired once in two weeks, because something
// always ran after the failure — a list, a retry of a different tool — while
// six false claims went out (u-36 "שלחתי להם את ההודעה בקבוצה" under a
// refused `relay_to_group`). A failed READ is not a failed write, and a reply
// that already says it did not work is `failed_admitted`, which nobody
// corrects.
function judge({ ourTurn = false, opens = [], lastToolAt = null, unresolved = [], admits = false, now }) {
  if (ourTurn) return { verdict: 'ours' };
  const live = opens.filter((t) => now - t <= OPEN_WINDOW_MS);
  if (!live.length) return { verdict: 'unknown' };
  const earliest = Math.min(...live);
  const newest = Math.max(...live);
  const openedAgoMs = now - newest;
  const toolAgoMs = lastToolAt == null ? null : now - lastToolAt;
  const okNow = lastToolAt != null && lastToolAt >= newest;
  const failed = (Array.isArray(unresolved) ? unresolved : []).filter((f) => f && f.at >= newest).map((f) => f.tool);
  let verdict = 'unbacked';
  if (failed.length) verdict = admits ? 'failed_admitted' : 'failed';
  else if (okNow) verdict = 'backed';
  else if (lastToolAt != null && lastToolAt >= earliest) verdict = 'backed_earlier';
  return { verdict, openedAgoMs, toolAgoMs, opens: live.length, ...(failed.length ? { failedTools: failed } : {}) };
}

// Which tools are READING. `failed` asks about a WRITE that failed and was
// never retried successfully, per tool: a calendar read that failed beside a
// proposal that landed was 25 of the 88 failed-tool turns in three weeks, and
// every one of those replies was true. Anything not reading is a write — a
// new tool is judged until somebody says it only reads.
const READ_TOOL_RE = /^(?:[a-z]+__)?(?:list_|get_|view_|see_|my_|search|find_|open_my_|render_|generate_|ask_user$|turn_)|_status$/;
function isWrite(name) {
  return Boolean(name) && !READ_TOOL_RE.test(String(name));
}

// The reply already SAYS it did not work, so there is nothing to correct.
// Every honest reply in the three weeks read said so in one of these words,
// and a bare "לא" is not one of them: "החברים עודכנו שאתה לא מגיע" was a
// false claim.
const ADMITS_RE = /לא הצלח|לא עבד|לא נשלח|לא נשמר|לא נרשם|לא יכול|לא ניתן|לא זמין|לא מאפשר|לא נותנ|לא מחובר|עדיין לא|לצערי|נכשל|תקלה|שגיאה|מגבלה|אי אפשר|\b(?:could not|couldn't|can't|cannot|failed|unable|did not|didn't|wasn't|not sent|not saved)\b/i;
function admitsFailure(text) {
  return ADMITS_RE.test(String(text == null ? '' : text));
}

// The line code adds under a reply that claims what a failed write did not
// do. Fixed text, never the model's: the model already had the error in front
// of it and wrote the claim anyway. Two shapes, because "not sent" and "not
// saved" are different news, and the reader's language — `writesHebrew` is a
// tri-state and `null` acts like `false` (.claude/rules/turns-and-replies.md).
const PASSES_ON = new Set(['send_message_to_connection', 'relay_to_group', 'add_group_coordination_option']);
const CORRECTIONS = {
  sent: { he: '⚠️ תיקון: זה לא נשלח בפועל.', en: '⚠️ Correction: that was not actually sent.' },
  saved: { he: '⚠️ תיקון: זה לא נשמר בפועל, הפעולה נכשלה.', en: '⚠️ Correction: that was not actually saved — the action failed.' },
};
function correctionFor(tools, writesHebrew) {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return null;
  const shape = list.some((t) => PASSES_ON.has(t)) ? 'sent' : 'saved';
  return CORRECTIONS[shape][writesHebrew === true ? 'he' : 'en'];
}

module.exports = {
  claimedWrite, judge, isWrite, admitsFailure, correctionFor, CORRECTIONS, OPEN_WINDOW_MS, HE_CLAIM_RE, EN_CLAIM_RE, ADMITS_RE,
};
