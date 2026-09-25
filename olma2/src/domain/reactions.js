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
  // The same beat as `working`, for a voice note — Miron's ask on 2026-09-04,
  // and it earns a row rather than being a second emoji for `working` (which
  // the rule above refuses) because it carries information 👀 cannot: a voice
  // note has to be UPLOADED and TRANSCRIBED before anything can read it, and
  // that is the part most likely to fail silently. 👂 says the audio arrived,
  // not merely that a turn opened. "I saw it" and "I heard it" are different
  // claims about different things.
  listening: '👂',
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
  // They said thank you and nothing else. A sixth STATE rather than a second
  // emoji for `working` (which the comment above refuses), because it carries
  // what 👀 cannot: 👀 says "I am on it" and promises a reply, 🙏 says the
  // exchange is closed and promises nothing. It is the whole answer — the turn
  // that receives it is told to say nothing at all (domain/turn.turnHints),
  // which is the point: "בשמחה יהב, שיהיה ערב טוב" is a notification for a
  // conversation that had already ended.
  thanks: '🙏',
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
// ── Changing the vocabulary without changing the code ────────────────────────
// The table above is the DEFAULT, not the whole story: an operator can swap any
// single state's emoji from the dashboard (settings section, one box per
// state, stored as the `reaction_emoji` flag). Miron asked for 👍 instead of ✅ on `done`, and a taste like that
// should not need a deploy.
//
// This does not reopen what the comment at the top of this file refuses. That
// rule is about VARIETY WITHIN one state — 💪 today and 🫡 tomorrow for the same
// thing, which costs attention and returns nothing. An override is still
// exactly one emoji per state, held steady, and the whole vocabulary stays
// learnable in one exchange. What changes is who picks it.
//
// Anything that is not a plausible emoji is IGNORED rather than sent: a typo,
// a pasted sentence, an empty box. The default stands and the feature keeps
// working — a bad setting must never turn into a failed call on every message.
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}]{1,8}$/u;

function isUsableEmoji(value) {
  return typeof value === 'string' && EMOJI_RE.test(value.trim());
}

// The vocabulary in force: defaults with any valid override applied. Returns a
// plain object, never mutating REACTION_STATES (which is frozen and is what
// every test and every reader means by "the default").
function vocabulary(overrides) {
  const out = { ...REACTION_STATES };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const [state, emoji] of Object.entries(overrides)) {
    if (!Object.hasOwn(REACTION_STATES, state)) continue; // no inventing states
    if (isUsableEmoji(emoji)) out[state] = String(emoji).trim();
  }
  return out;
}

// The one decision about WHAT to react with, shared by both transports: the
// gateway socket and the CLI behind it. Null when we should stay silent, and
// null is a real answer every caller must treat as one. `emoji` overrides the
// table for this one call; an unusable one falls back to the default rather
// than refusing, so a bad setting never costs a mark.
function buildReactRequest({ channel, target, messageId, state, remove = false, emoji: override } = {}) {
  const emoji = isUsableEmoji(override) ? String(override).trim() : REACTION_STATES[state];
  if (!emoji) return null;
  if (!REACTION_STATES[state]) return null;
  if (!isReactionCapable(channel)) return null;
  // A reaction is addressed to ONE message. Without an id there is nothing to
  // attach to, and there is no sane fallback — reacting to the wrong message
  // is worse than not reacting, because the mark would then assert something
  // about a message we never processed.
  if (!target || !messageId) return null;
  return {
    channel: String(channel).toLowerCase(),
    target: String(target),
    messageId: String(messageId),
    emoji,
    remove: Boolean(remove),
  };
}

// Returns an argv array for `openclaw message react`, or null.
function buildReactArgs(opts) {
  const req = buildReactRequest(opts);
  if (!req) return null;
  const args = [
    'message', 'react',
    '--channel', req.channel,
    '--target', req.target,
    '--message-id', req.messageId,
    '--emoji', req.emoji,
  ];
  if (req.remove) args.push('--remove');
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
const gatewayRpc = require('../channels/gateway-rpc');

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
//   No await — a decoration is worth zero milliseconds of somebody's reply, so
//   the caller is answered before the mark has gone anywhere.
//
//   Therefore no claim. This returns `attempted`, never `sent`. Nothing
//   downstream may read it as "they saw a ✅" — and that is why no user-visible
//   text anywhere depends on the mark having landed.
//
// ── The gateway's socket first, the CLI behind it ───────────────────────────
// Until 2026-09-25 every mark was a whole `openclaw message react` process:
// 15s of Node start-up idle (2026-09-05), 54s measured on a busy box the day it
// was replaced. Once the gateway's own instant ack went (2026-09-14, rules
// "The acknowledgement mark is OURS ALONE"), that start-up WAS the 👀's
// latency, and a short reply beat it: the owner, "הרבה פעמים האייקון של
// העיניים מגיע אחרי שמגיעה כבר הודעה" (`incidents.md`, "The eyes arrived after
// the answer"). The CLI never did anything but start up and then call
// `message.action` on the gateway's WebSocket, so `channels/gateway-rpc
// .messageAction` makes that same call on the socket brokerd already holds.
//
// The fallback is the raw pipe's (`channels/openclaw.sendRawMessage`) and as
// narrow: a request that never reached the gateway (switched off, no socket,
// cooling off, and always inside `node --test`) goes down the CLI; one the
// gateway refused, or that timed out on the wire, is logged and left. A
// reaction retried is harmless on its own — WhatsApp replaces it — but a slow
// CLI retry of a 👀 is exactly the late mark this exists to stop.
//
// The CLI, when it runs, is detached and unref'd: handlers run in brokerd,
// which outlives the turn, so an attached child would PROBABLY survive.
// "Probably survives" is precisely how an outbound send reports success and
// dies (CLAUDE.md, the MCP-shim rule), and getting it right costs nothing.
//
// ── Two marks on one message must never race ─────────────────────────────────
// A short turn asks for 👀 at turn_start and 👍 a few seconds later. On the
// CLI both are alive at once and whichever finishes LAST decides what the
// person sees — a 👀 landing after the 👍 leaves "working" on a message that is
// done, for ever. Miron saw the shape of it: his "deleted" text arrived before
// the 👍.
//
// So one in-flight mark per message. On the socket a newer mark waits for the
// older one to be answered and then goes — milliseconds, and the order is the
// order they were asked in. On the CLI a newer mark kills the older child if it
// has not exited: a 👀 that could not land before the work finished was never
// needed, and the 👍 goes out sooner. If the older child has already exited,
// the newer mark simply replaces it on the phone, which is the lifecycle this
// feature was built on. Killing is best-effort and claim-free, like everything
// else here.
const inFlight = new Map(); // messageId → { child } | { promise }

// Injectable for the suite, which must be able to assert on what was said
// without a journal — and so a test never writes into the on-box one.
let log = (line) => console.log(line);
let logError = (line) => console.error(line);
function _setLogs(out, err) { log = out || log; logError = err || logError; }

// `deps.rpc` is the suite's door onto the socket path. Left out, the real one
// is used only where it can be — `gateway-rpc.available()` is false in a test
// process, so no test reaches the live gateway by forgetting to stub it.
function placeMark(opts = {}, deps = {}) {
  const req = buildReactRequest(opts);
  if (!req) return { attempted: false, reason: 'not_applicable' };
  const rpc = deps.rpc !== undefined ? deps.rpc
    : (gatewayRpc.available() ? gatewayRpc.messageAction : null);
  const out = rpc ? placeViaGateway(req, opts, rpc, deps) : placeViaCli(req, opts, deps);
  if (!out.attempted) return out;
  return { attempted: true, state: opts.state, emoji: REACTION_STATES[opts.state], ...(out.superseded ? { superseded: true } : {}) };
}

// Stops a CLI child still starting up for this message. An RPC entry is never
// stopped — it is milliseconds from done, and the newer mark queues behind it.
function supersede(key) {
  const prev = inFlight.get(key);
  if (!prev || !prev.child || prev.exited) return false;
  prev.killed = true;
  try { if (typeof prev.child.kill === 'function') prev.child.kill(); } catch { /* already gone */ }
  inFlight.delete(key);
  return true;
}

function placeViaGateway(req, opts, rpc, deps) {
  const key = req.messageId;
  const superseded = supersede(key);
  const prev = inFlight.get(key);
  const before = prev && prev.promise ? prev.promise : Promise.resolve();
  log(`[reactions] ${opts.state} → ${key}${superseded ? ' (superseded a mark still starting up)' : ''} via gateway`);
  const entry = {};
  entry.promise = before.then(() => rpc({
    channel: req.channel,
    action: 'react',
    params: {
      chatJid: req.target,
      messageId: req.messageId,
      emoji: req.emoji,
      ...(req.remove ? { remove: true } : {}),
    },
  })).then(
    () => {},
    (err) => {
      // Never reached the gateway: the CLI is a clean retry — unless a newer
      // mark for this message has been asked for since, which says more than
      // this one and is already on its way. A REFUSAL placed nothing either,
      // and for a mark that IS the answer (👍, 🙏, ⏰) the slow pipe is still
      // worth it: a gateway that refused every react took every mark with it
      // for fifteen minutes on 2026-09-25. Not for the 👀 — through the CLI it
      // lands after the reply it was promising. A timeout may have gone out,
      // and stays a log line.
      const refusedAnswer = err && err.refused === true && !DELAYABLE_OPENING.has(opts.state);
      if (err && (err.dispatched === false || refusedAnswer)) {
        if (inFlight.get(key) !== entry) return;
        inFlight.delete(key);
        placeViaCli(req, opts, deps, { fallback: err.message });
        return;
      }
      logError(`[reactions] ${opts.state} ${key} failed via gateway: ${err && err.message}`);
    },
  ).finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  });
  inFlight.set(key, entry);
  return { attempted: true, ...(superseded ? { superseded: true } : {}) };
}

function placeViaCli(req, opts, deps, { fallback } = {}) {
  const args = buildReactArgs(opts);
  const spawnFn = deps.spawn || spawn;
  const key = req.messageId;
  const superseded = supersede(key);
  try {
    const child = spawnFn('openclaw', args, { detached: true, stdio: 'ignore' });
    // ── Say what was tried, and say when it failed ────────────────────────────
    // This function makes no delivery claim and nothing downstream reads its
    // result, which is right — but it also wrote no line anywhere, and that is
    // how a mark that never left the box stayed indistinguishable from one on
    // somebody's phone. The gateway logs what it SENDS; without an attempt line
    // here there is nothing to compare that against, so "no reaction" could not
    // be told from "no attempt" (`incidents.md`, "The mark that never moved" —
    // and the shape above it in CLAUDE.md: null and [] must never collapse).
    // A trace, not an alarm: one line per mark asked for, one more only when
    // the CLI exits non-zero.
    log(`[reactions] ${opts.state} → ${key}${superseded ? ' (superseded a mark still starting up)' : ''} via cli${fallback ? ` (gateway: ${fallback})` : ''}`);
    // An ENOENT on a box without the CLI arrives as an event, not a throw, and
    // an unhandled 'error' on a child process takes the whole daemon down.
    const entry = { child, exited: false, killed: false };
    if (child && typeof child.on === 'function') {
      child.on('error', (e) => {
        entry.exited = true;
        if (inFlight.get(key) === entry) inFlight.delete(key);
        logError(`[reactions] ${opts.state} ${key} could not start: ${e && e.message}`);
      });
      child.on('exit', (code, signal) => {
        entry.exited = true;
        if (inFlight.get(key) === entry) inFlight.delete(key);
        // A killed child is the normal end of a superseded mark, not a failure.
        if (entry.killed) return;
        if (code !== 0) logError(`[reactions] ${opts.state} ${key} failed: exit ${code} signal ${signal}`);
      });
    }
    if (child && typeof child.unref === 'function') child.unref();
    inFlight.set(key, entry);
  } catch (e) {
    logError(`[reactions] ${opts.state} ${key} could not spawn: ${e && e.message}`);
    return { attempted: false, reason: 'spawn_failed' };
  }
  return { attempted: true, ...(superseded ? { superseded: true } : {}) };
}

// ── The opening mark waits for a slow answer ────────────────────────────────
// A 👀 means "I'm on it". Under a reply that has already arrived it means
// nothing, and measured on 123 real messages (2026-09-15..25) that was most of
// them: a quarter were answered inside 10s, and the 👀 landed AFTER the reply
// in 57 of 77. So the owner's rule (2026-09-25): the opening mark goes on only
// if nothing has answered within `eyes_delay_seconds` (default 15). brokerd
// holds the timer; a reply, a closing mark or the end of the turn cancels it
// (`incidents.md`, "The eyes arrived after the answer").
//
// Only the two marks that PROMISE an answer wait. 🙏 on a thanks and the 👍 of
// a "stop reminding me" are the answer, and go on at once.
const DELAYABLE_OPENING = new Set(['working', 'listening']);
// A bare "תודה" right after Olma asked them something is their ANSWER — to
// "להוסיף לך את המשימה ליומן?" it most likely means yes (owner, 2026-09-26) —
// so it gets no 🙏 and no silence, and the model decides what it meant. The
// question has to be recent: after this long, a thanks closes the day.
const THANKS_AFTER_QUESTION_MS = 3 * 60 * 60 * 1000;

const EYES_DELAY_FLAG = 'eyes_delay_seconds';
const MAX_EYES_DELAY_S = 120;

// `endSignalsLive` is false while the gateway runs a plugin from before the
// turn signals existed: nothing would ever cancel the timer, so every message
// would get a 👀 fifteen seconds in whether or not it had been answered. Then
// the mark goes on at once, as it did before this existed.
function openingDelayMs(state, flagValue, endSignalsLive) {
  if (!DELAYABLE_OPENING.has(state) || !endSignalsLive) return 0;
  const n = Number(flagValue);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_EYES_DELAY_S) * 1000;
}

// Is the running gateway's plugin one that says when a reply goes out and when
// a turn ends? Read off the stamp the plugin writes at register (the same file
// `config-guard.checkReplyGateLive` reads), per call with a minute's cache —
// a gateway restart is what makes it true, and nothing tells brokerd one
// happened. Unreadable is false: the honest fallback is the old immediate 👀.
const TURN_END_HOOK = 'agent_end';
const STAMP_CACHE_MS = 60_000;
let stampCache = { at: 0, live: false };
function endSignalsLive({ now = Date.now(), readFileSync = require('node:fs').readFileSync } = {}) {
  if (now - stampCache.at < STAMP_CACHE_MS) return stampCache.live;
  let live = false;
  try {
    const file = process.env.OLMA_PLUGIN_REGISTER_STAMP || '/opt/olma2/run/turn-context-plugin.registered';
    const rec = JSON.parse(String(readFileSync(file, 'utf8')));
    live = Array.isArray(rec.hooks) && rec.hooks.map(String).includes(TURN_END_HOOK);
  } catch { live = false; }
  stampCache = { at: now, live };
  return live;
}
function _resetStampCache() { stampCache = { at: 0, live: false }; }

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

  // ── In hand: captured, done, or already true ────────────────────────────
  complete_task: 'done',
  complete_shared_task: 'done',
  add_task: 'done',
  add_tasks_bulk: 'done',
  add_subtask_to_shared: 'done',
  create_calendar_event: 'done',

  // The undo-shaped asks — "delete that", "stop reminding me", "change it to
  // Tuesday", "forget that" — are done the moment the tool returns, exactly
  // like a capture, and the person reads the same 👍. Added 2026-09-05 after
  // Miron deleted a task by reply and got a 👍 AND a sentence saying so.
  archive_task: 'done',
  restore_task: 'done',
  cancel_reminder: 'done',
  cancel_live_update: 'done',
  edit_task: 'done',
  update_calendar_event: 'done',
  delete_calendar_event: 'done',
  forget_fact: 'done',

  // What Olma HOLDS about them and the people around them. Silent bookkeeping
  // by design — `save_contact` says so in as many words — so the save is the
  // whole answer and a sentence restating it is a second notification.
  remember_fact: 'done',
  save_contact: 'done',
  forget_contact: 'done',
  set_contact_label: 'done',

  // How Olma should BEHAVE, as opposed to what she should hold: "בימי שבת אל
  // תשלח לי תזכורות ולא כלום" (Miron, 2026-09-10). It was saved as quiet_days
  // inside the same second and he read a sentence back — because these were
  // not in this table, so no 👍 was placed, so the result never carried
  // `markPlaced`, so nothing told the model the fact had already been
  // conveyed. The model was not overruling the mark; it never saw one.
  //
  // Same argument as the undo-shaped row above: a rule about how to work is
  // done when the row is written, with nothing pending and nothing waiting on
  // the person. `set_my_timezone` and `set_my_name` belong here despite
  // carrying hints of their own, because those hints are CONDITIONAL and fire
  // on the rare call where something was repaired — which is precisely the
  // case `markPlaced` already tells the model to write about.
  remember_preference: 'done',
  forget_preference: 'done',
  set_my_timezone: 'done',
  set_my_name: 'done',
  set_my_language: 'done',
  set_assistant_persona: 'done',
  set_digest_preferences: 'done',
  set_calendar_task_sync: 'done',
  // `record_meeting_constraint` was here until 2026-09-20 and is now in the
  // negotiation family below the table: it can only be called while a meeting
  // is negotiating, and Maya's "לא יכולה ביום שני" got a 👍 that said "noted"
  // about an answer nobody had recorded (`incidents.md`, "The constraint that
  // was an answer"). The tool now declines what the constraint rules out, and
  // a decline is a negotiation step — the same reason respond_to_meeting_slot
  // has no row.
  set_meeting_title: 'done',
  // The two the room had first (2026-09-25). Each is in hand when it returns
  // and waits on nobody — a place and a minimum are settings of the table,
  // not a step in the negotiation over it.
  set_meeting_place: 'done',
  set_meeting_minimum: 'done',

  // Doors this person opens and closes on their own account. Opening one
  // returns a LINK and is excluded below; closing one is just closed.
  disconnect_calendar: 'done',
  disconnect_google_contacts: 'done',
  set_connection_feature: 'done',
  revoke_connection: 'done',

  // The ACTOR's own exit from something shared, in hand the moment the tool
  // returns — unlike PROPOSING or NEGOTIATING one, where the table on offer
  // is still changing underneath them and stays unmarked below.
  // `create_shared_meeting_event` is the confirmed write itself, same shape
  // as `create_calendar_event` above it.
  revoke_share: 'done',
  respond_to_share: 'done',
  opt_out_of_meeting: 'done',
  cancel_meeting: 'done',
  create_shared_meeting_event: 'done',

  // ── ⏰: armed, and it will speak to them later ──────────────────────────
  set_task_reminder: 'scheduled',
  subscribe_live_updates: 'scheduled',
  // The generalised definition, not a special case: this row does not just
  // sit there, it will proactively reach THIS person again — the answer fans
  // back out to the requester by name (respond_to_connection_request).
  // `send_message_to_connection` looks identical at the call site and stays
  // unmarked below for exactly the opposite reason: nothing ever notifies the
  // SENDER once their message lands, so a mark there would be a claim nothing
  // backs.
  request_connection: 'scheduled',
});

// ── What is deliberately NOT here, and why ──────────────────────────────────
// The owner's rule is that a person should not collect messages, and anything
// that can end in a like should (2026-09-10). Four families still cannot, and
// each is a different reason — worth writing down, because the next reader
// will otherwise re-derive them one production sentence at a time. Family 2
// used to also hold `revoke_share`, `respond_to_share`, `opt_out_of_meeting`
// and `cancel_meeting` — those are the actor's own exit from something
// shared, done the moment the tool returns, and moved into the table above;
// what is left in family 2 is only what is still genuinely IN PROGRESS.
//
// 1. The result has to be SPOKEN. A link (`search_link`, `open_my_dashboard`,
//    every `start_*_connection`), a media path (`render_schedule_card`,
//    `generate_image`/`generate_video`), the digest block, the counts an
//    import returns. `domain/action-link.sendLinkVerbatim` exists because a
//    URL nothing says reaches nobody — a 👍 on one of these is Olma claiming
//    an action she then never delivered.
// 2. It is not finished, it is WAITING on somebody else. `share_task_with`,
//    `send_message_to_connection` ("say it is on its way, never that it
//    already arrived"), and every step of a meeting NEGOTIATION —
//    propose/respond/remove/settle, plus `respond_to_connection_request`
//    (the OTHER side's own decision). 👍 there says "done" about something
//    that is not. `request_connection` looks like it belongs here and does
//    not: it is ⏰ above, on the same generalised definition as
//    `subscribe_live_updates` — this row will proactively speak to THEM
//    again, which `send_message_to_connection` beside it structurally
//    cannot promise.
// 3. The tool's own result already asks, unconditionally, for words that
//    carry more than the mark: `pause_olma` (say plainly she will not write
//    again — silence is the one answer "stop" must never get), `resume_olma`
//    (what came back), `snooze_task` (the new date, struck through against the
//    old). An unconditional "say this" beside a conditional `markPlaced` is
//    the fault recorded in CLAUDE.md as "markPlaced is CONDITIONAL": the mark
//    is not ignored, it is outvoted. Moving one of these here means rewriting
//    its hint first, not just adding a row.
// 4. Reading is not doing — every `list_*`, `get_*`, `view_*` and `*_status`.
//    And `report_issue`, which is usually logged in passing while the real
//    answer is being written, so its 👍 would be about the side-effect.
//
// The cost of the additions is bounded and worth stating: `markFor` dedupes on
// message AND state, so a turn calling three marked tools still spawns ONE
// closing mark. What grows is the number of turns that get a closing mark at
// all — which is the point.

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
  // A voice note gets 👂 where a typed message gets 👀 — the opening mark only.
  // Every closing mark (done/scheduled) is about what the TURN achieved, which
  // is the same question however the message arrived.
  const effective = (state === 'working' && turn.messageKind === 'voice') ? 'listening' : state;
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
  const stamp = `${turn.messageId}:${effective}`;
  if (seen.has(stamp)) return null;
  seen.add(stamp);
  return effective;
}

// ── Is a 👍 STANDING on this message? ───────────────────────────────────────
// A different question from markFor's, and conflating the two is what put a
// sentence under a live thumbs-up on 2026-09-10. Gali answered a repeating
// reminder with "בירכתי אין צורך לתזכר"; the model did exactly the right
// thing — `cancel_reminder`, then `complete_task`, which is the sequence
// `complete_task`'s own description prescribes for ending a standing task —
// and she got the 👍 AND "בוצע 👍 שמתי שברכת — הכל סגור."
//
// markFor answers "should a mark be SPAWNED", and its dedup rightly says no
// the second time: a mark is a whole `openclaw` CLI start-up, and WhatsApp
// replaces a reaction rather than appending one, so an identical second mark
// costs 15 seconds and changes nothing on the screen. But brokerd hung the
// `markPlaced` hint off that same answer, so the LAST tool result the model
// reads before it writes — `complete_task` here — carried nothing at all.
// The model was not overruling the mark and was not ignoring a hint: at the
// moment it chose its words, nothing in front of it said a mark existed. It
// even typed a 👍 into the text, trying to deliver what the reaction already
// had.
//
// So the mark is recorded when it is asked for, and the hint follows THAT.
// The last state asked for on a message is the one standing on it: placeMark
// kills an older child still starting up when a newer mark arrives, and
// WhatsApp replaces whatever was there, so newest-requested wins. A 👍 that
// a later ⏰ replaced is no longer standing and must not be claimed.
function noteMarkAttempted(turn, state) {
  if (!turn || !turn.messageId || !state) return;
  const standing = turn.markStanding || (turn.markStanding = new Map());
  standing.set(turn.messageId, state);
}

// Keyed per message, like everything else on the turn: the shim's connection
// outlives the turn and serves the same `turn` object for hours, so anything
// latched to the connection instead of the message freezes (CLAUDE.md, "The
// mark that never moved").
function doneMarkStands(toolName, result, turn, now = Date.now()) {
  if (TOOL_MARKS[toolName] !== 'done') return false;
  if (!result || !result.ok) return false;
  if (!turn || !turn.messageId) return false;
  if (!isLive(turn.lastInboundAt, now)) return false;
  return Boolean(turn.markStanding && turn.markStanding.get(turn.messageId) === 'done');
}

// The flag the dashboard's emoji editor writes. One JSON object, one place.
const VOCAB_FLAG = 'reaction_emoji';

module.exports = {
  REACTION_STATES, REACTION_CAPABLE, TOOL_MARKS, LIVE_WINDOW_MS, VOCAB_FLAG,
  THANKS_AFTER_QUESTION_MS, EYES_DELAY_FLAG, TURN_END_HOOK, openingDelayMs, endSignalsLive, _resetStampCache,
  noteMarkAttempted, doneMarkStands,
  isReactionCapable, buildReactRequest, buildReactArgs, outcomeState, placeMark, markFor, isLive,
  cleanMessageId, vocabulary, isUsableEmoji, _setLogs,
};
