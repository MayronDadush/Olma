'use strict';
// Every write, from the page or from Olma, is checked here. The page is not
// trusted (anybody holding the link can send anything) and neither is the
// model (it estimates; it can be wrong by an order of magnitude). A write that
// fails is refused whole, with a code the caller turns into one sentence.

class Refused extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}
const refuse = (code, detail) => { throw new Refused(code, detail); };

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const GROUPS = ['protein', 'veg', 'fruit', 'grain', 'fat', 'sweet', 'drink'];
const CONFIDENCE = ['high', 'mid', 'low', 'label', 'said', 'portion'];
const SOURCES = ['photo', 'text', 'voice', 'label', 'repeat', 'usual', 'auto', 'page'];
const CHALLENGES = ['veg_dinner', 'protein_breakfast', 'water6'];
const MAX_ITEMS = 12;
const VALUE_SRC = ['table', 'label', 'model', 'group'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max, code = 'bad_text') => {
  if (typeof v !== 'string') refuse(code);
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > max) refuse(code);
  return t;
};
const num = (v, min, max, code = 'bad_number') => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) refuse(code);
  return n;
};
const oneOf = (v, list, code) => (list.includes(v) ? v : refuse(code));
const round1 = n => Math.round(n * 10) / 10;

// What a group is when the model did not say: from the item's own numbers.
function guessGroup(name, v) {
  const [k, p, c, f] = v;
  if (!k) return 'drink';
  if (/תות|בננה|תפוח|ענב|אבטיח|מלון|תפוז|אגס|פרי|fruit|banana|apple|berry/i.test(name)) return 'fruit';
  if (p * 4 / k >= 0.3) return 'protein';
  if (k < 45) return 'veg';
  if (f * 9 / k >= 0.6) return 'fat';
  if (c * 4 / k >= 0.5) return 'grain';
  return 'fat';
}

// One item as Olma's tool sends it: name, grams and the values per 100 g.
// A model that writes 400 kcal per 100 g of cucumber is not refused (it may be
// a pickle in oil) but nothing above 950 kcal per 100 g exists in food, and
// macros above 100 g per 100 g cannot.
function item(data) {
  if (!isObj(data)) refuse('bad_item');
  const p = isObj(data.per100) ? data.per100 : data;
  const v = [
    num(p.kcal ?? p.kcal100, 0, 950, 'bad_values'),
    num(p.protein ?? p.protein100 ?? 0, 0, 100, 'bad_values'),
    num(p.carbs ?? p.carbs100 ?? 0, 0, 100, 'bad_values'),
    num(p.fat ?? p.fat100 ?? 0, 0, 100, 'bad_values'),
  ];
  // The macros cannot hold more energy than the item has, by a wide margin.
  if (v[1] * 4 + v[2] * 4 + v[3] * 9 > v[0] * 1.6 + 40) refuse('bad_values');
  const name = text(data.name, 60, 'bad_item');
  const grp = GROUPS.includes(data.group ?? data.grp) ? (data.group ?? data.grp) : guessGroup(name, v);
  const confidence = data.said === true ? 'said' : CONFIDENCE.includes(data.confidence) ? data.confidence : 'mid';
  const out = { name, grams: round1(num(data.grams, 0, 3000)), v: v.map(round1), grp, confidence };
  // Set only by foods.resolve, which strips whatever a caller sent in them.
  if (Number.isSafeInteger(data.food_id)) out.food_id = data.food_id;
  if (VALUE_SRC.includes(data.value_src)) out.value_src = data.value_src;
  return out;
}

function items(list, { allowEmpty = false } = {}) {
  if (!Array.isArray(list)) refuse('bad_item');
  if (!allowEmpty && !list.length) refuse('no_items');
  if (list.length > MAX_ITEMS) refuse('too_many');
  return list.map(item);
}

module.exports = {
  Refused, refuse, text, num, oneOf, item, items, isObj, guessGroup,
  SLOTS, GROUPS, SOURCES, CHALLENGES, MAX_ITEMS,
};
