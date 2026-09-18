'use strict';
// ── Is this the same thing they already have? ────────────────────────────────
//
// `tasks.normaliseTitle` answers that for a CHARACTER-identical title and
// deliberately stops there ("no fuzzy matching", tasks.js) — it was written
// against 21 production pairs that were all identical, and a judgement about
// two sentences is not a thing to guess at. This file is that judgement, and
// the only reason it exists is that it was not guessed: every threshold below
// was read off 86 real pairs from the box, labelled one by one by the owner
// on 2026-09-18 (the sheet and the labels are in `docs/incidents.md`,
// "התיק לבית חולים"). What the labelling changed about the plan is worth more
// than the numbers:
//
//   1. A SHARED DUE MOMENT IS NOT EVIDENCE. The first scorer added 0.25 when
//      two tasks were due within the hour of each other. 17 pairs got that
//      lift and the owner said "leave them alone" to 15 — every high-scoring
//      pair he rejected scored high because of the bonus and not because of
//      the words ("לעשות צ׳ק אין לטיסה" against "לעשות ביטוח נסיעות", both at
//      the same hour; five separate טפסים). Two tasks set for the same moment
//      are two things said in one breath, which is the opposite of one thing
//      said twice. The bonus is gone and the score is word overlap alone.
//
//   2. A WEEKDAY OR A CLOCK IN BOTH TITLES MEANS NEVER. "משמרת עבודה - יום
//      ראשון 16:00-22:00" and "משמרת עבודה - יום שלישי 07:00-16:00" overlap on
//      0.56 of their words, because everything except the part that matters is
//      shared. Six such pairs, every one rejected, and nothing else in the
//      corpus carries the shape — so this is a refusal and not a penalty.
//
//   3. ONE THRESHOLD THEN REPRODUCES THE ANSWERS — word overlap at 0.50,
//      with one guard below it (`disagrees`). 69 of the 80 pairwise labels,
//      and NOT ONE merge of a pair he marked "don't touch".
//
// What it CANNOT do is a rewording — "לסחוב לברכה ליום הולדת" against "לכתוב
// ברכה ליום הולדת", "להשים למאיה במקום את המטען" against "להשאיר למאיה את
// המטען". Eight pairs he would merge are left alone, most of them under the
// line at 0.33-0.44, and lowering the line to reach them starts merging rows
// he rejected. They are misses on purpose, and `KNOWN_MISSES` in the test
// names every one — a change that fixes one is a change somebody made
// deliberately, not a threshold that drifted.
//
// The six he marked "a list inside one task" (the pills, the pension forms)
// are NOT a pairwise judgement and nothing here claims them: four of the six
// share one word out of eight. That belongs to a grouping pass over somebody's
// whole open list, offered once — never to a check at the moment of writing.
const TASK_SIMILARITY_MERGE_AT = 0.5;

// Filler that says nothing about WHAT the task is. Kept short on purpose: a
// stop list is a place where a real word goes to be ignored, and "מים" losing
// to "לשתות" is how a scorer starts matching everything.
const STOP = new Set([
  'את', 'של', 'עם', 'על', 'לי', 'לו', 'לה', 'אני', 'זה', 'כל', 'יש', 'אם',
  'גם', 'או', 'עד', 'לא', 'the', 'a', 'to', 'for', 'and', 'my',
]);

// A title that IS the request for a reminder — "להזכיר לי מחר בבוקר ב-9 עם
// רשימת האריזה לתיק לבית חולים" — is the shape that opened this whole thread:
// the extraction pass read מאיה's sentence asking for a 09:00 reminder and
// saved the sentence as a second task beside the one the live tool had already
// captured. Stripping the request and the time expression leaves the thing
// itself, which is what has to be compared.
const REMIND_RE = /^\s*(?:ל?ה?זכיר|תזכיר[יה]?|תזכורת|remind)\s*(?:לי|לו|לה|me)?\s*/u;
const TIME_RE = /(?:היום|מחר|מחרתיים|בבוקר|בערב|בצהריים|בלילה|ביום\s+\S+|ב-?\d{1,2}(?::\d{2})?|at\s+\d{1,2}(?::\d{2})?|tomorrow|today)/gu;

// Hebrew attaches ה/ו/ב/ל/מ/ש/כ to the front of a word, so "לתרופות" and
// "תרופות" are the same word wearing a preposition. Stripped only when three
// letters survive it — otherwise "מים" becomes "ים".
const PREFIX_RE = /^(ה|ו|ב|ל|מ|ש|כ)(?=.{3,})/u;

function normalise(title) {
  const s = String(title == null ? '' : title)
    .toLowerCase()
    .replace(REMIND_RE, '')
    .replace(TIME_RE, ' ')
    .replace(/["'׳״,.!?()\-–—:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.split(' ')
    .map((w) => w.replace(PREFIX_RE, ''))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

// Jaccard: shared words over the words either of them used. Length-fair in
// both directions, which matters because half of what this compares is one
// title that extends another.
function textScore(a, b) {
  const A = new Set(normalise(a));
  const B = new Set(normalise(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

// `-` and `,` end a weekday because a shift is written "משמרת - שלישי
// 07:00-16:00"; the lookahead keeps שבת out of "שבתאי".
const WEEKDAY_RE = /(?:^|\s)(?:יום\s+)?(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)(?=\s|$|,|-)/u;
const CLOCK_RE = /\d{1,2}:\d{2}/;

// Both naming a weekday, or both naming a clock time: two entries off the same
// recurring template, and the only thing that separates them is exactly the
// part a word count treats as noise. One of them naming a time is fine and
// common — "משחק פאדל עם יובל" against "משחק פאדל עם יובל מחר בשעה 18:00" is
// one game, and the owner merged it.
function namesRecurringSlot(a, b) {
  return (WEEKDAY_RE.test(a) && WEEKDAY_RE.test(b))
    || (CLOCK_RE.test(a) && CLOCK_RE.test(b));
}

// Levenshtein, small and local: the only thing it is asked is whether two
// words are the same word misspelt. `ריבון` against `ריבה` is two edits and
// one medicine; `ריבון` against `בלוטה` is five and two.
function editDistance(a, b) {
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}
const sameWordTwice = (a, b) => editDistance(a, b) <= 2 || a.startsWith(b) || b.startsWith(a);

// Each side carrying a word the other does not is the two titles DISAGREEING
// about something, and "לקחת כדור ריבון" against "לקחת כדור לבלוטה" is what
// that costs when it is ignored: 0.50 of the words shared — לקחת, כדור — and
// the word that is not shared is the entire point. Two medicines, and the
// owner's answer for them was never a merge but a list inside one task.
// Containment is the other case and stays allowed: "ללכת לשתות מים" against
// "לשתות מים" has a word on one side only, which is somebody saying the same
// thing at a different length.
//
// It costs three merges he would have made — "לסחוב לברכה" against "לכתוב
// ברכה" among them — and it is still the right trade, because a merge that
// loses one of two real things is the only error here nobody can see.
function disagrees(a, b) {
  const A = new Set(normalise(a));
  const B = new Set(normalise(b));
  const onlyA = [...A].filter((w) => !B.has(w));
  const onlyB = [...B].filter((w) => !A.has(w));
  if (!onlyA.length || !onlyB.length) return false;
  return !onlyA.some((x) => onlyB.some((y) => sameWordTwice(x, y)));
}

// Silent only when nothing was rewritten. The owner's rule (2026-09-18): an
// identical title is one thing said twice and a 👍 covers it, while any
// difference in the words is Olma choosing which of two sentences survives —
// "ביטוח נסיעות לשנינו" against "ביטוח נסיעות (עם מאיה)", "אוזניות טובות
// יותר" against "אוזניות שמתאימות למכשיר שמיעה" — and a choice the person
// might not share has to be said out loud. It costs sixteen short sentences
// across the corpus for no silent merge he did not know about, and that is the
// cheap direction to be wrong in.
function compare(a, b) {
  if (namesRecurringSlot(a, b)) return { text: 0, same: false, silent: false, reason: 'recurring_slot' };
  const text = textScore(a, b);
  if (text < TASK_SIMILARITY_MERGE_AT) return { text, same: false, silent: false, reason: 'different' };
  if (disagrees(a, b)) return { text, same: false, silent: false, reason: 'disagree' };
  const words = (t) => normalise(t).slice().sort().join(' ');
  const silent = words(a) === words(b);
  return { text, same: true, silent, reason: silent ? 'identical' : 'reworded' };
}

// The list to compare against: their own, top level only (a checklist item is
// not a thing anybody is saving twice) and never the row being checked.
// Returns the BEST match, because a title can be close to two rows and only
// one answer is useful.
//
// `doneWithinHours` widens it to things they have already TICKED OFF, and it
// exists for one caller. `tasks.openTitles` is open-only on purpose and the
// reasoning holds for a person typing: ביטוח נסיעות, ticked off in the morning
// and set again that evening for a new trip, is somebody doing a thing twice.
// It does not hold for the extraction pass, which reads a conversation
// hours after the fact and has no way to mean "again" — "להעיר את מאיה" was
// completed two minutes after it was created and written back forty-two
// minutes later off the same conversation. So the window is the CALLER's
// judgement, not this file's, and it is open by default.
async function findTwin(client, ownerId, title, { excludeId = null, doneWithinHours = 0 } = {}) {
  const { rows } = await client.query(
    `SELECT id, title, due_at, status, completed_at FROM tasks
      WHERE owner_id = $1 AND archived_at IS NULL AND parent_id IS NULL
        AND ($2::bigint IS NULL OR id <> $2::bigint)
        AND (status = 'open'
             OR ($3::int > 0 AND status = 'done'
                 AND completed_at > now() - ($3::int * interval '1 hour')))`,
    [ownerId, excludeId, doneWithinHours]
  );
  let best = null;
  for (const row of rows) {
    const verdict = compare(title, row.title);
    if (!verdict.same) continue;
    // An open row always beats a completed one at equal closeness: it is the
    // row they would have to look at.
    const better = !best || verdict.text > best.text
      || (verdict.text === best.text && row.status === 'open' && best.task.status !== 'open');
    if (better) best = { ...verdict, task: row };
  }
  return best;
}

module.exports = {
  disagrees,
  normalise, textScore, namesRecurringSlot, compare, findTwin,
  MERGE_AT: TASK_SIMILARITY_MERGE_AT,
};
