'use strict';
// The two voice rules from the brand book (chapter 09) that code can read
// without a judge: no exclamation mark, and at most ONE emoji on a line.
//
// The book first said "an emoji only at the end, and never two" and "no
// exclamation marks". Measured over the 67 fixed sentences in
// message-templates.js on 2026-09-29: 7 used "!" and several carried an emoji
// mid-sentence, which is how the product has always spoken. The owner chose to
// soften the BOOK rather than rewrite the product (29.9): one emoji per line,
// anywhere on it, and no "!". The 7 exclamation marks were removed in the same
// change, so every default is clean and this check starts green.
//
// Quoted text is somebody else's words — a help line quoting "יש!" is not her
// voice — so the "!" rule reads the text with quotes taken out, the same way
// hebrew-quality.flawsIn does for its own list.

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const QUOTED_RE = /["״“”][^"״“”\n]{1,120}["״“”]/g;

// Returns [] for a clean sentence, otherwise { kind, at } per flaw, where `at`
// is the line that tripped it.
function voiceFlaws(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (line.replace(QUOTED_RE, ' ').includes('!')) out.push({ kind: 'exclamation', at: line.trim() });
    if ((line.match(EMOJI_RE) || []).length > 1) out.push({ kind: 'emoji', at: line.trim() });
  }
  return out;
}

module.exports = { voiceFlaws, EMOJI_RE, QUOTED_RE };
