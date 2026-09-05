'use strict';
// tasks.category, decided here in code — no model turn, no tokens.
//
// The dashboard has documented this column as a closed set since it was
// designed: "TASKCATS → tasks.category — a CLOSED set here because the server
// validates it as one (like KNOWN_CONNECTION_FEATURES), not a free-text
// field". The server never did. What production actually held on 2026-09-04,
// across 61 rows: 25 NULL, then `בריאות`, `עבודה`, `personal`, `משפחה`,
// `קניות`, `בית`, `זוגי`, `מטבח`, `טיסה`, `חברתי`, `none`, `משכך` and
// `דברים שצריך לעשות` — thirteen vocabularies for one column, several of
// them a single task's noun rather than a category at all. Nothing could
// group, filter or colour by that, which is why the page showed every task
// as uncategorised: not one of those strings was a key it knew.
//
// So this is the promised validator, plus the guess that makes it useful. The
// guess is deliberately KEYWORD-ONLY. An LLM would classify better, but every
// task added would then depend on a billing account — the exact coupling the
// 2026-08-23 credit outage removed from reminders (`proactive-text.js`), and
// a category is worth far less than a reminder.
//
// The cost of keywords is that they are sometimes wrong, and a WRONG category
// is worse than none: it hides a task under a heading the person does not
// look at. Every rule here is therefore conservative — a stem earns its place
// only if it is hard to read as anything else. Bare `פגישה` / `meeting` is
// absent on purpose (a meeting is as often a friend as a client), and so are
// `אח`, `בן`, `בת` and `גן`, which are substrings of a dozen ordinary words.
// `none` is a perfectly good answer.

const CATEGORIES = ['home', 'work', 'family', 'health', 'money', 'errands'];
const CATEGORY_SET = new Set(CATEGORIES);

// Hebrew glues its prepositions and articles onto the front of a word — לרופא,
// בעבודה, מהבית, שהילדים — so a word-boundary match finds almost nothing. The
// stems below are matched as plain substrings for that reason, which is safe
// only because they are long and distinctive; that is the whole discipline of
// the list. English stems get real boundaries, where they work.
const HE = /[֐-׿]/;

function stemToRe(stem) {
  if (HE.test(stem)) return new RegExp(escapeRe(stem));
  return new RegExp(`\\b${escapeRe(stem)}`, 'i');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Order is load-bearing: the first rule that matches wins, so a compound that
// contains a more general stem has to be judged before it. `בית חולים` is a
// hospital and `בית ספר` is a school; both contain `בית`, which is why home
// sits last. `חשבונית` (an invoice, work) contains `חשבון` (a bill, money),
// which is why work sits before money.
const RULES = [
  ['health', [
    'בית חולים', 'בית החולים', 'רופא', 'רופאה', 'דוקטור', 'שיניים', 'מרפאה',
    'קופת חולים', 'בדיקת דם', 'בדיקות דם', 'חיסון', 'תרופה', 'תרופות', 'מרשם',
    'פיזיותרפ', 'פסיכולוג', 'משכך', 'ניתוח', 'אמבולנס', 'מד"א', 'אופטומטר',
    'בריאות', 'חדר כושר', 'אימון', 'יוגה', 'דיאט', 'מכבי', 'כללית', 'מאוחדת',
    'doctor', 'dentist', 'clinic', 'hospital', 'pharmacy', 'prescription',
    'medicine', 'meds', 'vaccine', 'therapy', 'physio', 'checkup', 'check-up',
    'blood test', 'gym', 'workout', 'health',
  ]],
  ['family', [
    'בית ספר', 'בית הספר', 'ביה"ס', 'גן ילדים', 'ילד', 'הורים', 'אסיפת הורים',
    'אמא', 'אבא', 'סבתא', 'סבא', 'משפחה', 'משפחתי', 'יום הולדת', 'חתונה',
    'בר מצווה', 'בת מצווה', 'ברית מילה', 'אשתי', 'בעלי', 'בן זוג', 'בת זוג',
    'school', 'kindergarten', 'daycare', 'nursery', 'parents', 'kids',
    'children', 'mom', 'mum', 'dad', 'grandma', 'grandpa', 'birthday',
    'wedding', 'family', 'wife', 'husband',
  ]],
  ['work', [
    'משמרת', 'משמרות', 'עבודה', 'ישיבה', 'ישיבת', 'לקוח', 'חשבונית',
    'הצעת מחיר', 'מצגת', 'פרזנטציה', 'פרויקט', 'דדליין', 'ראיון', 'קורות חיים',
    'משרד', 'מנהל', 'סיכום פגישה', 'שיפט',
    'shift', 'work', 'client', 'invoice', 'presentation', 'deadline',
    'standup', 'stand-up', 'sprint', 'interview', 'resume', 'office',
    'manager', 'boss', 'project',
  ]],
  ['money', [
    'שכר דירה', 'שכירות', 'ארנונה', 'חשבון חשמל', 'חשבונות', 'חשבון',
    'משכנתא', 'הלוואה', 'ביטוח', 'לשלם', 'תשלום', 'העברה בנקאית', 'בנק',
    'כרטיס אשראי', 'אשראי', 'מס הכנסה', 'מיסים', 'רואה חשבון', 'פנסיה',
    'חיסכון', 'כספים', 'כסף',
    'rent', 'mortgage', 'loan', 'bank', 'bill', 'bills', 'payment',
    'insurance', 'tax', 'taxes', 'salary', 'budget', 'credit card',
    'pension', 'savings', 'money',
  ]],
  ['errands', [
    'סופרמרקט', 'סופר', 'מכולת', 'קניות', 'לקנות', 'שופרסל', 'רמי לוי',
    'אושר עד', 'יינות ביתן', 'ויקטורי', 'טיב טעם', 'דואר', 'חבילה',
    'לאסוף', 'משלוח', 'תספורת', 'מספרה', 'מוסך', 'טסט', 'דלק', 'לתדלק',
    'מכבסה', 'ניקוי יבש', 'סידורים', 'ציפורניים', 'מניקור', 'פדיקור',
    'groceries', 'grocery', 'supermarket', 'shopping', 'buy ', 'pick up',
    'pickup', 'package', 'parcel', 'post office', 'haircut', 'barber',
    'laundromat', 'dry clean', 'errand', 'manicure', 'pedicure', 'nail',
  ]],
  ['home', [
    'ניקיון', 'נקיון', 'לנקות', 'כביסה', 'מדיח', 'לסדר', 'סדר בבית', 'לשאוב',
    'שואב אבק', 'מטבח', 'אמבטיה', 'גינה', 'לגזום', 'אינסטלטור', 'חשמלאי',
    'נגר', 'שיפוץ', 'רהיטים', 'איקאה', 'מצעים', 'זבל', 'אשפה', 'בבית', 'בית',
    'clean', 'cleaning', 'laundry', 'dishes', 'dishwasher', 'tidy',
    'vacuum', 'kitchen', 'bathroom', 'garden', 'plumber', 'electrician',
    'handyman', 'furniture', 'ikea', 'trash', 'garbage', 'household',
  ]],
];

const COMPILED = RULES.map(([cat, stems]) => [cat, stems.map(stemToRe)]);

function normaliseText(s) {
  return String(s || '')
    .replace(/[֑-ׇ]/g, '')   // niqqud and cantillation
    .replace(/[׳״'"׳״]/g, '') // geresh/gershayim, so מד"א matches מדא too
    .replace(/\s+/g, ' ')
    .trim();
}

// A stem list matched against a string with the punctuation already gone. The
// `מד"א` style entries are normalised the same way the text is, so both sides
// lose their quote marks together rather than only one of them.
function classifyText(text) {
  const hay = normaliseText(text).toLowerCase();
  if (!hay) return null;
  for (const [cat, res] of COMPILED) {
    for (const re of res) {
      if (re.test(hay)) return cat;
    }
  }
  return null;
}

// What an agent (or an old row) already wrote. `בריאות` and `health` are the
// same category and both have to land on the key, or normalising production
// would throw away information we can plainly read.
function normaliseCategory(value) {
  const raw = normaliseText(value).toLowerCase();
  if (!raw) return null;
  if (CATEGORY_SET.has(raw)) return raw;
  return classifyText(raw);
}

// The one entry point the write paths use.
//
// Returns { category, auto }. `auto: true` means WE chose it and the page may
// say so ("עולמה בחרה"), which is also the permission to overwrite it later
// without arguing with a person's own choice — a field the writer sets and the
// reader ignores is worse than no field, so `auto` exists to be read.
function decideCategory({ category, title }) {
  const given = normaliseCategory(category);
  if (given && CATEGORY_SET.has(given)) {
    // It came in as a real key, unchanged — the caller meant it.
    if (normaliseText(category).toLowerCase() === given) return { category: given, auto: false };
    // It came in as `בריאות` or `משכך`; we picked the key, so we own it.
    return { category: given, auto: true };
  }
  const guessed = classifyText(title);
  return { category: guessed, auto: Boolean(guessed) };
}

module.exports = {
  CATEGORIES, decideCategory, normaliseCategory, classifyText,
};
