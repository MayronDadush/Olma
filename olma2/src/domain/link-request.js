'use strict';
// "שלח לי קישור" — a whole message that asks for their page and nothing else,
// answered by code with no model turn at all (owner, 2026-09-25: to save the
// time and the tokens a turn spends minting one link and wording one line).
//
// The gateway plugin's `before_dispatch` (gateway-plugin/olma-turn) hands a
// short DM here through brokerd `dashboard_link_shortcut`; a match mints the
// link and the plugin returns `{handled: true, text}`, which ends the message
// and has the GATEWAY send the text on the ordinary reply path. Anything that
// does not match exactly goes to the model as it always did — "שלח לי קישור
// לפגישה" is a question about a coordination, and only a turn can answer it.
//
// ONE table, keyed by language, and it lives here only: the plugin carries no
// copy and no keyword, so adding a language is an entry below plus its
// `dashboard_link_<lang>` template, with no gateway restart. Every language is
// tried on every message — somebody whose locale says Hebrew may write
// "send me the link" — and the answer comes back in the language that MATCHED,
// because that is the language they are writing in right now.
//
// Exact after normalising, never "contains": a hint that fires on ordinary
// input is worse than no hint (rules/detectors.md), and here a false match
// swallows a real message whole.
const PHRASES = {
  he: [
    'שלח לי קישור לדאשבורד',
    'שלח לי קישור',
    'שלח קישור',
    'קישור',
    'שלחי לי קישור לדאשבורד',
    'שלחי לי קישור',
    'שלחי קישור',
  ],
  en: [
    'send me the dashboard link',
    'send me a link',
    'send me the link',
    'send link',
    'link',
    'dashboard link',
  ],
};

// Case, the marks around the words and the space between them are not part of
// the request: "קישור?", "Link!", "שלחי  לי קישור 🙏" are the same message.
// Hebrew points (niqqud) go too. Letters and digits of every script stay.
function normalize(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Longer than the longest phrase in any language means it cannot be one; the
// plugin uses the same bound so a long message never leaves the gateway.
const MAX_LENGTH = 40;

function buildIndex(table) {
  const index = new Map();
  for (const [lang, list] of Object.entries(table)) {
    for (const p of list) {
      const key = normalize(p);
      if (key && !index.has(key)) index.set(key, lang);
    }
  }
  return index;
}
const INDEX = buildIndex(PHRASES);

// { lang } or null. `table` is injectable so a test can prove a new language
// is one entry and not a code change.
function matchLinkRequest(text, table) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim() || raw.length > MAX_LENGTH * 2) return null;
  const index = table ? buildIndex(table) : INDEX;
  const lang = index.get(normalize(raw));
  return lang ? { lang } : null;
}

module.exports = { PHRASES, MAX_LENGTH, normalize, matchLinkRequest };
