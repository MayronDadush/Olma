'use strict';
// The voice rules from the brand book (chapter 09) that code can read without
// a judge, over every fixed sentence Olma sends.
//
// The book first said "no exclamation marks" and "one emoji, at the start of
// the message". Measured over the 67 templates in message-templates.js on
// 2026-09-29, that would have reworded 7 warm openers ("היי!", "יש! כולם
// כאן") and most emoji, which sit mid-sentence across the product. The owner
// softened both (29.9-30.9): what reads as shouting is the EXCESS, not the
// mark. So:
//   - at most one "!" in a message, and never two in a row;
//   - "סגור" is never followed by "!" — the full stop is the brand's mark;
//   - at most one emoji on a line, anywhere on it.
// Under these, 2 of the 67 needed a change (reopen_he/_en had two "!").
//
// Quoted text is somebody else's words — a help line quoting "יש!" is not her
// voice — so the "!" rules read the text with quotes taken out, the same way
// hebrew-quality.flawsIn does for its own list.

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const QUOTED_RE = /["״“”][^"״“”\n]{1,120}["״“”]/g;

// Returns [] for a clean message, otherwise { kind, at } per flaw.
function voiceFlaws(text) {
  const out = [];
  const t = String(text || '');
  const own = t.replace(QUOTED_RE, ' ');
  if (/!{2,}/.test(own)) out.push({ kind: 'double_exclamation', at: own.match(/\S*!{2,}/)[0] });
  else if ((own.match(/!/g) || []).length > 1) out.push({ kind: 'exclamation', at: 'more than one "!"' });
  if (/סגור\s*!/.test(own)) out.push({ kind: 'closed_exclamation', at: 'סגור!' });
  for (const line of t.split('\n')) {
    if ((line.match(EMOJI_RE) || []).length > 1) out.push({ kind: 'emoji', at: line.trim() });
  }
  return out;
}

module.exports = { voiceFlaws, EMOJI_RE, QUOTED_RE };
