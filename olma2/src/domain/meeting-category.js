'use strict';
// A coordination's category (owner, 2026-10-04/05). Its OWN vocabulary, not
// the tasks': a coordination is people meeting, so home, money, errands and
// health never fit one (owner: "רק כאלה שנושאים שקשורים לתיאומים"). Five
// topics, plus 'none':
//
//   work · family · social (חברים) · sport · games
//
// Food and outings (coffee, dinner, a movie, a party) are 'social' — the owner
// chose five over seven.
//
// Automatic by default and decided at READ time, off the name and then the
// place: no column to go stale, so a rename re-sorts it. A person may pick one
// instead (`meetings.category`, migration 109); 'none' is a choice too.
//
// Keyword-only, for the reason task-category.js gives: no model turn, no bill.
// The same discipline too — a stem earns its place only if it is hard to read
// as anything else, and a wrong category is worse than none. Bare "פגישה" /
// "meeting" / "משחק" are out on purpose (a meeting is any of these, and
// "משחק כדורגל" is sport), and so are "חברה"/"חבר׳ה" (the geresh is
// normalised away, and then it is "a company"), "רמי" (rummy, and a name),
// "סקי" (inside סקירה), "ספק" and "דמו" (inside ordinary words).

const CATEGORIES = ['work', 'family', 'social', 'sport', 'games'];
const CHOICES = new Set([...CATEGORIES, 'none']);

const HE = /[֐-׿]/;
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normaliseText(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[׳״'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
// Hebrew glues prepositions onto the front of a word (לפוקר, בפאדל), so Hebrew
// stems match as substrings; English stems are whole words, plural allowed
// ("mom" is not "moment", "ski" is not "skills").
function stemToRe(stem) {
  const s = normaliseText(stem);
  return HE.test(s) ? new RegExp(escapeRe(s)) : new RegExp(`\\b${escapeRe(s)}(s|es)?\\b`);
}

// Order is load-bearing: the first rule that matches wins. Games before sport
// before social, so "ערב פוקר" is games and "כדורגל ובירה" is sport; family
// before social, so "ארוחת שישי אצל אמא" is family; work before social, so
// "ארוחת צהריים עם לקוח" is work.
const RULES = [
  ['games', [
    'פוקר', 'ערב משחקים', 'משחקי קופסה', 'משחק קופסה', 'קטאן', 'שש בש', 'ברידג',
    'טאקי', 'שחמט', 'בלאק גק', 'בלאקגק',
    'poker', 'game night', 'board game', 'catan', 'backgammon', 'bridge night',
    'chess', 'blackjack',
  ]],
  ['sport', [
    'פאדל', 'טניס', 'כדורגל', 'כדורסל', 'כדורעף', 'ריצה', 'לרוץ', 'שחייה', 'לשחות',
    'אימון', 'חדר כושר', 'כושר', 'יוגה', 'פילאטיס', 'אופניים', 'רכיבה',
    'גלישה', 'ספורט', 'קרוספיט', 'באולינג',
    'padel', 'tennis', 'football', 'soccer', 'basketball', 'volleyball', 'running',
    'gym', 'workout', 'yoga', 'pilates', 'cycling', 'climbing', 'surfing', 'skiing',
    'sport', 'crossfit', 'bowling',
  ]],
  ['family', [
    'אמא', 'אבא', 'סבתא', 'סבא', 'משפחה', 'משפחתי', 'הורים', 'יום הולדת',
    'יום ההולדת', 'חתונה', 'בר מצווה', 'בת מצווה', 'ברית מילה', 'אחיין', 'דודה',
    'ארוחת שישי', 'ארוחת חג', 'ליל הסדר',
    'mom', 'mum', 'dad', 'grandma', 'grandpa', 'family', 'parents', 'birthday',
    'wedding', 'cousin',
  ]],
  ['work', [
    'ישיבה', 'ישיבת', 'לקוח', 'ראיון', 'משרד', 'עבודה', 'פרויקט', 'מצגת', 'צוות',
    'הנהלה', 'שיחת עבודה', 'משקיע',
    'work', 'client', 'interview', 'office', 'project', 'presentation', 'standup',
    'sprint', 'team', 'demo', 'investor', 'board meeting',
  ]],
  ['social', [
    'קפה', 'ארוחה', 'ארוחת', 'בראנץ', 'בירה', 'מסיבה', 'מסיבת', 'על האש', 'מנגל',
    'ברביקיו', 'פיקניק', 'סרט', 'קולנוע', 'הופעה', 'חברים', 'טיול', 'פאב',
    'coffee', 'dinner', 'lunch', 'brunch', 'drinks', 'beer', 'party', 'bbq',
    'barbecue', 'picnic', 'movie', 'cinema', 'concert', 'friends', 'hangout', 'trip',
  ]],
].map(([cat, stems]) => [cat, stems.map(stemToRe)]);

function classify(text) {
  const hay = normaliseText(text);
  if (!hay) return null;
  for (const [cat, res] of RULES) {
    if (res.some((re) => re.test(hay))) return cat;
  }
  return null;
}

// What the page and the chat show: the person's choice when there is one,
// otherwise the guess. `auto` (we guessed one) is what lets the page say
// "עולמה בחרה"; `chosen` tells a 'none' somebody picked from a 'none' nobody
// could read — the first is an answer, the second an offer to pick.
function categoryOf({ category, title, location }) {
  if (category && CHOICES.has(category)) return { category, auto: false, chosen: true };
  const guessed = classify(title) || classify(location);
  return { category: guessed || 'none', auto: Boolean(guessed), chosen: false };
}

// A choice coming in from a person. `auto` (or null) clears it back to the
// guess; anything else must be a key — never free text, the lesson
// tasks.category learned with thirteen vocabularies in one column.
function normaliseChoice(value) {
  if (value === null || value === undefined || value === '' || value === 'auto') return { ok: true, value: null };
  const v = String(value).trim().toLowerCase();
  return CHOICES.has(v) ? { ok: true, value: v } : { ok: false };
}

module.exports = { CATEGORIES, categoryOf, normaliseChoice, classify };
