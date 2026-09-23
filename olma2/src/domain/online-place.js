'use strict';
// A coordination whose NAME already says where it happens.
//
// "פוקר בזום" was confirmed on 2026-09-23 and the room's "סגור" line asked
// "איפה נפגשים? תכתבו לי ואני אוסיף ליומן 📍" — about a game the room had
// named as a Zoom call in the same breath it asked for it. Somebody had to
// answer "בזום מאמי" (`incidents.md`, "Where do we meet, on Zoom").
//
// The place stays the room's own words (`rules/groups.md`), so this reads
// WORDS, never a guess: a closed list of platforms a meeting happens ON,
// matched as a whole word, with the one-letter Hebrew prefixes a place takes
// ("בזום", "ב-Zoom"). What comes back is the word as they wrote it, without
// the prefix, and it becomes `meetings.location` exactly as if the room had
// said it — so the calendar event carries it too, and the done line has
// nothing to ask.
//
// Closed and narrow on purpose. "וידאו" alone is not on it ("צילום וידאו" is a
// shoot somewhere real), nor is a bare "meet" or "teams" in English ("Meet
// Dana", "two teams"). A miss costs one question the room can answer in two
// words; a false hit tells a room nobody needs to know where they are going.
const PLATFORMS = [
  'zoom', 'זום',
  'google meet', 'גוגל מיט',
  'microsoft teams', 'טימס',
  'skype', 'סקייפ',
  'discord', 'דיסקורד',
  'facetime', 'פייסטיים',
  'שיחת וידאו',
  'online', 'אונליין', 'אונלין',
];
// `\b` is dead against Hebrew (Hebrew letters are not `\w`), so both edges are
// spelled out as "not a letter of either script".
const LETTER = 'A-Za-z֐-׿';
const ONLINE_RE = new RegExp(
  `(?:^|[^${LETTER}])(?:[בלה]-?)?(${PLATFORMS.join('|')})(?![${LETTER}])`, 'i');

// The platform named in `text`, as written, or null.
function onlinePlace(text) {
  const m = ONLINE_RE.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

module.exports = { onlinePlace, PLATFORMS };
