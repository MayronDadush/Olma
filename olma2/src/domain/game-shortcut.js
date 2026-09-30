'use strict';
// Game nights from a private chat, answered by CODE with no model turn
// (games/, stage 4א, 2026-09-30). Three short messages, the same door as
// "שלח לי קישור" (domain/link-request.js): the plugin's `before_dispatch`
// hands a short DM to brokerd `dashboard_link_shortcut`, and a claim here is
// the whole reply.
//
//   "ערב משחק חדש"   → the games pack goes on, and she asks the price
//   "50 ו־1000"      → the next message, read as the price and the chips;
//                       the night opens with them as host, and the invite to
//                       forward follows as its own message (game-summary.js)
//   "משחק K7M2Q"     → a seat at that night, under their first name
//
// Why code and not the model: the model never saw the pack's tools before
// the first message (the pack is what shows them, and the gateway takes ~11s
// to hot-reload a deny list), and a join has nothing to decide — the code is
// either an open night or it is not.
//
// Everything here is pure: the matching, and the reading of the two answers.
// brokerd holds the one piece of state (what she just asked, in memory) and
// makes the calls.
const { normalize } = require('./link-request');

// Exact after normalising, like the link phrases: "ערב משחק חדש?" is the
// phrase, "מתי ערב משחק חדש" is a question for the model.
const OPEN_PHRASES = {
  he: [
    'ערב משחק חדש', 'ערב פוקר חדש', 'פותחים ערב משחק', 'פותחים ערב פוקר',
    'פתח ערב משחק', 'פתחי ערב משחק', 'פתח ערב פוקר', 'פתחי ערב פוקר',
  ],
  en: ['new game night', 'new poker night', 'start a game night', 'start a poker night', 'open a game night'],
};
const OPEN_INDEX = new Map();
for (const [lang, list] of Object.entries(OPEN_PHRASES)) for (const p of list) OPEN_INDEX.set(normalize(p), lang);

function matchOpenPhrase(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim() || raw.length > 60) return null;
  const lang = OPEN_INDEX.get(normalize(raw));
  return lang ? { lang } : null;
}

// A night's code: five of gamesd's own alphabet (games/src/store.js), which
// has no 0/1/I/L/O. On its own a five-letter word is too common to claim — "HAPPY"
// is a valid code — so a message is a join only when the rest of it is one of
// these words, or when the code turns out to be an open night (brokerd asks).
const CODE_RE = /^[2-9A-HJKMNP-Z]{5}$/;
const GAME_WORDS = new Set(['משחק', 'פוקר', 'ערב', 'קוד', 'game', 'poker', 'code', 'night']);
const MAX_CODE_MESSAGE = 30;

// → { code, withWord, lang } or null. The code must be in capitals unless a
// game word vouches for it: "משחק k7m2q" was typed by somebody who meant it,
// a lone "hello" was not.
function findCode(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || raw.length > MAX_CODE_MESSAGE) return null;
  const words = raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const codes = words.filter((w) => CODE_RE.test(w.toUpperCase()) && /^[A-Za-z0-9]+$/.test(w));
  if (codes.length !== 1) return null;
  const rest = words.filter((w) => w !== codes[0]).map((w) => w.toLowerCase());
  if (!rest.every((w) => GAME_WORDS.has(w))) return null;
  const withWord = rest.length > 0;
  if (!withWord && codes[0] !== codes[0].toUpperCase()) return null;
  const lang = rest.some((w) => /[a-z]/.test(w)) ? 'en' : 'he';
  return { code: codes[0].toUpperCase(), withWord, lang };
}

// The answer to "כמה עולה כניסה, וכמה ז'יטונים לכל כניסה?" — exactly two
// numbers, and nothing else but the words people wrap them in. A unit decides
// which is which ("1000 ז'יטונים, 50 שקל"); with none, they answered in the
// order she asked. Anything else ("50 אבל תשאל את דני") is not a claim, and
// the message goes to the model, which by then has the pack's tools.
const PRICE_UNIT = /^(₪|ש"ח|ש״ח|שח|שקל|שקלים|nis|ils|shekel|shekels)$/;
const CHIPS_UNIT = /^(ז'יטונים|ז׳יטונים|זיטונים|ג'יטונים|ג׳יטונים|ז'יטון|ז׳יטון|צ'יפים|צ׳יפים|chips|chip)$/;
const FILLER = new Set([
  'כניסה', 'כניסות', 'לכניסה', 'לכל', 'כל', 'עולה', 'זה', 'ו', 'ב', 'ל', 'על', 'של', 'יש', 'אחת',
  'buy', 'in', 'buyin', 'buy-in', 'per', 'and', 'a', 'each', 'for', 'is', 'the', 'x',
]);
const MAX_SETUP = 60;

function parseSetup(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw || raw.length > MAX_SETUP || /\n/.test(raw)) return null;
  const t = raw.normalize('NFKC').toLowerCase()
    .replace(/(\d),(\d{3})\b/g, '$1$2')              // 1,000
    .replace(/[־–—]/g, ' ')                           // ו־1000
    .replace(/(\d)(?=[^\d.\s])/g, '$1 ').replace(/([^\d.\s])(?=\d)/g, '$1 ')
    .replace(/₪/g, ' ₪ ')
    .replace(/[,;:!?()]/g, ' ');
  const toks = t.split(/\s+/).filter(Boolean).map((w) => w.replace(/^[.]+|[.]+$/g, '')).filter(Boolean);
  const nums = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (/^\d+(\.\d+)?$/.test(w)) { nums.push({ v: Number(w), i }); continue; }
    if (PRICE_UNIT.test(w) || CHIPS_UNIT.test(w) || FILLER.has(w)) continue;
    // A Hebrew prefix glued to a word ("ו1000" was split above; "לכניסה" is
    // listed) — anything else is words she cannot read.
    return null;
  }
  if (nums.length !== 2) return null;
  // A unit AFTER a number is its own ("50 ש"ח 1000"); one before it counts
  // only when no number already took it ("₪50").
  const kindAt = (j) => (PRICE_UNIT.test(toks[j] || '') ? 'price' : CHIPS_UNIT.test(toks[j] || '') ? 'chips' : null);
  const after = nums.map((n) => kindAt(n.i + 1));
  const taken = new Set(nums.filter((n, k) => after[k]).map((n) => n.i + 1));
  const unitOf = (n, k) => after[k] || (taken.has(n.i - 1) ? null : kindAt(n.i - 1));
  let [a, b] = nums;
  const ua = unitOf(a, 0), ub = unitOf(b, 1);
  if (ua && ua === ub) return null;
  if (ua === 'chips' || ub === 'price') [a, b] = [b, a];
  const price = a.v, chips = b.v;
  if (!(price > 0 && price <= 100000) || !(Number.isInteger(chips) && chips >= 1 && chips <= 10_000_000)) return null;
  return { price: Math.round(price * 100) / 100, chips };
}

const NOT_A_NAME = new Set(['לא', 'כן', 'תודה', 'רגע', 'ביי', 'סבבה', 'אוקיי', 'אוקי', 'בסדר', 'עזוב', 'עזבי', 'ביטול', 'בטל',
  'no', 'yes', 'ok', 'okay', 'thanks', 'cancel', 'stop', 'wait']);
// The answer to "איך קוראים לך?" — one short line of letters. A digit, a
// question or a link is something else, and goes to the model.
function parseName(text) {
  const raw = String(text == null ? '' : text).normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/[.!🙂😊]+$/u, '').trim();
  if (!raw || raw.length > 24 || /[\d?@/:]/.test(raw) || raw.split(' ').length > 3) return null;
  if (!/^[\p{L}\p{M}'׳"״ .-]+$/u.test(raw)) return null;
  if (NOT_A_NAME.has(raw.toLowerCase())) return null;
  return raw;
}

// The names a person is seated under, in order: their first name, then with
// their surname's initial when somebody at the table already has it
// ("מירון ד׳", "Miron D."). No first name on file → none, and she asks.
function namesFor(user) {
  const first = String((user && user.first_name) || '').trim().split(/\s+/)[0] || '';
  if (!first || first.length > 20) return [];
  const last = String((user && user.last_name) || '').trim();
  const initial = last ? last[0] : '';
  if (!initial) return [first];
  const hebrew = /[֐-׿]/.test(initial);
  return [first, hebrew ? `${first} ${initial}׳` : `${first} ${initial.toUpperCase()}.`];
}

// "3 כניסות", said the way the table says it.
function buyinsText(n, lang) {
  const v = Number(n) || 0;
  if (lang === 'en') {
    if (v === 0.5) return 'half a buy-in';
    return `${v} buy-in${v === 1 ? '' : 's'}`;
  }
  if (v === 0.5) return 'חצי כניסה';
  if (v === 1) return 'כניסה אחת';
  if (v === 1.5) return 'כניסה וחצי';
  return `${v} כניסות`;
}

const fmtNumber = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

module.exports = {
  OPEN_PHRASES, GAME_WORDS, CODE_RE,
  matchOpenPhrase, findCode, parseSetup, parseName, namesFor, buyinsText, fmtNumber,
};
