'use strict';
// The first thing a new person ever reads. Brand copy, fixed by the owner
// (2026-09-04) — this is the one message in the system that is NOT the model's
// words, and it is kept here rather than in agents-template.md for two
// reasons: the doctrine is at 39249 of its 39250-char budget (CLAUDE.md), and
// text that must arrive character-for-character has no business being
// paraphrased by a model on the way out.
//
// It travels in `turn_start`'s result as `onboarding.sendVerbatim`, on the one
// turn in a person's life that carries `firstTurn` — so it costs nothing on
// every other turn, and it cannot reach somebody twice.
//
// Deliberately does NOT ask their name. The curiosity doctrine already does
// that, in its own time and its own words, and the every-reply rule is ONE
// question — bolting a question onto fixed brand copy breaks both.

// Their language is already decided by the time this is read (domain/language
// resolveLocale, stored on users.locale), so this only has to pick, never
// guess. Anything that is not Hebrew gets English: those are the two locales
// the product actually ships, and a missing translation must fall back to a
// real message rather than to an empty one.
//
// Since 2026-09-08 the copy itself lives in domain/message-templates.js
// (`opening_he` / `opening_en`), beside every other sentence Olma says
// verbatim, so the owner rewords it from the admin page like the rest.
// `OPENING` stays exported as the DEFAULTS — what a fresh install says — and
// `openingMessage` takes the loaded overrides, like every other sender.
const templates = require('./message-templates');

const OPENING = {
  he: templates.spec('opening_he').text,
  en: templates.spec('opening_en').text,
};

function openingKey(locale) {
  return locale === 'he' ? 'opening_he' : 'opening_en';
}

function openingMessage(locale, overrides) {
  return templates.textFor(openingKey(locale), overrides);
}

module.exports = { openingMessage, openingKey, OPENING };
