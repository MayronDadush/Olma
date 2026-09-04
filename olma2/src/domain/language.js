'use strict';
// Which language Olma speaks to a person in — and stores their data in.
//
// The rule (decided 2026-08-17): the language of their FIRST message is their
// language, for both conversation and stored content. An explicit request
// ("talk to me in English") overrides it immediately and permanently. Only
// when their text carries no language signal at all — an emoji, a bare number,
// "ok" — do we fall back to guessing from the dialling code.
//
// Detection is by SCRIPT, not by vocabulary. Script is a hard, cheap signal:
// Hebrew letters mean Hebrew, Cyrillic means Russian. No word lists, no model
// call, no dependency, and it cannot be fooled by a loanword.
//
// The one case script cannot resolve is Latin, which a dozen languages share.
// There the dialling code disambiguates: Latin text from a French number is
// French, from an Israeli number it is English — because an Israeli writing in
// Latin characters has actively chosen not to write Hebrew, and honouring that
// IS the rule. They can always ask for Hebrew and get it.
const { lookupTimezone } = require('./phone-timezone');

// Scripts that identify a language on their own. Order is irrelevant — the
// dominant script by character count wins.
const SCRIPTS = [
  { locale: 'he', re: /[֐-׿]/g },
  { locale: 'ar', re: /[؀-ۿݐ-ݿ]/g },
  { locale: 'ru', re: /[Ѐ-ӿ]/g },
  { locale: 'el', re: /[Ͱ-Ͽ]/g },
  { locale: 'hi', re: /[ऀ-ॿ]/g },
  { locale: 'th', re: /[฀-๿]/g },
  { locale: 'ko', re: /[가-힯ᄀ-ᇿ]/g },
  { locale: 'ja', re: /[぀-ゟ゠-ヿ]/g },
  { locale: 'zh', re: /[一-鿿]/g },
];
const LATIN = /[A-Za-z]/g;

// Latin-script languages we can name from a dialling code. Anything else with
// a Latin-script message is treated as English — the lingua franca a stranger
// most likely reached for.
const LATIN_LANGS = new Set(['en', 'fr', 'de', 'it', 'es', 'nl', 'pt', 'pl', 'tr', 'uk']);

// Two letters is the floor. Below that ("👍", "5", "?") there is nothing to
// read, and guessing from one character would be noise dressed as a signal.
const MIN_LETTERS = 2;

function countMatches(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

// The language of a piece of text, or null when it carries no signal.
function detectLanguage(text, phone) {
  if (!text) return null;
  const s = String(text);

  let best = null;
  for (const script of SCRIPTS) {
    const n = countMatches(s, script.re);
    if (n >= MIN_LETTERS && (!best || n > best.n)) best = { locale: script.locale, n };
  }
  const latin = countMatches(s, LATIN);

  // A non-Latin script wins outright when it is at least as present as Latin:
  // "יש לי meeting מחר" is Hebrew with an English word in it, not English.
  if (best && best.n >= latin) return best.locale;
  if (latin >= MIN_LETTERS) {
    const hit = phone ? lookupTimezone(phone) : null;
    return hit && LATIN_LANGS.has(hit.lang) ? hit.lang : 'en';
  }
  return best ? best.locale : null;
}

// Where a person's language comes from when they first arrive. Returns the
// locale plus HOW it was decided, so callers can tell an observation from a
// guess (a guess is worth confirming later; an observation is not).
function resolveLocale({ text, phone, fallback = 'en' } = {}) {
  const detected = detectLanguage(text, phone);
  if (detected) return { locale: detected, source: 'message' };
  const hit = phone ? lookupTimezone(phone) : null;
  if (hit && hit.lang) return { locale: hit.lang, source: 'phone_prefix' };
  return { locale: fallback, source: 'default' };
}

// ---- noticing that we got it wrong -----------------------------------------
//
// resolveLocale runs ONCE, when somebody arrives, and until 2026-09-04 nothing
// ever revisited it. That day a user wrote four messages in English and got
// four replies in Hebrew, because his row said `he` and the template says — in
// as many words — not to switch just because one message came in another
// language. The template is right about ONE message. Nothing was watching for
// four.
//
// Nothing COULD be, either: there is no messages table, and turn_start records
// `message.received` with no text. That is deliberate and stays that way, so
// the signal has to come from the only party that sees the words — the model,
// reporting a two-letter language code and nothing else. The trade is real and
// worth naming: we give up determinism (a model that omits the code produces
// no nudge) to avoid keeping people's messages in Postgres. The failure mode
// is silence, never a wrong switch.
//
// Three in a row, not two. The travel detector settles for two witnesses
// because a flight is a rare event; a language is a habit, and people quote,
// paste and code-switch constantly. Three consecutive messages in one language
// is a person writing in that language.
const STREAK_TO_ASK = 3;
// A declined offer buys a long silence. Asking once is helpful; asking again
// next week is the pattern the stop doctrine forbids everywhere else.
const ASK_AGAIN_DAYS = 60;

// Whether we can act on a code at all. Same shape users.setLocale accepts, so
// a code that passes here cannot be rejected downstream.
function normalizeLocale(code) {
  const c = String(code == null ? '' : code).trim().toLowerCase().slice(0, 8);
  return /^[a-z]{2}(-[a-z]{2,8})?$/.test(c) ? c : null;
}

// The whole decision, with no database in it: given what we stored, what the
// streak was, and what just arrived, what should the streak become and should
// Olma ask?
//
// A message in their STORED language resets the streak to zero — an
// interrupted streak is not a streak, and somebody who genuinely mixes two
// languages must never be nagged about it. That reset is the reason this can
// be aggressive at three without being wrong.
function decideStreak({ stored, observed, prevObserved, prevCount, askedAt, now } = {}) {
  const code = normalizeLocale(observed);
  const mine = normalizeLocale(stored);
  if (!code) return { observed: prevObserved || null, count: Number(prevCount) || 0, ask: false };
  if (mine && code === mine) return { observed: null, count: 0, ask: false };

  const continuing = prevObserved && normalizeLocale(prevObserved) === code;
  const count = continuing ? (Number(prevCount) || 0) + 1 : 1;

  // `>=`, not `===`. Exact-match reads as the tighter rule and is the buggier
  // one: if the threshold is crossed during a quiet period — the model omitted
  // a code, or we had asked recently — the count sails past 3 and an `===`
  // check never matches again, so the person is never asked at all. What
  // stops the nagging is askedAt, which the caller stamps the moment this
  // returns true, and which then holds every later message off by itself.
  const askedRecently = askedAt
    && (new Date(now || Date.now()) - new Date(askedAt)) < ASK_AGAIN_DAYS * 86400_000;
  return { observed: code, count, ask: count >= STREAK_TO_ASK && !askedRecently };
}

module.exports = {
  detectLanguage, resolveLocale, SCRIPTS, MIN_LETTERS,
  decideStreak, normalizeLocale, STREAK_TO_ASK, ASK_AGAIN_DAYS,
};
