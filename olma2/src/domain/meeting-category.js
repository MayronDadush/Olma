'use strict';
// A coordination's category (owner, 2026-10-04): the tasks' six, plus one
// only coordinations have — 'social' ("חברים", owner: "רק בתיאומים") — because
// most coordinations are a game, a coffee or a dinner, which the task
// classifier deliberately leaves alone (task-category.js keeps bare
// "meeting" out on purpose).
//
// Automatic by default and decided at READ time, off the name and then the
// place: no column to go stale, so a rename re-sorts it. A person may pick one
// instead (`meetings.category`, migration 109); 'none' is a choice too.
//
// The task rules run FIRST, so "יום הולדת" stays family and "פאדל" health; the
// social stems are only what is left. Same discipline as the task list: a
// stem earns its place only if it is hard to read as anything else.
const taskCategory = require('./task-category');

const CATEGORIES = [...taskCategory.CATEGORIES, 'social'];
const CHOICES = new Set([...CATEGORIES, 'none']);

const HE = /[֐-׿]/;
const SOCIAL = [
  'פוקר', 'קפה', 'ארוחת ערב', 'ארוחת צהריים', 'ארוחת בוקר', 'בראנץ', 'בירה',
  'מסיבה', 'מסיבת', 'ברביקיו', 'על האש', 'מנגל', 'פיקניק', 'ערב משחקים',
  'קולנוע', 'סרט', 'הופעה', 'חברים', 'חבר׳ה',
  'poker', 'coffee', 'dinner', 'lunch', 'brunch', 'drinks', 'beer', 'party',
  'bbq', 'barbecue', 'picnic', 'game night', 'movie', 'cinema', 'concert',
  'friends', 'hangout',
].map((stem) => (HE.test(stem)
  ? new RegExp(stem.replace(/[׳']/g, ''))
  : new RegExp(`\\b${stem}`, 'i')));

function socialText(text) {
  const hay = String(text || '').replace(/[׳״'"]/g, '').toLowerCase();
  return hay && SOCIAL.some((re) => re.test(hay)) ? 'social' : null;
}

function classify(text) {
  return taskCategory.classifyText(text) || socialText(text);
}

// What the page and the chat show: the person's choice when there is one,
// otherwise the guess. `auto` (we guessed one) is what lets the page say
// "עולמה בחרה"; `chosen` tells a 'none' somebody picked from a 'none' nobody
// could read — the first is an answer, the second an offer to pick.
function categoryOf({ category, title, location }) {
  if (category && CHOICES.has(category)) return { category, auto: false, chosen: true };
  const guessed = classify(title) || classify(location);
  return { category: guessed || 'none', auto: Boolean(guessed), chosen: false };
}

// A choice coming in from a person. `auto` (or null) clears it back to the
// guess; anything else must be a key — never free text, the lesson tasks.category
// learned with thirteen vocabularies in one column.
function normaliseChoice(value) {
  if (value === null || value === undefined || value === '' || value === 'auto') return { ok: true, value: null };
  const v = String(value).trim().toLowerCase();
  return CHOICES.has(v) ? { ok: true, value: v } : { ok: false };
}

module.exports = { CATEGORIES, categoryOf, normaliseChoice, classify };
