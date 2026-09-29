'use strict';
// Every write the page can make, checked on the server. The page is not
// trusted: anybody holding a night's link can send anything. A write that
// fails here is refused whole, with a code the page turns into one sentence.

class Refused extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}
const refuse = (code, detail) => { throw new Refused(code, detail); };

const ID = /^[A-Za-z0-9_-]{2,32}$/;
const VIA = new Set(['tap', 'chat', 'olma']);
const FOOD_KINDS = new Set(['', 'pizza', 'sushi', 'burger', 'shawarma', 'drinks']);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const id = v => (typeof v === 'string' && ID.test(v) ? v : refuse('bad_id'));
const text = (v, max) => {
  if (typeof v !== 'string') refuse('bad_text');
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!t || t.length > max) refuse('bad_text');
  return t;
};
const num = (v, min, max) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) refuse('bad_number');
  return n;
};
const via = v => (VIA.has(v) ? v : 'tap');
// A client clock is only a hint: clamp it to the last week and a minute ahead.
const when = (v, now) => (typeof v === 'number' && v > now - 7 * 864e5 && v < now + 6e4 ? Math.round(v) : now);
const money = v => Math.round(num(v, 0, 1e6) * 100) / 100;

function player(data) {
  if (!isObj(data)) refuse('bad_doc');
  return { name: text(data.name, 24), order: num(data.order ?? Date.now(), -1e15, 1e15) };
}

function buyin(data, now) {
  if (!isObj(data)) refuse('bad_doc');
  const n = num(data.n, 0.5, 1);
  if (n !== 0.5 && n !== 1) refuse('bad_number');
  return { pid: id(data.pid), n, via: via(data.via), at: when(data.at, now) };
}

function cashout(data, now) {
  if (!isObj(data)) refuse('bad_doc');
  const chips = num(data.chips, 0, 1e9);
  if (!Number.isInteger(chips)) refuse('bad_number');
  return { chips, via: via(data.via), at: when(data.at, now) };
}

function idMap(v, max) {
  if (v == null) return undefined;
  if (!isObj(v)) refuse('bad_doc');
  const keys = Object.keys(v);
  if (keys.length > max) refuse('too_many');
  const out = {};
  for (const k of keys) out[id(k)] = money(v[k]);
  return keys.length ? out : undefined;
}

function food(data, now) {
  if (!isObj(data)) refuse('bad_doc');
  const kind = typeof data.kind === 'string' && FOOD_KINDS.has(data.kind) ? data.kind : '';
  const eaters = Array.isArray(data.eaters) ? [...new Set(data.eaters.map(id))] : refuse('bad_doc');
  if (eaters.length > 40) refuse('too_many');
  const out = {
    kind,
    what: text(data.what ?? 'אוכל', 40),
    amount: money(data.amount),
    payer: id(data.payer),
    eaters,
    at: when(data.at, now),
  };
  if (!(out.amount > 0)) refuse('bad_number');
  const own = idMap(data.own, 40), paid = idMap(data.paid, 40);
  if (own) out.own = own;
  if (paid) out.paid = paid;
  return out;
}

function logLine(data, now) {
  if (!isObj(data)) refuse('bad_doc');
  return { t: text(data.t, 200), via: via(data.via), at: when(data.at, now) };
}

// A patch to the night itself: only these four fields, each checked.
function gamePatch(data) {
  if (!isObj(data)) refuse('bad_doc');
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'name') out.name = text(v, 60);
    else if (k === 'price') out.price_ag = Math.round(num(v, 0.01, 100000) * 100);
    else if (k === 'chips') { const c = num(v, 1, 1e7); if (!Number.isInteger(c)) refuse('bad_number'); out.chips_per_buyin = c; }
    else if (k === 'foodMode') out.food_mode = v === 'split' ? 'split' : v === 'merge' ? 'merge' : refuse('bad_doc');
    else refuse('bad_field', k);
  }
  if (!Object.keys(out).length) refuse('bad_doc');
  return out;
}

module.exports = { Refused, refuse, id, player, buyin, cashout, food, logLine, gamePatch };
