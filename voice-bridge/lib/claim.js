'use strict';
// Does a spoken sentence say Olma DID (or is about to do) a write?
//
// The system prompt already carries an iron rule — never say "הוספתי" without
// a tool call in the same turn — and on 2026-09-27 the model broke it twice in
// one call: "הוספתי לך משימה 'פיזיותרפיה' למחר" with no add_task behind it,
// and "אני אעדכן את זה" with no reschedule_task after it. The person hung up
// believing both. An instruction in a prompt is a request; this is the rule.
//
// Two shapes, both first person:
//  - a PAST claim ("הוספתי", "רשמתי", "עדכנתי"…) — said as done;
//  - a FUTURE promise ("אעדכן", "אוסיף", "ארשום"…) — said as about to be
//    done, which on a phone call is heard as done: nobody waits on the line
//    for a write that was never going to happen.
// Hebrew verbs only: the bridge speaks Hebrew. A miss here costs exactly what
// it cost before this existed; a false hit costs one extra model round.
const PAST = /(^|[^֐-׿])(הוספתי|רשמתי|שמרתי|עדכנתי|קבעתי|סימנתי|העברתי|שיניתי|תיקנתי|הזזתי|מחקתי|ביטלתי)(?=$|[^֐-׿])/;
const FUTURE = /(^|[^֐-׿])(אעדכן|אוסיף|ארשום|אשמור|אשנה|אתקן|אעביר|אקבע|אסמן|אזיז|אמחק|אבטל)(?=$|[^֐-׿])/;

// Not a claim: a QUESTION ("אוסיף את זה?" is an offer) and a NEGATION ("לא
// הוספתי" is the honest answer this exists to get). "שאוסיף" never matches at
// all, because the verb must start a word.
function claimsWrite(sentence) {
  const s = String(sentence || '').trim();
  if (!s || /\?["']?$/.test(s)) return false;
  for (const re of [PAST, FUTURE]) {
    const m = re.exec(s);
    if (m && !/(^|[^\u0590-\u05FF])(לא|עוד לא|טרם)\s+$/.test(s.slice(0, m.index + m[1].length))) return true;
  }
  return false;
}

// The tools whose success a claim like that may stand on.
const WRITE_TOOLS = new Set(['add_task', 'complete_task', 'reschedule_task', 'add_calendar_event', 'set_persona']);

module.exports = { claimsWrite, WRITE_TOOLS };
