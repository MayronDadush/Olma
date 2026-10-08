'use strict';
// A turn OLMA started — a check-in, a reminder, a coordination message being
// delivered — is not the person asking for anything. Two kinds of tool act in
// their name and so refuse there, unless they have written since that
// delivery began: inside the grace minute a real reply is theirs
// (`self-initiated.since`, against the gateway opener's `last_woke_at`).
//
//   - a tool that writes their own ANSWER to a coordination (2026-10-04: a
//     check-in turn wrote a yes onto a coordination its reader had never been
//     asked about, and the room counted it) — meetings.js, `WRITES_ANSWER`;
//   - a tool that passes their WORDS to somebody else (2026-09-28: a
//     `stalled_goal` check-in told the model to ask its reader one question,
//     and it messaged a connection directly instead, in the reader's name,
//     with a day it had assumed) — `SPEAKS_FOR`, beside each tool.
//
// The page and the room are other doors and are not touched: the page is
// their own hand, and a room tool acts only as the member whose tag opened the
// turn. Applied by `guard`, once per slice, and never inside a handler: a
// guard per handler is a guard the next tool forgets.
const { selfInitiated, err } = require('./tools/_shared');

// Two minutes of slack before the mark: somebody who wrote just before a
// delivery is mid-conversation, and their own turn may still be running when
// ours begins.
const OUR_TURN_SLACK_MS = 2 * 60_000;

const ANSWER = 'this turn was started by Olma, not by the user, so nobody has answered anything. Write nothing in their name: ask them, and record the answer only when THEY reply. A constraint with no ids and no windows is only a note and may still be saved.';
const WORDS = 'this turn was started by Olma, not by the user, so nobody asked for anything to be passed on. Send nothing to anybody in their name: ask THEM, and pass it on only when they reply and ask for it.';

async function ourTurn(client, user, message) {
  const since = selfInitiated.since(user.id);
  if (since === null) return null;
  const { rows: [u] } = await client.query('SELECT last_woke_at FROM users WHERE id = $1', [user.id]);
  if (u && u.last_woke_at && new Date(u.last_woke_at).getTime() >= since - OUR_TURN_SLACK_MS) return null;
  return err('forbidden', message, { reason: 'not_their_turn' });
}

// `table` maps a tool name to a predicate on its arguments: true means this
// call acts in their name. `mark` names the property the tests look for.
function guard(tools, table, message, mark) {
  for (const t of tools) {
    const acts = table[t.name];
    if (!acts) continue;
    const handler = t.handler;
    t.handler = async (client, user, a, ...rest) =>
      (acts(a || {}) && await ourTurn(client, user, message)) || handler(client, user, a, ...rest);
    t[mark] = true;
  }
  return tools;
}

module.exports = { guard, ourTurn, ANSWER, WORDS, OUR_TURN_SLACK_MS };
