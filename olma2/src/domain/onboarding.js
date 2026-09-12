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

// Hebrew and English are the two languages the product ships (owner,
// 2026-09-09), and this decides which one a person's first sentence is in.
//
// It was an EXACT match on 'he', which is the one shape a locale column cannot
// be relied on to have: `set_my_language` stores any ISO code it is given
// after lowercasing — its own description offers "he, en, ar, ru" — so
// `he-il` is a perfectly ordinary value, and it used to buy an ENGLISH
// opening followed by Hebrew reminders for ever after, because
// `proactive-text.localizedKey` reads the same column with a prefix test. An
// empty or missing locale did the same. Two opposite fallbacks for one
// two-language decision.
//
// The DIRECTION here is deliberately not localizedKey's, and the two are not
// a contradiction: a reminder has only two sets of sentences and Hebrew is
// the house default (`createUser` COALESCEs the column to 'he'), while an
// opening has the intake greeter beside it, told in so many words "if they
// wrote in Hebrew … in any other language" (intake/intake-workspace.js). So
// anything Hebrew is Hebrew, nothing on file is Hebrew, and every other
// language meets the same English opening the greeter would have sent.
function openingKey(locale) {
  const code = String(locale == null ? '' : locale).trim().toLowerCase();
  return !code || code.startsWith('he') ? 'opening_he' : 'opening_en';
}

function openingMessage(locale, overrides) {
  return templates.textFor(openingKey(locale), overrides);
}

module.exports = { openingMessage, openingKey, OPENING };
