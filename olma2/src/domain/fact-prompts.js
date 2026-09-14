'use strict';
// The questions the profile page offers, three at a time, so a person can tell
// Olma about themselves without waiting for a conversation to get there
// (owner, 2026-09-14: "Olma gives three facts the user can complete about
// themselves", with a v to save each).
//
// The SERVER composes the fact, never the browser. A page that posted fact
// text would be a free-text door into USER.md — the file injected into every
// turn — from a cookie; here the page sends an answer in a fixed shape, this
// file checks it against the question it claims to answer, and writes a line
// in one known form. Every guard in domain/facts.js still runs on the result.
//
// Each fact is written as "label: value". That is not laziness about grammar:
// Hebrew inflects "works", "studies", "lives" for gender, a fact is third
// person about THEM (facts.firstPerson refuses anything else), and a label
// needs no verb. It also reads well on the card, where it lands as
// `- [work] שעות עבודה: 09:00–17:00`.
//
// `key` is stored on the fact (user_facts.prompt_key, migration 068). A key
// with an active fact is a question already answered; delete the fact and the
// question comes back. The order below is the order they are offered — the
// ones that change what Olma DOES (hours, days, shifts) first, the ones that
// only make her sound like she has been listening after.
const { ok, err } = require('./results');
const facts = require('./facts');

const DAYS = {
  he: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

const MAX_TEXT = 60;

// type:
//   range   two times          answer { from: "HH:MM", to: "HH:MM" }
//   time    one time           answer { time: "HH:MM" }
//   choice  one of `options`   answer { value: "<option id>" }
//   days    weekdays           answer { days: [0..6] }
//   text    a short phrase     answer { text: "..." }
const PROMPTS = [
  // ---- work: what changes when Olma writes -----------------------------------
  { key: 'work_hours', category: 'work', type: 'range',
    q: { he: 'מה שעות העבודה שלך?', en: 'What are your working hours?' },
    label: { he: 'שעות עבודה', en: 'Working hours' } },
  { key: 'work_pattern', category: 'work', type: 'choice',
    q: { he: 'איך בנויה העבודה שלך?', en: 'How is your work structured?' },
    label: { he: 'מבנה העבודה', en: 'Work pattern' },
    options: [
      { id: 'fixed', he: 'שעות קבועות', en: 'Fixed hours' },
      { id: 'shifts', he: 'משמרות', en: 'Shifts' },
      { id: 'varies', he: 'משתנה', en: 'It varies' },
      { id: 'none', he: 'ללא עבודה כרגע', en: 'Not working right now' },
    ] },
  { key: 'work_days', category: 'work', type: 'days',
    q: { he: 'באילו ימים בשבוע יש עבודה?', en: 'Which days of the week do you work?' },
    label: { he: 'ימי עבודה', en: 'Work days' } },
  { key: 'work_place', category: 'work', type: 'choice',
    q: { he: 'מאיפה עובדים?', en: 'Where do you work from?' },
    label: { he: 'מקום העבודה', en: 'Works from' },
    options: [
      { id: 'office', he: 'מהמשרד', en: 'The office' },
      { id: 'home', he: 'מהבית', en: 'Home' },
      { id: 'hybrid', he: 'היברידי', en: 'Hybrid' },
      { id: 'field', he: 'בשטח', en: 'On the road' },
    ] },
  { key: 'occupation', category: 'work', type: 'text',
    q: { he: 'מה תחום העיסוק שלך?', en: 'What do you do for work?' },
    label: { he: 'תחום עיסוק', en: 'Occupation' },
    ph: { he: 'למשל: מורה, מתכנת, עצמאית', en: 'e.g. teacher, developer, freelancer' } },
  { key: 'busy_days', category: 'work', type: 'days',
    q: { he: 'מה הימים הכי עמוסים בשבוע?', en: 'Which days are your busiest?' },
    label: { he: 'הימים העמוסים בשבוע', en: 'Busiest days' } },
  { key: 'meeting_time', category: 'habits', type: 'choice',
    q: { he: 'מתי הכי נוח לקבוע פגישות?', en: 'When do meetings suit you best?' },
    label: { he: 'זמן מועדף לפגישות', en: 'Preferred time for meetings' },
    options: [
      { id: 'morning', he: 'בוקר', en: 'Morning' },
      { id: 'noon', he: 'צהריים', en: 'Midday' },
      { id: 'afternoon', he: 'אחר הצהריים', en: 'Afternoon' },
      { id: 'evening', he: 'ערב', en: 'Evening' },
    ] },
  { key: 'commute', category: 'work', type: 'choice',
    q: { he: 'איך מגיעים לעבודה?', en: 'How do you get to work?' },
    label: { he: 'הגעה לעבודה', en: 'Commute' },
    options: [
      { id: 'car', he: 'ברכב', en: 'By car' },
      { id: 'transit', he: 'בתחבורה ציבורית', en: 'Public transport' },
      { id: 'bike', he: 'באופניים או קורקינט', en: 'Bike or scooter' },
      { id: 'walk', he: 'ברגל', en: 'On foot' },
      { id: 'none', he: 'אין נסיעה', en: 'No commute' },
    ] },

  // ---- the shape of a day ------------------------------------------------------
  { key: 'wake_time', category: 'habits', type: 'time',
    q: { he: 'באיזו שעה בדרך כלל קמים?', en: 'What time do you usually get up?' },
    label: { he: 'שעת קימה רגילה', en: 'Usually up at' } },
  { key: 'sleep_time', category: 'habits', type: 'time',
    q: { he: 'ובאיזו שעה הולכים לישון?', en: 'And what time do you usually go to sleep?' },
    label: { he: 'שעת שינה רגילה', en: 'Usually asleep by' } },
  { key: 'focus_time', category: 'habits', type: 'choice',
    q: { he: 'מתי הריכוז הכי טוב?', en: 'When do you focus best?' },
    label: { he: 'שעות הריכוז הטובות', en: 'Focuses best' },
    options: [
      { id: 'morning', he: 'בבוקר', en: 'In the morning' },
      { id: 'noon', he: 'בצהריים', en: 'Around midday' },
      { id: 'evening', he: 'בערב', en: 'In the evening' },
      { id: 'night', he: 'בלילה', en: 'At night' },
    ] },
  { key: 'workout_days', category: 'habits', type: 'days',
    q: { he: 'באילו ימים יש אימון?', en: 'Which days do you work out?' },
    label: { he: 'ימי אימון', en: 'Workout days' } },
  { key: 'sport', category: 'habits', type: 'text',
    q: { he: 'איזה ספורט עושים?', en: 'What kind of exercise do you do?' },
    label: { he: 'ספורט', en: 'Exercise' },
    ph: { he: 'למשל: ריצה, יוגה, חדר כושר', en: 'e.g. running, yoga, the gym' } },
  { key: 'shopping_day', category: 'habits', type: 'days',
    q: { he: 'יש יום קבוע לקניות?', en: 'Is there a regular day for groceries?' },
    label: { he: 'יום הקניות', en: 'Grocery day' } },

  // ---- home and family -----------------------------------------------------
  { key: 'relationship', category: 'family', type: 'choice',
    q: { he: 'מה המצב המשפחתי?', en: 'Relationship status?' },
    label: { he: 'מצב משפחתי', en: 'Relationship' },
    options: [
      { id: 'single', he: 'לא בזוגיות', en: 'Single' },
      { id: 'partner', he: 'בזוגיות', en: 'In a relationship' },
      { id: 'married', he: 'נשואים', en: 'Married' },
    ] },
  { key: 'partner_name', category: 'people', type: 'text',
    q: { he: 'איך קוראים לבן או לבת הזוג?', en: 'What is your partner’s name?' },
    label: { he: 'שם בן/בת הזוג', en: 'Partner’s name' },
    ph: { he: 'שם פרטי', en: 'First name' } },
  { key: 'kids', category: 'family', type: 'choice',
    q: { he: 'יש ילדים?', en: 'Do you have children?' },
    label: { he: 'ילדים', en: 'Children' },
    options: [
      { id: '0', he: 'אין', en: 'None' },
      { id: '1', he: 'ילד אחד', en: 'One' },
      { id: '2', he: 'שניים', en: 'Two' },
      { id: '3', he: 'שלושה', en: 'Three' },
      { id: '4+', he: 'ארבעה ומעלה', en: 'Four or more' },
    ] },
  { key: 'kids_ages', category: 'family', type: 'text',
    q: { he: 'בני כמה הילדים?', en: 'How old are the children?' },
    label: { he: 'גילאי הילדים', en: 'Children’s ages' },
    ph: { he: 'למשל: 4 ו־9', en: 'e.g. 4 and 9' } },
  { key: 'pets', category: 'family', type: 'choice',
    q: { he: 'יש חיית מחמד?', en: 'Any pets?' },
    label: { he: 'חיית מחמד', en: 'Pets' },
    options: [
      { id: 'none', he: 'אין', en: 'None' },
      { id: 'dog', he: 'כלב', en: 'A dog' },
      { id: 'cat', he: 'חתול', en: 'A cat' },
      { id: 'other', he: 'אחר', en: 'Something else' },
    ] },
  { key: 'home_city', category: 'context', type: 'text',
    q: { he: 'באיזו עיר גרים?', en: 'Which city do you live in?' },
    label: { he: 'עיר מגורים', en: 'Lives in' },
    ph: { he: 'שם העיר', en: 'City' } },
  { key: 'car', category: 'context', type: 'choice',
    q: { he: 'יש רכב זמין?', en: 'Do you have a car?' },
    label: { he: 'רכב', en: 'Car' },
    options: [
      { id: 'yes', he: 'יש רכב', en: 'Has a car' },
      { id: 'shared', he: 'רכב משותף', en: 'A shared car' },
      { id: 'no', he: 'אין רכב', en: 'No car' },
    ] },

  // ---- who they are --------------------------------------------------------
  { key: 'languages', category: 'context', type: 'text',
    q: { he: 'באילו שפות מדברים?', en: 'Which languages do you speak?' },
    label: { he: 'שפות', en: 'Languages' },
    ph: { he: 'למשל: עברית, אנגלית', en: 'e.g. Hebrew, English' } },
  { key: 'diet', category: 'habits', type: 'choice',
    q: { he: 'יש העדפה בתזונה?', en: 'Any dietary preference?' },
    label: { he: 'תזונה', en: 'Diet' },
    options: [
      { id: 'any', he: 'אוכלים הכול', en: 'Eats everything' },
      { id: 'kosher', he: 'כשר', en: 'Kosher' },
      { id: 'vegetarian', he: 'צמחוני', en: 'Vegetarian' },
      { id: 'vegan', he: 'טבעוני', en: 'Vegan' },
      { id: 'glutenfree', he: 'ללא גלוטן', en: 'Gluten-free' },
    ] },
  { key: 'hobbies', category: 'habits', type: 'text',
    q: { he: 'מה עושים בזמן הפנוי?', en: 'What do you do in your free time?' },
    label: { he: 'תחביבים', en: 'Hobbies' },
    ph: { he: 'למשל: בישול, טיולים', en: 'e.g. cooking, hiking' } },
  { key: 'studying', category: 'plans', type: 'choice',
    q: { he: 'לומדים משהו עכשיו?', en: 'Are you studying anything right now?' },
    label: { he: 'לימודים', en: 'Studying' },
    options: [
      { id: 'no', he: 'לא כרגע', en: 'Not right now' },
      { id: 'degree', he: 'תואר', en: 'A degree' },
      { id: 'course', he: 'קורס', en: 'A course' },
      { id: 'self', he: 'לבד', en: 'On their own' },
    ] },
  { key: 'current_goal', category: 'plans', type: 'text',
    q: { he: 'על מה הכי חשוב לך להתקדם בתקופה הקרובה?', en: 'What matters most to move forward on lately?' },
    label: { he: 'המטרה לתקופה הקרובה', en: 'Current goal' },
    ph: { he: 'במשפט אחד', en: 'In one line' } },
  { key: 'reminder_style', category: 'habits', type: 'choice',
    q: { he: 'איך הכי קל לא לשכוח דברים?', en: 'What helps you not forget things?' },
    label: { he: 'מה עוזר לזכור', en: 'Remembers best with' },
    options: [
      { id: 'early', he: 'תזכורת מראש', en: 'An early heads-up' },
      { id: 'ontime', he: 'תזכורת בזמן', en: 'A nudge right on time' },
      { id: 'both', he: 'גם וגם', en: 'Both' },
      { id: 'list', he: 'רשימה מסודרת', en: 'A tidy list' },
    ] },
];

const BY_KEY = new Map(PROMPTS.map((p) => [p.key, p]));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function lang(locale) {
  return String(locale || '').trim().toLowerCase().startsWith('en') ? 'en' : 'he';
}

// What the page draws: the question in their language, never the fact label
// or the options' ids in any other language.
function forPage(prompt, locale) {
  const l = lang(locale);
  const out = { key: prompt.key, type: prompt.type, category: prompt.category, q: prompt.q[l] };
  if (prompt.options) out.options = prompt.options.map((o) => ({ id: o.id, label: o[l] }));
  if (prompt.ph) out.placeholder = prompt.ph[l];
  return out;
}

// The value half of "label: value", or an error naming what was wrong.
function composeValue(prompt, answer, l) {
  const a = answer && typeof answer === 'object' ? answer : {};
  switch (prompt.type) {
    case 'range': {
      if (!HHMM.test(String(a.from || '')) || !HHMM.test(String(a.to || ''))) return { error: 'format' };
      if (a.from === a.to) return { error: 'format' };
      return { value: `${a.from}–${a.to}` };
    }
    case 'time':
      if (!HHMM.test(String(a.time || ''))) return { error: 'format' };
      return { value: a.time };
    case 'choice': {
      const opt = (prompt.options || []).find((o) => o.id === String(a.value));
      return opt ? { value: opt[l] } : { error: 'format' };
    }
    case 'days': {
      if (!Array.isArray(a.days)) return { error: 'format' };
      const set = [...new Set(a.days.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
      if (!set.length || set.length !== new Set(a.days.map(String)).size) return { error: 'format' };
      set.sort((x, y) => x - y);
      return { value: set.map((n) => DAYS[l][n]).join(', ') };
    }
    case 'text': {
      const t = String(a.text == null ? '' : a.text).replace(/\s+/g, ' ').trim();
      if (!t) return { error: 'empty' };
      if (t.length > MAX_TEXT) return { error: 'too_long' };
      return { value: t };
    }
    default:
      return { error: 'format' };
  }
}

// Keys already answered — an active, unexpired fact carries them.
async function answeredKeys(client, userId) {
  const { rows } = await client.query(
    `SELECT DISTINCT prompt_key FROM user_facts
      WHERE user_id = $1 AND active = true AND prompt_key IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())`, [userId]);
  return new Set(rows.map((r) => r.prompt_key));
}

// Every question not yet answered, in order. All of them rather than three:
// the page swaps a saved one for the next without asking the server again,
// and twenty-odd short objects is less than one round trip.
async function pending(client, userId, locale) {
  const done = await answeredKeys(client, userId);
  return PROMPTS.filter((p) => !done.has(p.key)).map((p) => forPage(p, locale));
}

async function answer(client, userId, { key, answer: given, locale } = {}) {
  const prompt = BY_KEY.get(String(key || ''));
  if (!prompt) return err('invalid', 'no such question', { reason: 'unknown_prompt' });
  const l = lang(locale);
  const composed = composeValue(prompt, given, l);
  if (composed.error) return err('invalid', 'that answer does not fit the question', { reason: composed.error });
  // One answer per question: a second save of the same key replaces the first
  // (two tabs, or a double tap) rather than leaving two lines on the card that
  // disagree about their hours.
  const { rows: prior } = await client.query(
    `SELECT id FROM user_facts WHERE user_id = $1 AND prompt_key = $2 AND active = true
      ORDER BY id DESC LIMIT 1`, [userId, prompt.key]);
  const res = await facts.rememberFact(client, userId, {
    category: prompt.category,
    fact: `${prompt.label[l]}: ${composed.value}`,
    importance: 2,
    // They typed it about themselves, on their own screen.
    source: 'user_stated',
    promptKey: prompt.key,
    replaces: prior[0] ? prior[0].id : undefined,
  });
  if (!res.ok) return res;
  const f = res.data.fact;
  return ok({
    fact: { id: Number(f.id), category: f.category, fact: f.fact, source: f.source, learnedAt: f.learned_at, promptKey: prompt.key },
    replacedId: res.data.replacedId,
  });
}

module.exports = { PROMPTS, pending, answer, composeValue, forPage, MAX_TEXT };
