'use strict';
// The photo of a plate, read by a vision model: what is on it and how much.
// Never the calories — those come from the table (src/foods.js), by name.
//
// The prompt is the one the bench measured (food/bench/run.js) with one line
// added from its findings: every model missed oil and dressing it could not
// see, by 30-60% of a plate's calories, so a dish that is usually cooked in or
// dressed with oil earns the one question.
const llm = require('./llm');

const GROUPS = ['protein', 'veg', 'fruit', 'grain', 'fat', 'sweet', 'drink'];
const CONF = ['high', 'mid', 'low'];

const PROMPT = `את עולמה. בתמונה ארוחה שמישהו צילם כדי לרשום מה הוא אוכל. פרקי אותה לרכיבים שרואים, והעריכי לכל רכיב כמה גרם יש ממנו לפי גודל הצלחת והכלים. אל תחשבי קלוריות: הן יבואו מטבלה לפי השם.
החזירי JSON בלבד, בלי טקסט נוסף, במבנה:
{"title":"שם קצר לארוחה","items":[{"name":"שם בעברית","name_en":"chicken breast, roasted","grams":120,"group":"protein","confidence":"high"}],"question":null,"food":true}
name_en: השם כמו בטבלת הרכב מזון, באנגלית, עם אופן ההכנה (cooked, raw, fried, roasted). רוטב, שמן או ממרח שרואים הם רכיב נפרד.
group: protein, veg, fruit, grain, fat, sweet, drink. confidence: high, mid או low.
question: שאלה קצרה אחת לאדם, או null. שאלי רק אם כמות של רכיב אחד ממש לא ברורה, או אם זו מנה שבדרך כלל מכינים עם שמן או רוטב שלא רואים (סלט, מוקפץ, מטוגן): אז שאלי אם היה שמן ובערך כמה כפות.
אם בתמונה אין אוכל, החזירי {"food":false,"items":[]}.`;

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// What a model answered, made safe to hand on: names clipped, amounts in
// range, at most 12 items. An item without a name or an amount is dropped.
function clean(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.food === false) return { food: false, items: [] };
  const items = (Array.isArray(json.items) ? json.items : []).map(it => {
    const grams = Math.round(Number(it?.grams));
    const name = clip(it?.name, 60);
    if (!name || !Number.isFinite(grams) || grams <= 0) return null;
    return {
      name,
      name_en: clip(it.name_en, 120) || null,
      grams: Math.min(grams, 3000),
      group: GROUPS.includes(it.group) ? it.group : undefined,
      confidence: CONF.includes(it.confidence) ? it.confidence : 'mid',
    };
  }).filter(Boolean).slice(0, 12);
  return {
    food: items.length > 0,
    title: clip(json.title, 80) || null,
    items,
    question: clip(json.question, 200) || null,
  };
}

async function see({ pool, userId, image, note, fetchImpl }) {
  const text = note ? `${PROMPT}\nמה שהאדם כתב עם התמונה: "${clip(note, 300)}"` : PROMPT;
  const r = await llm.chat({
    pool, userId, purpose: 'see', fetchImpl, maxTokens: 2000,
    content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }],
  });
  const out = clean(r.json);
  if (!out) throw new llm.ModelUnavailable('the picture could not be read (no JSON in the answer)');
  return out;
}

module.exports = { see, clean, PROMPT };
