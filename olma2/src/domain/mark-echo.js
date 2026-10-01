'use strict';
// A reply that only says again what the 👍 on their message already said.
//
// Miron, 2026-09-30 23:36: "תוסיף לי משימה לעשות את הסרטון לגוגל בשביל היומן"
// → `add_task`, 👍 on his message, and then "רשמתי: לעשות את הסרטון לגוגל
// בשביל היומן 👍" under it. The result the model read last carried
// `hints.markPlaced` and NOTHING else — no competing hint, nothing to outvote
// it — so this is not the "outvoted" variant of the markPlaced family and not
// the "mark absent" one (.claude/rules/doctrine.md). It is the plain one: the
// hint arrived, alone, and was not obeyed. An instruction in a prompt is a
// request; the reply gate is where it becomes a rule (same argument as the
// working-out tiers in domain/reply-leak.js).
//
// WHAT IS REDUNDANT IS MEASURED AGAINST WHAT BOTH SIDES ALREADY KNOW, not
// against a list of phrasings the model has used so far. A reply under a
// standing 👍 is an echo only when EVERY word in it is one of:
//   - a word of THEIR OWN message — they know what they asked; the gateway
//     plugin holds it for five minutes and hands it in beside the rest;
//   - a word of what the marked tool itself wrote: its title, name, fact
//     (`vocabOf`, off the RESULT, never off the model's arguments);
//   - a closed grammatical class below: the "I did it" words, and the glue
//     that joins them to their object.
// and it has no question mark, no digit that neither side wrote, no link, and
// is at most two short lines. One word neither of them said — "מחר" Olma
// inferred, a category she picked, an hour, a caveat, the answer to a second
// request in the same message — and it passes whole. A miss costs one
// redundant line, which is what every message had before; a false drop would
// cost a real answer, so every doubt resolves to "not an echo".
//
// The tool's words come from brokerd, which alone has the tool result; their
// message and the decision stay in the gateway, which alone has the reply. The
// plugin carries a PORT of `echoOnly` (gateway-plugin/olma-turn) and
// `tests/mark-echo.test.js` holds one corpus against both.

// Letters and digits, any script. Everything else — punctuation, emoji, the
// ✅ and 👍 the model decorates with — separates words and is never content.
const WORD_RE = /[\p{L}\p{N}]+/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const QUESTION_RE = /[?？؟]/;
const DIGIT_RE = /\p{N}/u;
// One Hebrew prefix letter on a word that is otherwise known ("ולקנות",
// "לרשימה", "הסרטון" against "סרטון"). Only when the rest is two letters or
// more, so a single letter never turns an unknown word into a known one.
const HE_PREFIX_RE = /^[והלבשמכ]([֐-׿]{2,})$/;

const MAX_CHARS = 280;
const MAX_LINES = 2;

// Closed by GRAMMAR, not by what the model happened to write last week: the
// inflections of "I saved / it was saved", an acknowledgement, the pronouns
// and prepositions that join one to its object, and the list a save lands
// on. It does not grow with new phrasings — a phrasing that is only their
// words and the title is already an echo without it. Nothing here names
// WHEN, WHO or ANYTHING NEW — "מחר", "תזכורת", "ביומן" stay off, because
// each can be the one fact a mark cannot carry (unless THEY said it).
const FILLER = new Set([
  // Hebrew: the announcement
  'רשמתי', 'רשמנו', 'נרשם', 'נרשמה', 'נרשמו',
  'הוספתי', 'הוספנו', 'נוסף', 'נוספה', 'נוספו',
  'שמרתי', 'נשמר', 'נשמרה', 'נשמרו',
  'עדכנתי', 'עודכן', 'עודכנה', 'עודכנו',
  'מחקתי', 'נמחק', 'נמחקה', 'נמחקו',
  'ביטלתי', 'בוטל', 'בוטלה', 'בוטלו',
  'סימנתי', 'סומן', 'סומנה', 'הושלם', 'הושלמה', 'הושלמו',
  'בוצע', 'בוצעה', 'עשיתי', 'סגור', 'סגרתי', 'סגרנו',
  'מעולה', 'אחלה', 'יופי', 'טוב', 'אוקיי', 'אוקי', 'בסדר', 'הנה', 'נהדר',
  // Hebrew: what joins it to its object
  'לך', 'לי', 'את', 'זה', 'זאת', 'אותו', 'אותה', 'אותם', 'גם', 'כבר', 'כ',
  'משימה', 'משימות', 'רשימה', 'רשימת', 'כמשימה',
  'ל', 'ב', 'ה', 'ו', 'ש',
  // English
  'done', 'added', 'saved', 'noted', 'updated', 'deleted', 'removed',
  'marked', 'completed', 'complete', 'cancelled', 'canceled',
  'ok', 'okay', 'got', 'it', 'i', 've', 'have', 'to', 'your', 'the', 'a',
  'list', 'task', 'tasks', 'as', 'and', 'all', 'set', 'great', 'sure',
]);

function wordsOf(s) {
  return (String(s == null ? '' : s).toLowerCase().match(WORD_RE)) || [];
}

// Which keys of a tool result are what the PERSON asked to be written. Not
// `category` (Olma picks it — "רשמתי תחת עבודה" says something the mark does
// not), not a date or an id, and never anything under `hints`.
const VOCAB_KEYS = new Set(['title', 'name', 'fact', 'text', 'label', 'content']);
const VOCAB_MAX = 60;

function vocabOf(data, out = [], depth = 0) {
  if (!data || typeof data !== 'object' || depth > 4 || out.length >= VOCAB_MAX) return out;
  for (const [k, v] of Object.entries(data)) {
    if (k === 'hints') continue;
    if (typeof v === 'string') {
      if (VOCAB_KEYS.has(k) && v.trim() && out.length < VOCAB_MAX) out.push(v.slice(0, 300));
    } else if (v && typeof v === 'object') {
      vocabOf(v, out, depth + 1);
    }
  }
  return out;
}

// Cheap enough to run on every reply, so the gateway asks brokerd only about
// a reply that could possibly be an echo.
function echoCandidate(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.length > MAX_CHARS) return false;
  if (QUESTION_RE.test(t) || URL_RE.test(t)) return false;
  return t.split('\n').filter((l) => l.trim()).length <= MAX_LINES;
}

function echoOnly(text, vocab) {
  if (!echoCandidate(text)) return false;
  const known = new Set((Array.isArray(vocab) ? vocab : []).flatMap(wordsOf));
  const has = (w) => FILLER.has(w) || known.has(w);
  for (const w of wordsOf(text)) {
    if (has(w)) continue;
    // A digit the title did not hold is an hour, a date, a count — something
    // Olma is telling them. Never stripped of a prefix into a known word.
    if (DIGIT_RE.test(w)) return false;
    const m = HE_PREFIX_RE.exec(w);
    if (m && has(m[1])) continue;
    return false;
  }
  return true;
}

module.exports = { echoOnly, echoCandidate, vocabOf, wordsOf, FILLER, MAX_CHARS, MAX_LINES };
