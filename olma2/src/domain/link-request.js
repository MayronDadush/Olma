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

// "קוד כניסה" — the same shortcut, answered with an eight-digit CODE instead
// of a link (2026-09-27). A link can only ever sign in the browser it opens in;
// on an iPhone the home-screen app keeps cookies of its own, so the app's
// sign-in screen sends the person here with the first phrase below already
// typed (wa.me/?text=), and they type what comes back into the app
// (dashboard-auth.createCode). A kind of its own, so no link phrase ever
// answers with a code and no code phrase ever with a link.
const CODE_PHRASES = {
  he: [
    'קוד כניסה לאפליקציה',
    'קוד כניסה',
    'קוד לאפליקציה',
    'שלח לי קוד כניסה',
    'שלחי לי קוד כניסה',
    'שלח לי קוד',
    'שלחי לי קוד',
  ],
  en: [
    'app sign-in code',
    'sign-in code',
    'sign in code',
    'login code',
    'send me a code',
    'app code',
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

function buildIndex(table, kind = 'link', index = new Map()) {
  for (const [lang, list] of Object.entries(table)) {
    for (const p of list) {
      const key = normalize(p);
      if (key && !index.has(key)) index.set(key, { lang, kind });
    }
  }
  return index;
}
const INDEX = buildIndex(CODE_PHRASES, 'code', buildIndex(PHRASES, 'link'));

// { lang, kind: 'link' | 'code' } or null. `table` is injectable (as LINK
// phrases) so a test can prove a new language is one entry and not a code
// change.
function matchLinkRequest(text, table) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim() || raw.length > MAX_LENGTH * 2) return null;
  const index = table ? buildIndex(table) : INDEX;
  const hit = index.get(normalize(raw));
  return hit ? { lang: hit.lang, kind: hit.kind } : null;
}

module.exports = { PHRASES, CODE_PHRASES, MAX_LENGTH, normalize, matchLinkRequest };
