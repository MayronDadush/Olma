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

module.exports = { detectLanguage, resolveLocale, SCRIPTS, MIN_LETTERS };
