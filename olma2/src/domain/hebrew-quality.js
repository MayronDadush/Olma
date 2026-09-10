'use strict';
// Deterministic reads of a sentence Olma wrote, for the flaws that need no
// judge. Two readers use this: the eval harness (scenarios.herOwnVoice, red on
// every scenario) and the daily metrics rollup (jobs/metrics.js, a count per
// day on the dashboard). Both must agree on what a flaw is, which is why the
// patterns live here and nowhere else.
//
// Olma is a woman — עולמה — and 338 of her real messages over three days
// (2026-09-06..08) were read for this: about 7% had a flaw, and the most
// frequent one was a masculine self-reference. "אני מבין", "אני מניח שאתה
// בישראל", "מצטער, יובל", "אני לא יכול לראות תמונות". The doctrine already
// forbids all of it and the doctrine is full, so the model's slip has to be
// COUNTED rather than instructed away: a check that is red in the evals and a
// number on the dashboard that moves when the model changes.
//
// Measured before shipping (CLAUDE.md, "A hint that fires on ordinary input is
// worse than no hint"): over 383 distinct real messages the two readers below
// flagged 10, every one of them a real slip (8 masculine, 2 markup). `רואה` was on the first draft and was
// the only false positive — it is the same word in both genders — and every
// other form that does not change (מקווה, מחכה, עושה, מנסה, רוצה) is left
// out for the same reason. `שם`, `בא` and `צריך` are ambiguous words rather
// than verbs in most sentences and are left out too.

// Present-tense masculine forms whose feminine differs (יכול → יכולה). Only
// after אני, because "אתה יודע" and "הוא יכול" are about somebody else.
const AFTER_ANI = [
  'יכול', 'מבין', 'מניח', 'יודע', 'חושב', 'מצטער', 'שמח', 'בטוח', 'זוכר', 'מתכוון',
  'עוזר', 'מוכן', 'בודק', 'מעדכן', 'שולח', 'רושם', 'מזכיר', 'מוסיף', 'עובד', 'לומד',
  'מרגיש', 'מתנצל', 'ממליץ', 'מציע', 'מסכים', 'נמצא', 'זמין', 'קובע', 'מבטל', 'מחפש',
  'מבקש', 'שומע', 'דואג', 'פותח', 'סוגר', 'עוקב', 'מעביר', 'מתחיל', 'מסיים', 'מקבל',
  'נותן', 'אומר', 'מדבר', 'כותב', 'קורא', 'מכיר', 'מתייחס', 'מוחק', 'שומר', 'מתאם',
  'מארגן', 'מסדר', 'ממשיך', 'מפסיק', 'מתחייב', 'מבטיח', 'מאשר', 'מתקן', 'מסתכל',
  'לוקח', 'מעריך', 'יושב', 'חוזר', 'הולך', 'מודה',
];
// A sentence opener with no אני in front of it is still her speaking.
const AT_START = ['מצטער', 'מבין', 'שמח לעזור', 'בטוח ש'];

const EDGE = '(?:^|[\\s,.!?…:;()"״\'-])';
const AFTER = '(?=$|[\\s,.!?…:;()"״\'-])';
const ADVERB = '(?:לא\\s+|גם\\s+|כבר\\s+|עדיין\\s+|רק\\s+|ממש\\s+|באמת\\s+)?';
const MASCULINE_SELF_RE = new RegExp(
  `${EDGE}(?:ו|ש|כש|וש)?אני\\s+${ADVERB}(${AFTER_ANI.join('|')})${AFTER}`, 'g');
const MASCULINE_OPENER_RE = new RegExp(
  `(?:^|[.!?…\\n]\\s*)(${AT_START.join('|')})${AFTER}`, 'g');

// The model's own frame delivered as text: a tool-call marker, or an identity
// token, in a sentence a person read. Both have reached a real phone — the
// 2026-09-02 DSML leak and Dana's sixth check-in on 2026-09-08 (with her own
// olma_identity token in it).
//
// Read from `domain/reply-leak.js` since 2026-09-10 rather than kept here:
// that module is the DELIVERY gate for the same shape, and a count on the
// dashboard that disagreed with what the gate stops would be worse than
// either alone. One owner, two readers — the eval's `markup` flaw is what
// this call still means.
const { FRAME_RE: MARKUP_RE } = require('./reply-leak');

// Quoted text is somebody else's words: "כתבת 'אני יכול מחר'" is not her slip.
function unquoted(text) {
  return String(text || '').replace(/["״'][^"״'\n]{1,80}["״']/g, ' ');
}

// Returns the flaws in one message: [] for a clean one. Each is { kind, at }
// where `at` is the phrase that tripped it, for the eval detail and for a
// reader on the dashboard checking the count is not lying.
function flawsIn(text) {
  const out = [];
  const t = unquoted(text);
  for (const re of [MASCULINE_SELF_RE, MASCULINE_OPENER_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) out.push({ kind: 'masculine', at: m[0].trim() });
  }
  const mk = MARKUP_RE.exec(String(text || ''));
  if (mk) out.push({ kind: 'markup', at: mk[0].slice(0, 40) });
  return out;
}

module.exports = { flawsIn, AFTER_ANI, AT_START, MASCULINE_SELF_RE, MASCULINE_OPENER_RE, MARKUP_RE };
