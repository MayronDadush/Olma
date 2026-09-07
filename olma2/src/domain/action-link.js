'use strict';
// A link a tool mints reaches the MODEL and stops there. Nothing server-side
// sends it: there is no outbox row, no template, no second delivery — the only
// way it reaches the person's phone is if the model writes it into the reply.
//
// On 2026-09-07 it did not. עידן, on his first morning, asked Olma to read his
// calendar; `start_google_connection` returned the consent URL and Olma wrote
// "שלחתי לך קישור 🫡" with no link in the message. He answered "איפה שלחת לי
// את הקישור? אני לא רואה אותו". The result had a `url` field, a `tellTheUser`
// sentence about what the link asks for, and nothing anywhere saying that the
// url itself had to be in the reply — so the model described the link instead
// of sending it, which is the same failure as claiming a lookup that never
// happened (CLAUDE.md, "Olma never claims a lookup she did not perform").
//
// The shape is copied from the one instruction in this system already proven
// to make a model reproduce a string character for character: turn_start's
// `onboarding.sendVerbatim` + its sibling `instruction`. Same idea, same
// wording register, and it rides the RESULT rather than the tool description,
// where it costs tokens only on the handful of turns in a person's life that
// mint a link (CLAUDE.md, "Doctrine": guidance about a RESULT rides the
// result).
//
// Deliberately NOT solved by folding the url into `tellTheUser`: that string
// is the owner's wording about what the person is being asked to approve, and
// a 300-character Google URL spliced into the middle of it is not something
// anyone can proof-read on the admin page.
const INSTRUCTION = 'The `url` above is the whole point of this result and '
  + 'NOTHING ELSE WILL DELIVER IT — no tool, no queue, no later message. Put it '
  + 'in your reply exactly as it is, every character, on a line of its own. '
  + 'Never write "שלחתי לך קישור" / "I sent you a link" or any other sentence '
  + 'that says the link is on its way: if the characters are not in the message '
  + 'you are writing right now, the person has no link.';

// Wraps a tool result that carries a URL the person has to open. `url` stays
// the first key so the model reads it before the instruction that refers to it.
function withLink(url, rest = {}) {
  return { url, ...rest, sendLinkVerbatim: INSTRUCTION };
}

module.exports = { withLink, INSTRUCTION };
