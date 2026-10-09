'use strict';
// The arithmetic, in one place, for the page, for Olma's tools and for the
// card. Nothing here touches the database.

const r0 = n => Math.round(n);
const r1 = n => Math.round(n * 10) / 10;

const itemTotals = it => {
  const k = Number(it.grams) / 100;
  return { kcal: it.v[0] * k, protein: it.v[1] * k, carbs: it.v[2] * k, fat: it.v[3] * k };
};
function sum(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const it of items) { const x = itemTotals(it); for (const k in t) t[k] += x[k]; }
  return t;
}
const rounded = t => ({ kcal: r0(t.kcal), protein: r1(t.protein), carbs: r1(t.carbs), fat: r1(t.fat) });

// The plate without numbers: was there protein, vegetables or fruit, a grain.
const BALANCE = {
  protein: g => g === 'protein',
  veg: g => g === 'veg' || g === 'fruit',
  grain: g => g === 'grain',
};
const balanceOf = items => Object.keys(BALANCE).filter(b => items.some(it => BALANCE[b](it.grp)));

const GROUP_HE = { protein: 'חלבון', veg: 'ירק', fruit: 'פרי', grain: 'פחמימה', fat: 'שומן', sweet: 'מתוק', drink: 'שתייה' };
const BALANCE_HE = { protein: 'חלבון', veg: 'ירקות ופירות', grain: 'פחמימות' };
// Something you drink is said in ml, not grams. A drink is its group; soup
// is filed as veg or protein by what is in it, so it is named, and only by
// the FIRST word (or the first after a cup or a bowl): "מרק עוף" is soup,
// "שקדי מרק" and "שוק עוף במרק" are not.
const LIQUID = new Set(['מרק', 'קפה', 'הפוך', 'אספרסו', 'קפוצ׳ינו', "קפוצ'ינו", 'לאטה', 'תה', 'חלב', 'מיץ', 'שוקו', 'קולה', 'סודה', 'משקה', 'שתייה', 'בירה', 'יין', 'שייק', 'לימונדה', 'מים', 'soup', 'coffee', 'tea', 'milk', 'juice']);
const VESSEL = new Set(['כוס', 'ספל', 'קערת', 'קערה', 'בקבוק', 'פחית', 'צלחת']);
function isLiquid(name, grp) {
  if (grp === 'drink') return true;
  const w = String(name || '').toLowerCase().split(/[^\p{L}'׳]+/u).filter(Boolean);
  return LIQUID.has(w[0]) || (VESSEL.has(w[0]) && LIQUID.has(w[1]));
}
const SLOT_HE = { breakfast: 'ארוחת בוקר', lunch: 'ארוחת צהריים', dinner: 'ארוחת ערב', snack: 'נשנוש' };

// A daily goal from what they told Olma: Mifflin-St Jeor for the resting
// rate, a factor for how much they move, and a SMALL change for an aim, never
// below 10% above the resting rate. An estimate, and the answer says so.
const ACTIVITY = { low: 1.3, some: 1.5, high: 1.7 };
const AIM = { lose: -400, keep: 0, gain: 250 };
function goalFrom({ height, weight, age, sex, activity, aim }) {
  const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'male' ? 5 : -161);
  const kcal = Math.max(Math.round(bmr * 1.1 / 50) * 50, Math.round((bmr * ACTIVITY[activity] + AIM[aim]) / 50) * 50);
  const protein = Math.round(weight * (aim === 'keep' ? 1.4 : 1.8) / 5) * 5;
  const fat = Math.round(kcal * 0.28 / 9 / 5) * 5;
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4 / 5) * 5);
  return { kcal, protein, carbs, fat, bmr: r0(bmr) };
}

// The three challenges a person can pick. Each says whether ONE day met it,
// from that day's meals and water; a rough meal (Friday dinner) never counts.
const CHALLENGES = {
  veg_dinner: { he: 'ירק בכל ארוחת ערב', met: d => d.meals.some(m => m.slot === 'dinner' && !m.rough && m.balance.includes('veg')) },
  protein_breakfast: { he: 'חלבון בארוחת הבוקר', met: d => d.meals.some(m => m.slot === 'breakfast' && !m.rough && m.balance.includes('protein')) },
  water6: { he: '6 כוסות מים ביום', met: d => d.water >= 6 },
};

const base = name => String(name).split(' · ')[0].replace(/\s+/g, ' ').trim();

module.exports = { isLiquid, sum, rounded, itemTotals, balanceOf, goalFrom, CHALLENGES, GROUP_HE, BALANCE_HE, SLOT_HE, ACTIVITY, AIM, base, r0, r1 };
