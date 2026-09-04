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
// Second revision, 2026-09-04, after reading the first one on a real phone:
// the "welcome to your world" line went, and the greeting got a blank line
// under it so the name lands on its own before the two lines of substance.
const OPENING = {
  he: 'היי, אני עולמה 👋\n'
    + '\n'
    + 'אני כאן כדי לעזור לכם עם משימות, תזכורות ותיאומים מול האנשים שחשובים לכם.\n'
    + 'אפשר לכתוב, להקליט או פשוט לשלוח הכל בבלגן — אני אעשה לכם סדר ☺️',
  en: "Hey! I'm Allma \u{1F44B}\n"
    + '\n'
    + 'I’m here to help you manage tasks, set reminders, and schedule with the '
    + 'people who matter most.\n'
    + 'Text me, send a voice message, or just throw everything at me — '
    + 'I’ll keep you organized ☺️',
};

function openingMessage(locale) {
  return OPENING[locale] || OPENING.en;
}

module.exports = { openingMessage, OPENING };
