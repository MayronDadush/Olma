'use strict';
// Which meal the words sent WITH a photo name, when the agent did not pass
// one. On 2026-10-08 "זה מה שאכלתי היום בבוקר" reached see_meal_photo as its
// note, no `meal` came with it, and the salad was filed as dinner because the
// clock said 19:12. The note was in front of the server the whole time.
//
// Code, not a model: a word is a closed list, and a guess never acts. One
// meal named is that meal; none, or two ("breakfast leftovers for dinner"), is
// null, and the caller falls back to the hour as it always did.
const ROOTS = {
  breakfast: ['בוקר', 'breakfast'],
  lunch: ['צהריים', 'צהרים', 'lunch'],
  dinner: ['ערב', 'dinner', 'supper'],
  snack: ['נשנוש', 'נשנושים', 'נשנשתי', 'חטיף', 'snack'],
};
// One-letter Hebrew prefixes, at most two of them: ב־בוקר, הבוקר, וּבערב,
// לצהריים. Every split is tried, because a root can begin with a prefix
// letter ("בבוקר" is ב + בוקר, not בב + וקר). Matching whole words is what
// keeps "סלט מעורב" from being dinner.
const PREFIX = 'ובהלמשכ';
const stems = w => [w, ...[1, 2].filter(k => w.length > k + 2 && [...w.slice(0, k)].every(c => PREFIX.includes(c))).map(k => w.slice(k))];

function slotFromNote(note) {
  if (typeof note !== 'string' || !note.trim()) return null;
  const words = note.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const found = new Set();
  for (const w of words) {
    for (const [slot, roots] of Object.entries(ROOTS)) {
      if (stems(w).some(x => roots.includes(x))) found.add(slot);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

module.exports = { slotFromNote };
