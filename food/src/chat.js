'use strict';
// The chat on the food page: Olma, but only about food. The owner's call
// (2026-10-08): code first, a small model only for what code cannot read.
//
// Code answers what has one shape — a cup of water, "what's left", taking
// back the last meal, help — with no model and no cost. A sentence about
// what they ate goes to the same Flash-Lite the photo uses, which names the
// items and amounts exactly as the photo step does (vision.clean), and the
// values come from the table by name (foods.resolve), so a meal logged here
// is the meal WhatsApp would have logged. A food question gets one short
// answer; anything else is pointed back to Olma in WhatsApp, because this
// chat holds no memory of her and no tool but these.
const store = require('./store');
const foods = require('./foods');
const vision = require('./vision');
const llm = require('./llm');
const N = require('./nutrition');

const SAYS_PER_DAY = 60;
const fmt = n => Math.round(n).toLocaleString('he-IL');

const NUM = { אחת: 1, אחד: 1, שתי: 2, שתיים: 2, שניים: 2, שני: 2, שלוש: 3, שלושה: 3, ארבע: 4, ארבעה: 4, חמש: 5, חמישה: 5, שש: 6, שישה: 6 };
const HELP = 'כאן אני רושמת אוכל ומים, כמו בוואטסאפ:\n• "אכלתי חביתה משתי ביצים וסלט"\n• "כוס מים" או "שתיתי 3 כוסות"\n• "מה נשאר לי היום?"\n• "תמחקי את האחרונה"\nתמונה של צלחת שולחים לי בוואטסאפ.';

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// What code can read on its own, or null.
function parse(raw) {
  const t = clip(raw, 300).replace(/[?!.,״"']/g, '').trim();
  if (!t) return null;
  if (/^(עזרה|מה אפשר( לעשות)?( כאן)?|מה את יודעת לעשות|help)$/.test(t)) return { k: 'help' };
  if (/^(\+1 )?מים$|כוס(ות)? מים|שתיתי (\S+ )?(כוס|כוסות)|^עוד כוס$/.test(t)) {
    // Whole words only: "שתיתי" (I drank) starts with "שתי" (two).
    const d = t.match(/\d+/);
    const w = t.split(/\s+/).find(x => NUM[x]);
    const n = d ? Number(d[0]) : (w ? NUM[w] : 1);
    return { k: 'water', n: Math.max(1, Math.min(10, n)) };
  }
  if (/(מה|כמה) נשאר|איך אני|מה המצב|כמה אכלתי|מה אכלתי היום|סיכום/.test(t)) return { k: 'status' };
  if (/^ת?(בטלי|מחקי|בטל|מחק)( את)?( ה)?(ארוחה)?( ה)?(אחרונה)?$/.test(t)) return { k: 'undo' };
  return null;
}

function statusLine(v) {
  if (!v.meals.length) return 'עוד לא נרשם כלום היום.';
  if (v.person.numbers) {
    const left = v.left.kcal;
    return `היום: ${fmt(v.totals.kcal)} קק״ל מתוך ${fmt(v.person.goal.kcal)}, ${left >= 0 ? `נשארו ${fmt(left)}` : `${fmt(-left)} מעל היעד`}. חלבון ${fmt(v.totals.protein)} מתוך ${v.person.goal.protein} ג׳. מים: ${v.water} מתוך ${v.person.water_goal}.`;
  }
  return `היום ${v.meals.length === 1 ? 'ארוחה אחת' : `${v.meals.length} ארוחות`}, ${v.balance_counts.veg ? `ירקות ב-${v.balance_counts.veg}` : 'עוד בלי ירקות'}. מים: ${v.water} מתוך ${v.person.water_goal}.`;
}

const PROMPT = `את עולמה, ובצ'אט הזה רק רושמים אוכל. האדם כתב משפט. החזירי JSON בלבד, אחד משלושה:
1. אם הוא מספר מה אכל או שתה: {"kind":"log","title":"שם קצר לארוחה","meal":null,"when":"today","items":[{"name":"שם בעברית","name_en":"egg, whole, fried","grams":100,"group":"protein","confidence":"mid"}]}
   grams לפי מנה רגילה כשלא נאמרה כמות. name_en כמו בטבלת הרכב מזון, באנגלית, עם אופן ההכנה. group: protein, veg, fruit, grain, fat, sweet, drink.
   meal: breakfast, lunch, snack, dinner רק אם נאמר, אחרת null. when: "yesterday" רק אם נאמר אתמול.
2. אם הוא שואל שאלה על אוכל או תזונה: {"kind":"answer","text":"תשובה קצרה, משפט או שניים, בעברית"}. בלי ייעוץ רפואי.
3. כל דבר אחר: {"kind":"other"}.`;

async function say(pool, p, text, { fetchImpl } = {}) {
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM model_calls WHERE user_id = $1 AND purpose = 'say' AND at > now() - interval '1 day'`, [p.user_id]);
  if (n >= SAYS_PER_DAY) return { reply: 'הגעת למגבלת ההודעות כאן להיום. אפשר להמשיך אצלי בוואטסאפ.' };
  let r;
  try {
    r = await llm.chat({ pool, userId: p.user_id, purpose: 'say', fetchImpl, maxTokens: 1200, content: `${PROMPT}\nהמשפט: "${clip(text, 400)}"` });
  } catch (e) {
    if (e instanceof llm.ModelUnavailable) return { reply: 'לא הצלחתי לקרוא את זה עכשיו. נסו שוב עוד רגע, או כתבו לי בוואטסאפ.' };
    throw e;
  }
  const j = r.json || {};
  if (j.kind === 'answer' && j.text) return { reply: clip(j.text, 400) };
  if (j.kind !== 'log') return { reply: 'כאן אני רק רושמת אוכל ומים. על כל דבר אחר כתבו לי בוואטסאפ.' };
  const seen = vision.clean({ title: j.title, items: j.items, food: true });
  if (!seen || !seen.items.length) return { reply: 'לא הבנתי מה לרשום. נסו עם כמות, למשל "2 פרוסות לחם עם גבינה".' };
  const items = await foods.resolve(pool, seen.items, { userId: p.user_id, fetchImpl });
  const slot = ['breakfast', 'lunch', 'snack', 'dinner'].includes(j.meal) ? j.meal : undefined;
  const { meal } = await store.logMeal(pool, p, { title: seen.title || undefined, items, meal: slot, date: j.when === 'yesterday' ? 'yesterday' : undefined, source: 'text' }, { via: 'page' });
  const listed = meal.items.map(i => i.name).join(', ');
  const names = listed === meal.title ? '' : ` (${listed})`;
  return {
    reply: p.numbers
      ? `רשמתי ${N.SLOT_HE[meal.slot]}: ${meal.title}, ${fmt(meal.totals.kcal)} קק״ל${names}. אפשר לתקן כמויות בלשונית "היום".`
      : `רשמתי ${N.SLOT_HE[meal.slot]}: ${meal.title}${names}.`,
    logged: meal.id,
  };
}

async function turn(pool, p, text, { fetchImpl } = {}) {
  const c = parse(text);
  if (!c) return say(pool, p, text, { fetchImpl });
  if (c.k === 'help') return { reply: HELP };
  if (c.k === 'water') {
    const w = await store.water(pool, p, { add: c.n });
    return { reply: `${c.n === 1 ? 'כוס נרשמה' : `${c.n} כוסות נרשמו`}. ${w.cups} מתוך ${w.goal} היום.` };
  }
  if (c.k === 'status') return { reply: statusLine(await store.dayView(pool, p)) };
  if (c.k === 'undo') {
    const last = await store.lastMeal(pool, p);
    if (!last) return { reply: 'אין ארוחה מהיומיים האחרונים למחוק.' };
    await store.deleteMeal(pool, p, last.id);
    return { reply: `מחקתי את "${last.title}".` };
  }
  return { reply: HELP };
}

module.exports = { turn, parse, statusLine, PROMPT, SAYS_PER_DAY };
