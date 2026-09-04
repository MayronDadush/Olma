'use strict';
// Acknowledgement-by-reaction: a 👀 on the person's own message the moment we
// start working, replaced by a mark that says how it ended.
//
// Why a reaction rather than a message: an ack that arrives as a MESSAGE costs
// the person a notification, a line in the chat, and — on our system — a slot
// against the daily proactive budget. A reaction costs none of those, and
// WhatsApp replaces a sender's previous reaction with their new one, so the
// whole lifecycle (working → done) occupies exactly one mark that mutates in
// place. There is nothing to clean up and nothing to un-send.
//
// ── The vocabulary is semantic, and that is the design ───────────────────────
// The obvious ask is "use lots of emoji so it feels alive". That makes it
// worse. If 👀 always means working and ✅ always means done, the reader learns
// the whole language in one exchange and afterwards reads state at a glance
// without opening the chat. If the same state cycles through 💪🫡👌🤘, the mark
// stops carrying information while still LOOKING like it carries information —
// so it costs attention and returns nothing. Variety belongs across STATES,
// never within one. Adding a sixth entry here is cheap; adding a second emoji
// for a state already in the table is what this comment exists to refuse.
const REACTION_STATES = Object.freeze({
  // Received, and the turn is going to take a noticeable moment. Ours regularly
  // do: a cold turn was measured at ~77s, against a 65s stuck-lane threshold.
  working: '👀',
  // 👍, not ✅. It says the thing they asked for is in hand — captured, done, or
  // already true. Gali's "בוצע" on 2026-09-03 is the case it exists for: Olma
  // completed the task inside the same second and showed her nothing, so she
  // wrote again 14 seconds later, and a third time 26 minutes after that.
  done: '👍',
  // Narrower than it was, and deliberately. ⏰ now means exactly one thing: a
  // reminder is armed on this and it will speak to you later. It used to cover
  // every future-dated write — tasks, calendar events — which made it the mark
  // for "diarised" in general and left a person unable to tell a row that will
  // reach out from one that will simply sit there.
  scheduled: '⏰',
  // The turn ended needing something only they can supply. Without this, a
  // blocked turn is indistinguishable from a slow one.
  needs_input: '❓',
  failed: '⚠️',
});

// Channels whose reaction support we have actually established, not assumed.
// whatsapp: verified on the box — `openclaw message react --channel whatsapp`
// returns ok on a --dry-run, and the plugin implements a real `react` action
// with emoji/remove/participant.
//
// Everything else starts false ON PURPOSE. The gateway advertises `--channel`
// for ~25 providers; that flag being accepted is not evidence the provider
// delivers a reaction. Flipping one of these to true is a claim, and the claim
// should be paid for with one --dry-run and one real send on that channel.
// A channel we are unsure about must degrade to sending nothing — never to a
// failed call on every single message.
const REACTION_CAPABLE = Object.freeze({
  whatsapp: true,
  imessage: false, // next in line; tapbacks exist, ours is unverified
  telegram: false,
  signal: false,
});

function isReactionCapable(channel) {
  return REACTION_CAPABLE[String(channel || '').toLowerCase()] === true;
}

// Portability is structural here rather than aspirational, which is worth
// stating because it is the reason this module is channel-agnostic at all.
// The inbound context that carries `messageId`, `senderE164` and `channelId`
// is built by the gateway's own `deriveInboundMessageHookContext` — which
// lives in the gateway CORE (dist/message-hook-mappers-*.js), not inside the
// WhatsApp plugin. So a future channel arrives in the same canonical shape,
// and adding it is a line in the table above plus a verification, not a port.
//
// Returns an argv array for `openclaw message react`, or null when we should
// stay silent. Null is a real answer and every caller must treat it as one.
function buildReactArgs({ channel, target, messageId, state, remove = false } = {}) {
  const emoji = REACTION_STATES[state];
  if (!emoji) return null;
  if (!isReactionCapable(channel)) return null;
  // A reaction is addressed to ONE message. Without an id there is nothing to
  // attach to, and there is no sane fallback — reacting to the wrong message
  // is worse than not reacting, because the mark would then assert something
  // about a message we never processed.
  if (!target || !messageId) return null;
  const args = [
    'message', 'react',
    '--channel', String(channel).toLowerCase(),
    '--target', String(target),
    '--message-id', String(messageId),
    '--emoji', emoji,
  ];
  if (remove) args.push('--remove');
  return args;
}

// Which mark a finished turn earns. Ordered by how much the reader needs to
// know: a failure outranks everything, and a turn that is waiting on them
// outranks a bare success, because only those two ask anything of them.
function outcomeState({ failed = false, needsInput = false, scheduled = false } = {}) {
  if (failed) return 'failed';
  if (needsInput) return 'needs_input';
  if (scheduled) return 'scheduled';
  return 'done';
}

// ── Placing the mark ─────────────────────────────────────────────────────────
// The half this module was missing, and the reason it sat unwired: an inbound
// message id. Reconstructed 2026-09-04, and the id turned out to have been in
// front of the model the whole time. The gateway opens every DM turn with a
// "Conversation info (untrusted metadata)" block, and on this version that
// block carries `message_id` — `shouldIncludeConversationInfo` is
// `!isDirect || Boolean(directChannelValue && directChannelValue !== "webchat")`,
// which for a WhatsApp DM is true. The model reads the block and hands the id
// to `turn_start`, which is exactly the route `sender_name` has travelled since
// 2026-08-22. So: no gateway hook, no in-process plugin — and, the actual
// point, no un-denying the `message` tool. That tool bundles `send`, a direct
// pipe around the outbox, the delivery gate, quiet hours, pause and the daily
// budget; a 👍 was never worth handing the model a way past the chokepoint.
//
// The id is UNTRUSTED, like everything else in that block, and the blast radius
// is bounded by construction rather than by belief: `target` is the user's own
// phone read from OUR database via the identity token, never anything the model
// supplied. The worst a wrong id can do is put an emoji on a different message
// in that same person's own chat with Olma.
const { spawn } = require('node:child_process');

// A mark may only be placed while the person is actually there — the same
// 15 minutes the delivery gate calls a conversation (outbox/gate.js
// CONVERSATION_GRACE_MS; `tests/reactions.test.js` fails if the two drift).
// This is what makes the feature structurally incapable of being an unsolicited
// ping: a reaction IS a notification on their phone, and one arriving at 02:00
// about a message from yesterday afternoon is outreach, whatever it looks like.
// Inside the window it is a reply to something they just sent, which is the
// one thing quiet hours have never applied to.
const LIVE_WINDOW_MS = 15 * 60_000;

// The id arrives as model-typed text out of an untrusted metadata block, so it
// is bounded before it is ever used. Nothing here is shell-quoting — `spawn`
// takes an argv array and there is no shell — it is about refusing the shapes
// that are obviously not an id: a whole sentence the model paraphrased, an
// empty string, an id with a newline in it. A bad id is silence, never a guess.
const MESSAGE_ID_RE = /^[\x21-\x7e]{4,200}$/;

function cleanMessageId(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return MESSAGE_ID_RE.test(s) ? s : null;
}

function isLive(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return false;
  const t = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= 0 && age < LIVE_WINDOW_MS;
}

// Fire-and-forget, deliberately, and each part of that costs something:
//
//   No await — `openclaw message react` is a whole Node CLI start-up, and a
//   decoration is worth zero milliseconds of somebody's reply.
//
//   Detached and unref'd — handlers run in brokerd, which outlives the turn, so
//   an attached child would PROBABLY survive. "Probably survives" is precisely
//   how an outbound send reports success and dies (CLAUDE.md, the MCP-shim
//   rule), and getting it right costs nothing.
//
//   Therefore no exit code, therefore no claim. This returns `attempted`, never
//   `sent`. Nothing downstream may read it as "they saw a ✅" — and that is why
//   no user-visible text anywhere depends on the mark having landed.
function placeMark(opts = {}, deps = {}) {
  const args = buildReactArgs(opts);
  if (!args) return { attempted: false, reason: 'not_applicable' };
  const spawnFn = deps.spawn || spawn;
  try {
    const child = spawnFn('openclaw', args, { detached: true, stdio: 'ignore' });
    // An ENOENT on a box without the CLI arrives as an event, not a throw, and
    // an unhandled 'error' on a child process takes the whole daemon down.
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
  } catch {
    return { attempted: false, reason: 'spawn_failed' };
  }
  return { attempted: true, state: opts.state, emoji: REACTION_STATES[opts.state] };
}

// Which tools earn which mark. A table rather than calls sprinkled through the
// handlers, because the dispatcher is the one place every tool already passes
// through — and because the question "what does Olma react to?" should be
// answerable by reading eleven lines, not by grepping eighty handlers.
//
// Only `set_task_reminder` earns ⏰, because only it arms something that will
// later speak to the person unprompted (see REACTION_STATES). Everything else
// here ends with the request itself in hand and earns 👍 — the calendar write
// included. That is Miron's 2026-09-03 request, the one that took long enough
// that he wondered whether it had registered at all: 👀 the moment it arrives,
// 👍 when the event exists.
//
// A task that also gets a reminder passes through both rows and ends on ⏰. That
// ordering is the right way round and not an accident of the table: ⏰ is the
// more specific claim of the two, and it is the one the person acts on.
const TOOL_MARKS = Object.freeze({
  turn_start: 'working',
  complete_task: 'done',
  complete_shared_task: 'done',
  add_task: 'done',
  add_tasks_bulk: 'done',
  create_calendar_event: 'done',
  set_task_reminder: 'scheduled',
});

// The single decision, kept clear of sockets and spawns so it can be tested
// directly. Returns the mark to place, or null — and null is a real answer that
// the caller must treat as one, exactly like buildReactArgs.
//
// Not pure: it stamps the turn with what it has already asked for, because
// deduplicating a repeat needs memory and this is the only place that holds the
// turn. Kept here rather than in the caller so that every future caller inherits
// it instead of having to remember it.
//
// A FAILED tool call earns no mark at all, rather than ⚠️. The vocabulary has
// a `failed` state and this deliberately does not reach for it: a tool erroring
// is nearly always something Olma then explains in words, and a ⚠️ beside a
// perfectly good explanation reads as a second, worse failure. ⚠️ is reserved
// for a turn that ends with nothing said, which the dispatcher cannot see.
function markFor(toolName, result, turn, now = Date.now()) {
  const state = TOOL_MARKS[toolName];
  if (!state) return null;
  if (!result || !result.ok) return null;
  if (!turn || !turn.messageId) return null;
  if (!isLive(turn.lastInboundAt, now)) return null;
  // A model that calls `turn_start` twice in one turn asks for the same 👀
  // twice: 2 of the first 10 marked messages in production did, 22 and 37
  // seconds apart. WhatsApp SETS a reaction rather than appending one, so the
  // repeat costs the reader nothing and the box a whole Node CLI start-up —
  // which is the only reason this is a tidy-up and not a bug fix.
  //
  // Keyed on message AND state, never on message alone: 👀 then 👍 on one
  // message is a progression the person is meant to see, and a coarser key
  // would swallow the second half of every conversation's only real signal.
  const seen = turn.marked || (turn.marked = new Set());
  const stamp = `${turn.messageId}:${state}`;
  if (seen.has(stamp)) return null;
  seen.add(stamp);
  return state;
}

module.exports = {
  REACTION_STATES, REACTION_CAPABLE, TOOL_MARKS, LIVE_WINDOW_MS,
  isReactionCapable, buildReactArgs, outcomeState, placeMark, markFor, isLive,
  cleanMessageId,
};
