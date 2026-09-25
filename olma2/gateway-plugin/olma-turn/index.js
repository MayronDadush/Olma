// Olma turn context — an OpenClaw plugin, loaded into the gateway process.
//
// Phase B of "the turn opens itself" (CLAUDE.md, "Data you must not get
// wrong"). The internal hook (gateway-hooks/olma-turn-open) already opens
// the turn on brokerd the moment a message is accepted; this asks brokerd
// for what `turn_start` would have RETURNED — directive, locale, the
// onboarding opener, hints — and prepends it to the prompt on
// `before_prompt_build`, so for the people the `turn_context_phones` flag
// covers the model reads its opening instead of spending a model call to
// fetch it. A reply with no tool call at all is then still counted, hinted
// and marked.
//
// What leaves the gateway: the agent id, the session key, the trigger and
// provider names, and one boolean (did the prompt carry a reply_to_id).
// Never the prompt, never the transcript.
//
// Fails open, always: brokerd down, slow, or answering anything but a
// context means the prompt goes out untouched, and the doctrine variant
// tells the model to call `turn_start` when no block is there. A prompt
// hook that can delay or break a reply is worse than no hook.
//
// Plain object rather than `definePluginEntry` from the SDK on purpose:
// the SDK helper is a passthrough (it adds a lazy configSchema getter), and
// importing it makes the module untestable outside the gateway's jiti
// loader. The manifest (openclaw.plugin.json) carries the config schema.
import net from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";

// Every path under /opt/olma2/run is read PER CALL, never captured at load:
// the suite runs on the box inside deploy.sh, tests/helpers.js points these
// at a temp dir, and a constant captured at import decided whether that took
// by require order. And under the test runner a write to the real one is
// refused outright rather than best-effort: on 2026-09-15 a test registered
// this plugin and overwrote the stamp config_guard reads to tell a restarted
// gateway from one still running the old build, with a record that said the
// gate was live (incidents.md, "The test suite stamped the gateway as live").
const RUN_DIR = "/opt/olma2/run/";
function sockPath() { return process.env.OLMA_SOCK || RUN_DIR + "brokerd.sock"; }
function tracePath() { return process.env.OLMA_PLUGIN_TRACE || RUN_DIR + "turn-context-plugin.log"; }
function stampPath() { return process.env.OLMA_PLUGIN_REGISTER_STAMP || RUN_DIR + "turn-context-plugin.registered"; }
export function refuseProductionWrite(file) {
  if (process.env.NODE_TEST_CONTEXT && String(file).startsWith(RUN_DIR)) {
    throw new Error(`olma-turn: a test may not write ${file} — set OLMA_PLUGIN_REGISTER_STAMP / OLMA_PLUGIN_TRACE (tests/helpers.js does)`);
  }
}
// One bounded line per prompt build, next to the socket — the hook's trace
// found the hook that never ran; this is the same tell for the plugin.
// What the RUNNING gateway registered, in a file of its own and OVERWRITTEN
// each time. Plugin code loads at gateway startup and `deploy.sh` deliberately
// does not restart it, so a new handler sits on disk, live and inert, until
// somebody restarts by hand — twice recorded here already, and for a hook that
// merely costs a model call. For a hook that keeps the model's working-out off
// a phone, "shipped" and "running" have to be tellable apart from the outside:
// `jobs/config-guard.checkReplyGateLive` reads this file and says which.
// A tail of the trace above cannot answer it — one busy day buries the last
// registration under thousands of per-prompt lines.
// Well under the gateway's 15s handler timeout, and under the ~4s the model
// used to spend on the turn_start round trip this replaces.
const TIMEOUT_MS = 4000;

export function trace(fields) {
  const file = tracePath();
  refuseProductionWrite(file);
  try { appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + "\n"); } catch { /* best effort */ }
}

export function stampRegistration(fields, file = stampPath()) {
  refuseProductionWrite(file);
  try { writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + "\n"); } catch { /* best effort */ }
}

// Which of our agents speak to somebody who writes Hebrew, as brokerd answered
// on that agent's last turn context. Tri-state per agent and ABSENT by default:
// an agent nobody has answered for is `undefined`, which arms nothing. That is
// the honest state for `intake` and `ggreet` in particular — the two agents
// that speak to people whose language nobody knows yet, and which never reach
// the person's `turn_context` path (the greeter's own branch below asks only
// for its room line).
const LANG = new Map();
export function rememberReader(agentId, value) {
  if (value === true || value === false) LANG.set(agentId, value);
  else LANG.delete(agentId);
}
export function readerOf(agentId) {
  return LANG.has(agentId) ? LANG.get(agentId) : null;
}
export function _resetReaders() { LANG.clear(); }

export function agentIdOf(sessionKey) {
  const m = /^agent:(u-\d+):/.exec(String(sessionKey || ""));
  return m ? m[1] : null;
}

// One request, one line, one reply — the same protocol as the hook. Resolves
// the parsed reply, or null on any failure or timeout; never rejects.
export function askBroker(method, params, { connect = net.connect, sock = sockPath(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let socket;
    try { socket = connect(sock); } catch { return finish(null); }
    const t = setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } finish(null); }, timeoutMs);
    let buf = "";
    socket.on("error", () => { clearTimeout(t); finish(null); });
    socket.on("connect", () => { socket.write(JSON.stringify({ id: 1, method, params }) + "\n"); });
    socket.on("data", (d) => {
      buf += String(d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(t);
      let reply = null;
      try { reply = JSON.parse(buf.slice(0, nl)); } catch { reply = null; }
      finish(reply);
      try { socket.end(); } catch { /* gone */ }
    });
    socket.on("close", () => { clearTimeout(t); finish(null); });
  });
}

// The handler, built once per gateway start. `agents` narrows it in the
// gateway's own config before brokerd narrows it per person — two gates,
// so a plugin enabled for everyone still does nothing for anyone the flag
// does not name, and a flag set for someone the plugin ignores changes
// nothing either (their doctrine then falls back to turn_start).
export function buildHandler({ agents, connect, sock, timeoutMs, log = trace } = {}) {
  const only = Array.isArray(agents) && agents.length ? new Set(agents.map(String)) : null;
  return async (event, ctx) => {
    // A ROOM's turn, first, and on its own route: brokerd draws the room's
    // coordination state and it is prepended exactly like a person's opening
    // (brokerd `group_turn_context` → domain/group-turn.js, which carries why).
    // Deliberately NOT narrowed by `agents`: that list is which PEOPLE get
    // their turn context, and a room inventing its own state is not a thing to
    // roll out person by person. `llm_input` below cannot do this — on
    // OpenClaw 2026.8.1 it is a void hook (fire-and-forget, its return value
    // dropped), so `before_prompt_build` is the only place a group turn can be
    // told anything.
    const group = GROUP_KEY_RE.exec(String((ctx && ctx.sessionKey) || ''));
    if (group) return groupTurnContext(group, { connect, sock, timeoutMs, log });
    // The DM greeter's turn: the one line about the room this newcomer came
    // from (brokerd `intake_context` → domain/intake-room.js). Not narrowed by
    // `agents` either — that list is which PEOPLE get their opening, and the
    // greeter speaks to nobody the list could name.
    const intake = INTAKE_KEY_RE.exec(String((ctx && ctx.sessionKey) || ''));
    if (intake) return intakeTurnContext(String(ctx.sessionKey), { connect, sock, timeoutMs, log });
    const agentId = (ctx && ctx.agentId) || agentIdOf(ctx && ctx.sessionKey);
    if (!agentId || !/^u-\d+$/.test(agentId)) return undefined;
    if (only && !only.has(agentId)) return undefined;
    const prompt = event && typeof event.prompt === "string" ? event.prompt : "";
    const params = {
      agentId,
      sessionKey: ctx && ctx.sessionKey ? String(ctx.sessionKey).slice(0, 120) : null,
      trigger: ctx && ctx.trigger ? String(ctx.trigger) : null,
      messageProvider: ctx && ctx.messageProvider ? String(ctx.messageProvider) : null,
      // A `reply_to_id` in the prompt would mean the person replied to one
      // specific message. On OpenClaw 2026.8.1 it is never here: the prompt
      // this hook sees is the bare text, and the Conversation info block that
      // carries `reply_to_id` is attached after it (measured 2026-09-06, the
      // context came back in its no-reply shape for a real quoted reply). The
      // reply reaches brokerd from the turn-open hook instead (it parses the
      // WhatsApp quote marker at preprocess time); this stays as a second
      // source for a gateway that changes the order, and `promptChars` in the
      // trace says which shape a given gateway hands over.
      replyTarget: /"reply_to_id"\s*:/.test(prompt),
    };
    const t0 = Date.now();
    const reply = await askBroker("turn_context", params, { connect, sock, timeoutMs });
    const ms = Date.now() - t0;
    if (!reply || reply.ok !== true) { log({ agentId, outcome: reply ? "refused" : "unreachable", ms }); return undefined; }
    if (!reply.enabled) { log({ agentId, outcome: "not-enabled", ms }); return undefined; }
    if (typeof reply.context !== "string" || !reply.context) { log({ agentId, outcome: "no-open", trigger: params.trigger, ms }); return undefined; }
    // The reader's language, for the gate below. Same turn, same agent, no
    // second socket — which is the only way `reply_payload_sending` can have
    // it at all, since it decides locally by design. Remembered rather than
    // re-asked because it is a property of the person, not of the turn, and a
    // turn that never reaches here (not covered, no open) simply leaves the
    // last known answer standing.
    rememberReader(agentId, reply.readerWritesHebrew);
    log({ agentId, outcome: "prepended", directive: reply.directive || null, chars: reply.context.length, promptChars: prompt.length, replyInPrompt: params.replyTarget, ms });
    return { prependContext: reply.context };
  };
}

// ---- the greeter's room line ------------------------------------------------
// Somebody a room sent to write "היי" in private reads the owner's opening copy
// first, and until 2026-09-25 nothing else: not a word about the group that
// sent them, so they wrote again before anything happened (`incidents.md`,
// "Twice 'היי' before a word about the room"). The greeter has no tools, so
// brokerd hands it the line. Fails open like everything here: no answer is the
// old greeting, never a turn that does not happen.
const INTAKE_KEY_RE = /^agent:intake:whatsapp:direct:\+\d{7,15}$/;
async function intakeTurnContext(sessionKey, { connect, sock, timeoutMs, log = trace } = {}) {
  const t0 = Date.now();
  const reply = await askBroker("intake_context", { sessionKey }, { connect, sock, timeoutMs });
  const ms = Date.now() - t0;
  if (!reply || reply.ok !== true) { log({ intake: reply ? "refused" : "unreachable", ms }); return undefined; }
  if (typeof reply.context !== "string" || !reply.context) { log({ intake: "no-room", ms }); return undefined; }
  log({ intake: "prepended", groupId: reply.groupId || null, meetingId: reply.meetingId || null, ms });
  return { prependContext: reply.context };
}

// ---- a room's own turn context ---------------------------------------------
// The room's coordination state, into the prompt of every turn its agent
// takes. The group agent has three tools that would tell it the truth and no
// reason on any given turn to reach for one, so it answered the room from its
// own conversation history: "2 of 4 group members answered" where three people
// were in the room and nobody had answered, and "there is already a
// coordination open" 74 seconds after the only one was cancelled (2026-09-19,
// `docs/incidents.md`, "The room heard its own state from memory").
//
// The greeter (`ggreet`) gets nothing: it speaks for a room that is still
// locked, and everything a locked room hears is fixed text on the raw pipe.
// Fails open exactly like the person's path — brokerd down, slow or refusing
// means the prompt goes out untouched, and the room is back to the state this
// fixes rather than a turn that does not happen.
async function groupTurnContext(match, { connect, sock, timeoutMs, log = trace } = {}) {
  const agentId = match[1];
  if (!/^g-\d+$/.test(agentId)) return undefined;
  const t0 = Date.now();
  const reply = await askBroker("group_turn_context", { agentId, externalId: match[2] }, { connect, sock, timeoutMs });
  const ms = Date.now() - t0;
  if (!reply || reply.ok !== true) { log({ group: agentId, turn: reply ? "refused" : "unreachable", ...(reply && reply.error ? { error: String(reply.error) } : {}), ms }); return undefined; }
  // A locked room answers `context: null` and says why — the same distinction
  // the rest of this repo keeps: nothing to say is not the same observation as
  // could not be read.
  if (typeof reply.context !== "string" || !reply.context) { log({ group: agentId, turn: "no-context", state: reply.state || null, ms }); return undefined; }
  log({ group: agentId, turn: "prepended", chars: reply.context.length, ms });
  return { prependContext: reply.context };
}

// ---- group context ---------------------------------------------------------
// The second thing this plugin does, since 2026-09-06: for a GROUP turn (the
// greeter's or a group agent's) it reads the `Conversation info` block out
// of the model's input on `llm_input` and hands it to brokerd as
// `group_context` — subject, roster, sender, was she tagged, message id.
// That block is the only place the gateway still says who is in the room:
// the transcript keeps the bare text, the preprocessed hook's context drops
// `GroupMembers`, and the directory command does not do WhatsApp. The sweep
// (jobs/groups.js) reads brokerd's row where it used to read the store.
// Nothing is returned to the gateway; the prompt goes out untouched.
// The jid is captured since 2026-09-19: the group's own turn context is drawn
// per ROOM, and brokerd is told which room by the two names in this key — the
// agent and the jid — because one of them alone is a lookup that trusts the
// caller.
const GROUP_KEY_RE = /^agent:(ggreet|g-\d+):whatsapp:group:([^:\s]+@g\.us)$/;
const CONVERSATION_INFO_RE = /Conversation info[^\n]*\n```json\n([\s\S]*?)\n```/;
const CONVERSATION_INFO_RE_G = new RegExp(CONVERSATION_INFO_RE.source, "g");

// The same walk as domain/group-context.parseConversationInfo (the suite
// holds the two together); a copy because this module must load in the
// gateway's own loader with nothing of ours beside it.
export function findConversationInfo(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const m = CONVERSATION_INFO_RE.exec(value);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findConversationInfo(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value)) {
      const found = findConversationInfo(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// EVERY block in a payload, not the first — the first is not the best.
// Measured on the first live group message (2026-09-06 16:56): the block in
// `prompt` carried the sender and nothing else, and taking it meant never
// looking at the one the gateway builds with the roster in it. A hook payload
// holds several descriptions of the same turn and only some are complete.
export function findAllConversationInfo(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") {
    for (const m of value.matchAll(CONVERSATION_INFO_RE_G)) {
      try { out.push(JSON.parse(m[1])); } catch { /* not ours */ }
    }
    return out;
  }
  if (Array.isArray(value) || typeof value === "object") {
    for (const v of Object.values(value)) findAllConversationInfo(v, out, depth + 1);
  }
  return out;
}

// Which of them describes the turn best. The roster is the whole point, so it
// outranks everything; the message id (a reply can quote it) comes next. A tie
// keeps the earlier candidate, so the source order below decides.
export function scoreInfo(info) {
  if (!info || typeof info !== "object") return -1;
  return (typeof info.group_members === "string" && info.group_members ? 4 : 0)
    + (typeof info.group_subject === "string" && info.group_subject ? 2 : 0)
    + (typeof info.message_id === "string" && info.message_id ? 1 : 0);
}

export function buildGroupContextHandler({ connect, sock, timeoutMs, log = trace } = {}) {
  return async (event, ctx) => {
    const sessionKey = String((ctx && ctx.sessionKey) || "");
    const m = GROUP_KEY_RE.exec(sessionKey);
    if (!m) return undefined;
    const agentId = m[1];
    // Where the block sits is the gateway's business and has moved before
    // (before_prompt_build sees none of it at all). So: every block in every
    // field, and the richest one wins. History newest first — the runtime
    // context for THIS turn rides at the end of the snapshot, and an older
    // message must never be read as the current one.
    const history = Array.isArray(event && event.historyMessages) ? [...event.historyMessages].reverse() : null;
    const sources = [
      ["prompt", event && event.prompt],
      ["system", event && event.systemPrompt],
      ["history", history],
    ];
    const candidates = [];
    for (const [name, value] of sources) {
      for (const found of findAllConversationInfo(value)) candidates.push({ where: name, info: found });
    }
    if (!candidates.length) {
      log({ group: agentId, outcome: "no-block", promptChars: typeof event?.prompt === "string" ? event.prompt.length : 0, history: history ? history.length : 0 });
      return undefined;
    }
    let best = candidates[0];
    for (const c of candidates) if (scoreInfo(c.info) > scoreInfo(best.info)) best = c;
    const info = best.info;
    const where = best.where;
    // The keys of every candidate, so a gateway that stops carrying the roster
    // is a line in this log rather than a group that never registers. Keys
    // only: the values are a real room's phone numbers.
    const seen = candidates.map((c) => `${c.where}:${Object.keys(c.info).join("|")}`);
    const t0 = Date.now();
    const reply = await askBroker("group_context", { agentId, sessionKey: sessionKey.slice(0, 200), info, at: Date.now() }, { connect, sock, timeoutMs });
    log({
      group: agentId, where, members: Boolean(info.group_members), mentioned: info.was_mentioned === true,
      outcome: reply && reply.ok === true ? "stored" : (reply ? "refused" : "unreachable"),
      ...(reply && reply.error ? { error: String(reply.error) } : {}),
      ...(info.group_members ? {} : { seen }), ms: Date.now() - t0,
    });
    return undefined;
  };
}

// ---- a message in the room that never named her ----------------------------
// The fourth thing this plugin does, since 2026-09-19. `before_dispatch` is a
// CLAIMING hook: a handler answering `{handled: true}` ends the message there
// and no model turn is ever started. That is what makes "she reads the room
// without answering it" a fact about the runtime rather than a sentence in a
// prompt asking her not to speak — and the stamp that opens her fifteen-minute
// window for that room's coordination is taken on the way past
// (brokerd `group_room_write` → `domain/group-context.noteMemberWrote`).
//
// **The room's words never leave the gateway.** The decision is made HERE, from
// the body, and brokerd is told the sender, the room and one boolean. Which
// means this is a port of `group-context.addressedToHer`, like `gateReply` below
// is a port of `domain/reply-leak.js` — and `tests/group-untagged.test.js`
// holds one corpus against both and fails on the first disagreement.
//
// It errs in ONE direction. Anything that might be addressed to her is let
// through: a false "addressed" is the behaviour we already have, and a false
// "not addressed" is her going silent on somebody who really did ask her
// something. brokerd refuses the claim for any room not named in
// `group_untagged_rooms` (empty by default), so until somebody flips that flag
// this handler only writes a line to the trace — which is what the verdict is
// measured against, beside the gateway's own `was_mentioned` on the line after.
const SELF_DIGITS = () => String(process.env.OLMA_WA_NUMBER || "972559347282").replace(/\D/g, "");

export function addressedToHer({ body, replyToSender } = {}, selfDigits = SELF_DIGITS()) {
  const self = String(selfDigits || "").replace(/\D/g, "");
  if (self.length < 7) return true;
  const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");
  return digits(replyToSender).includes(self) || digits(body).includes(self);
}

export function buildRoomWriteHandler({ connect, sock, timeoutMs = 1500, log = trace } = {}) {
  return async (event, ctx) => {
    try {
      const key = String((event && event.sessionKey) || (ctx && ctx.sessionKey) || "");
      const m = GROUP_KEY_RE.exec(key);
      if (!m || !/^g-\d+$/.test(m[1])) return undefined;
      const body = typeof (event && event.body) === "string" ? event.body
        : (typeof (event && event.content) === "string" ? event.content : "");
      const addressed = addressedToHer({ body, replyToSender: event && event.replyToSender });
      const t0 = Date.now();
      const reply = await askBroker("group_room_write", {
        agentId: m[1], externalId: m[2],
        senderId: String((event && event.senderId) || "").slice(0, 120),
        addressed, at: Date.now(),
      }, { connect, sock, timeoutMs });
      // `senderShape` and `addressed` are the measurement: the llm_input line
      // for the same message carries the gateway's own `mentioned`, so the two
      // verdicts sit next to each other in the trace on real traffic. Never the
      // body, and never the number — only whether it ended in one.
      log({
        room: m[1], addressed, senderShape: /@lid\b/i.test(String((event && event.senderId) || "")) ? "lid" : "phone",
        ...(reply && reply.ok === true
          ? { stamped: reply.stamped === true, sender: reply.sender === true, claim: reply.claim === true }
          : { outcome: reply ? "refused" : "unreachable", ...(reply && reply.error ? { error: String(reply.error) } : {}) }),
        ms: Date.now() - t0,
      });
      // Fails open in the only direction that is safe: anything but an explicit
      // claim lets the message through to the turn it would have had. And a
      // message THIS side read as addressed is never claimed whatever brokerd
      // answers — two independent refusals, because the failure they guard
      // against is her going silent on somebody who asked her something.
      if (addressed) return undefined;
      if (reply && reply.ok === true && reply.claim === true) return { handled: true };
      return undefined;
    } catch (e) {
      log({ room: "error", error: String((e && e.message) || e).slice(0, 200) });
      return undefined;
    }
  };
}

// ---- the reply gate --------------------------------------------------------
// The third thing this plugin does, since 2026-09-10: the last thing between
// the model's text and somebody's phone.
//
// Yahav asked for a reminder at 13:00 and read the deliberation that armed it
// — our column names, an ISO instant, a paragraph about the turn context, in
// English, about himself in the third person (`domain/reply-leak.js` carries
// the message and the reasoning; `docs/incidents.md`, "The working-out arrived
// instead of the message"). Third time in nine days that the model's own frame
// has been delivered as the message, and every previous answer was a sentence
// in the doctrine, which is a request and not a gate.
//
// `reply_payload_sending` is the gate, and it has been there all along: Modify
// / gate, "Mutate or cancel normalized reply payloads before delivery",
// running after payload normalization and before channel delivery. It needs no
// `allowConversationAccess` (it is not on that list) and it is not what
// `token-leak.js` checked on 2026-09-02, which is how it came to be recorded
// there that no outbound hook existed — and how two incidents in a row were
// designed around noticing a leak instead of stopping it.
//
// Everything below is a port of `src/domain/reply-leak.js`, function for
// function — a copy for the same reason `findConversationInfo` is one: this
// module loads in the gateway's own loader with nothing of ours beside it.
// `tests/reply-leak.test.js` runs both over one corpus and fails on the first
// disagreement.
const FRAME_RE = /<[｜|]DSML[｜|]|<\|?tool_calls?\|?>|\bolma_(?:tok|grp)_[0-9a-f]{8,}\b|\{"name":\s*"olma_[a-z_]+"/;
export const INTERNAL_NAMES = [
  "due_at", "new_due_at", "remind_at", "starts_at", "ends_at", "accepted_starts_at",
  "counter_starts_at", "expires_at", "sent_at", "last_inbound_at", "paused_at",
  "opening_sent_at", "timezone_asked_at", "holiday_quiet_asked_at", "first_turn_at", "last_wrote_at",
  "hold_reason", "paused_reason", "idempotency_key", "checkin_misses", "quiet_days",
  "auto_reminder", "is_eval", "name_confirmed", "holiday_calendar",
  "olma_identity", "identity_token", "agent_id", "session_key", "user_id",
  "message_id", "message_kind", "reply_to_id", "sender_name", "turn_start",
  "task_id", "parent_task_id", "reminder_id", "meeting_id", "event_id",
  "contact_id", "connection_id", "fact_id", "share_id", "option_id",
  "first_name", "last_name", "repeat_rule",
];
const INTERNAL_RE = new RegExp(`(?:^|[^A-Za-z0-9_])(${INTERNAL_NAMES.join("|")})(?![A-Za-z0-9_])`, "i");
const BLOCK_RE = /\b(?:Turn context|Conversation info|Reply target of current user message|OpenClaw heartbeat poll|unknown identity token|the hints? says?|(?:AGENTS|USER|MEMORY)\.md)\b|^\s*DELIVERY:/im;
const VOCAB_RE = "👀|👂|👍|⏰|🙏|❓|⚠️";
const MARK_RE = new RegExp(
  `(?:${VOCAB_RE})\\s*(?:בחזרה|חזרה בתגובה|בתגובה)`
  + `|(?:אשיב|אענה|אגיב|אשלח)\\s+(?:לו|לה|להם|)\\s*(?:${VOCAB_RE})`
  + `|(?:reply|respond|answer|react|send)(?:ing|s|ed)?\\s+(?:back\\s+)?(?:with|using)\\s+(?:a\\s+)?(?:${VOCAB_RE})`,
  "i");
const NARRATION_RE = /^[\s"״'׳]*(?:הוא|היא|הם|הן)\s+(?:אמרו|אמרה|אמר|כתבו|כתבה|כתב|הגיבו|הגיבה|הגיב|אומרים|אומרת|אומר|מבקשים|מבקשת|מבקש|שואלים|שואלת|שואל|עונים|עונה)(?![֐-׿])\s*["״'׳\d]|^\s*(?:he|she|they)\s+(?:said|wrote|replied)\s+["״'\d]/i;
const DELIB_VERBS = "check|see|look|verify|re-?check|figure|find|get|read|re-?read|try|compose|deliver|save|cancel|write|remove|update|confirm|start|first|also|just|search|call|fetch|proceed|think|handle|do|make|give|send|reply|respond|answer|draft|set|ask|follow|merge|create|add|mark|use|note|pull|run|open|archive";
const DELIB_LET_ME = `Let me(?: not| just| also| first)? (?:${DELIB_VERBS})`;
const DELIB_OPENER_RE = new RegExp("^\\s*(?:"
  + `${DELIB_LET_ME}|I'll (?:check|look|just|go|start|first|proceed|save|set|search|add|create|mention)`
  + "|Now I |But first|First, I'll|Now (?:create|save|check)|Also need to|Also,? I |No user message"
  + "|This (?:turn|is a delivery turn)|So they |Looking at the (?:turn context|today block|meeting status|context|hints?)"
  + "|The (?:intake note|reply target|reply was to|reminders? (?:were|was))"
  + ")\\b", "i");
const DELIB_MID_RE = new RegExp(`\\b(?:${DELIB_LET_ME}|I'll (?:save|set|add|create|proceed))\\b`, "i");
const DELIB_THIRD_RE = /^\s*(?:He|She|They|The user|The person)(?:'s)? (?:sent|asked|wants?|said|replied|wrote|has|hasn't|is|was|stated|message)\b/i;
const DELIB_TELL_RE = /["״'][^"״'\n]*[֐-׿][^"״'\n]*["״']|`|\b(?:tasks?|reminders?|the hints?|turn|digest|dashboard|contacts?|onboarding|meeting|opted|delete|archive|Let me|I'll|I should|I need|I replied|I answered)\b/i;
const DELIB_SOFT_RE = /^\s*(?:Actually|Wait|Hmm|OK|Okay|So)\b[,—\s-]*/i;
const DELIB_CUE_RE = /\b(?:let me|I need|I should|I can|I see|I don't|I answered|I asked|I never|he |she |they |him |his |their |the hints?|the turn|the intake)\b/i;
export function deliberationIn(raw, text) {
  const opener = DELIB_OPENER_RE.exec(text);
  if (opener) return opener[0];
  const mid = DELIB_MID_RE.exec(text);
  if (mid) return mid[0];
  const third = DELIB_THIRD_RE.exec(text);
  if (third && DELIB_TELL_RE.test(raw)) return third[0];
  const soft = DELIB_SOFT_RE.exec(text);
  if (soft && DELIB_CUE_RE.test(text)) return soft[0];
  return null;
}
// Ported from `domain/reply-leak.hebrewStepIn` (2026-09-23): the working-out
// in Hebrew, measured on 2,697 real messages. The reasoning is in the module.
const HEB_STEP_RE = /(?:^|[\s,.:;—-])(אני\s+(?:צריך|צריכה)\s+ל(?:הבין|הסביר|סמן|מצוא|החליט|ענות|כתוב|שמור))(?![֐-׿])/;
const HEB_OWN_RE = /(?:ההודעה|השאלה|התשובה) שלי(?![֐-׿])/;
export function hebrewStepIn(text) {
  const step = HEB_STEP_RE.exec(text);
  return step ? step[1] : null;
}
// Ported from `domain/reply-leak.englishToHebrewReader` — the tier that needs
// a fact the gate cannot work out: the LANGUAGE OF THE READER. It arrives on
// the `turn_context` this same plugin already fetches (`readerWritesHebrew`),
// is remembered per agent in LANG below, and is a tri-state where only `true`
// arms anything.
const ENGLISH_WORD_RE = /[A-Za-z]{2,}/g;
const HEBREW_LETTER_RE = /[\u0590-\u05FF]/;
const MEDIA_LINE_RE = /^\s*MEDIA:/i;
const RELAYED_LINE_RE = /^\s*>/;
export const MIN_ENGLISH_WORDS = 4;
export function englishToHebrewReader(raw, text, readerWritesHebrew) {
  if (readerWritesHebrew !== true) return null;
  if (MEDIA_LINE_RE.test(raw)) return null;
  if (RELAYED_LINE_RE.test(raw)) return null;
  if (HEBREW_LETTER_RE.test(raw)) return null;
  const words = text.match(ENGLISH_WORD_RE) || [];
  if (words.length < MIN_ENGLISH_WORDS) return null;
  return words.slice(0, 6).join(" ");
}
const INSTANT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const SENTINEL_RE = /\bNO_REPLY\b/;
const SENTINEL_STRIP_RE = /\s*\bNO_REPLY\b\s*/g;
const IDENTIFIER_RE = /(?:^|[^A-Za-z0-9_/@])([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)(?![A-Za-z0-9_])/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const ADDRESS_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const QUOTED_RE = /["״'][^"״'\n]{1,80}["״']/g;
const TOKEN_RE = /\bolma_(?:tok|grp)_[0-9a-f]{8,}/g;
const KEEPS_LINE = new Set(["identifier", "sentinel", "narration", "hebrew-narration", "deliberation-tail"]);
const REPORT_ONLY = new Set(["identifier", "narration", "hebrew-narration"]);
const SENTINEL = "NO_REPLY";

export function scannable(line) {
  return String(line || "").replace(URL_RE, " ").replace(ADDRESS_RE, " ").replace(QUOTED_RE, " ");
}
export function redact(at) { return String(at || "").replace(TOKEN_RE, "olma_***"); }
export function leaksIn(line, { readerWritesHebrew = null } = {}) {
  const raw = String(line || "");
  const text = scannable(raw);
  const out = [];
  const frame = FRAME_RE.exec(raw);
  if (frame) out.push({ kind: "frame", at: redact(frame[0].slice(0, 40)) });
  const internal = INTERNAL_RE.exec(text);
  if (internal) out.push({ kind: "internal", at: internal[1] });
  const block = BLOCK_RE.exec(text) || BLOCK_RE.exec(raw);
  if (block) out.push({ kind: "block", at: block[0].trim().slice(0, 40) });
  const mark = MARK_RE.exec(text);
  if (mark) out.push({ kind: "mark", at: mark[0].trim().slice(0, 40) });
  const narration = NARRATION_RE.exec(raw);
  if (narration) out.push({ kind: "narration", at: narration[0].trim().slice(0, 40) });
  const deliberation = deliberationIn(raw, text);
  if (deliberation) out.push({ kind: "deliberation", at: deliberation.trim().slice(0, 40) });
  const hebrew = hebrewStepIn(text);
  if (hebrew) out.push({ kind: "hebrew", at: hebrew.slice(0, 40) });
  const instant = INSTANT_RE.exec(text);
  if (instant) out.push({ kind: "instant", at: instant[0] });
  const sentinel = SENTINEL_RE.exec(text);
  if (sentinel) out.push({ kind: "sentinel", at: sentinel[0] });
  if (!out.length) {
    const english = englishToHebrewReader(raw, text, readerWritesHebrew);
    if (english) out.push({ kind: "english", at: english.slice(0, 40) });
  }
  if (!out.length) {
    const id = IDENTIFIER_RE.exec(text);
    if (id) out.push({ kind: "identifier", at: id[1] });
  }
  if (!out.length) {
    const own = HEB_OWN_RE.exec(text);
    if (own) out.push({ kind: "hebrew-narration", at: own[0] });
  }
  return out;
}
export function drops(leaks) { return leaks.some((l) => !KEEPS_LINE.has(l.kind)); }

// Ported from `domain/reply-leak.hebrewReplyTail` (2026-09-25): a Hebrew reply
// with only an English next step on its end loses the tail, not the reply.
export function hebrewReplyTail(line, found) {
  const dropping = found.filter((l) => !KEEPS_LINE.has(l.kind));
  if (!dropping.length || !dropping.every((l) => l.kind === "deliberation")) return null;
  const at = dropping.map((l) => line.indexOf(l.at)).filter((i) => i >= 0);
  if (at.length !== dropping.length) return null;
  const head = line.slice(0, Math.min(...at));
  const before = scannable(head);
  if (!HEBREW_LETTER_RE.test(before) || /[A-Za-z]{2,}/.test(before)) return null;
  const kept = head.replace(/[\s,;:—–-]+$/, "");
  return kept.trim() ? kept : null;
}
export function hasEarlierContent(lines, i) {
  for (let j = 0; j < i; j++) if (lines[j].trim()) return true;
  return false;
}
export function paragraphEnd(lines, i) {
  let end = i;
  while (end + 1 < lines.length && lines[end + 1].trim()) end += 1;
  return end;
}
export function gateReply(text, { readerWritesHebrew = null } = {}) {
  const raw = String(text == null ? "" : text);
  if (raw.trim() === SENTINEL) return { action: "pass", text: raw, leaks: [], reported: [] };
  const lines = raw.split("\n");
  const found = lines.map((l) => leaksIn(l, { readerWritesHebrew }));
  for (let i = 0; i < lines.length; i++) {
    const head = hebrewReplyTail(lines[i], found[i]);
    if (head === null) continue;
    lines[i] = head;
    found[i] = found[i].map((l) => (l.kind === "deliberation" ? { ...l, kind: "deliberation-tail" } : l));
  }
  const reported = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const l of found[i]) reported.push({ ...l, line: i });
    const sentinelAfterNarration = found[i].some((l) => l.kind === "sentinel") && hasEarlierContent(lines, i);
    if (drops(found[i]) || sentinelAfterNarration) last = Math.max(last, paragraphEnd(lines, i));
  }
  const leaks = reported.filter((l) => !REPORT_ONLY.has(l.kind));
  if (!leaks.length) return { action: "pass", text: raw, leaks, reported };
  const kept = lines.slice(last + 1).join("\n").replace(SENTINEL_STRIP_RE, " ").trim();
  if (!kept) return { action: "cancel", text: "", leaks, reported };
  return { action: "trim", text: kept, leaks, reported };
}

// A reply that says it saved something — a PORT of `domain/phantom-save
// .claimedWrite`, held against it by `tests/phantom-save.test.js`. Only the
// word leaves the gateway, never the reply: brokerd alone knows whether a tool
// ran on this turn, and it files what it decides. Report-only, and never
// awaited — a reply must not wait on a question about itself.
const HE_CLAIM_RE = /(?:^|[^\u0590-\u05FF])[וש]?(רשמתי|שמרתי|הוספתי|קבעתי|עדכנתי|מחקתי|ביטלתי|תזמנתי|הגדרתי)(?![\u0590-\u05FF])/;
const EN_CLAIM_RE = /\bI(?:'ve| have)\s+(saved|added|noted|scheduled|updated|deleted|removed|cancel+ed|set)\b/i;
export function claimedWrite(text) {
  const s = String(text == null ? "" : text);
  const he = HE_CLAIM_RE.exec(s);
  if (he) return he[1];
  const en = EN_CLAIM_RE.exec(s);
  return en ? en[1].toLowerCase() : null;
}

// Whose text this gate is for: every agent that puts MODEL output in front of
// a person or a room. Not `main` — that is the session the raw pipe sends as
// (`channels/openclaw.sendRawMessage`), carrying the owner's own wording with
// no model in the path, and a gate can only ever damage those.
//
// `intake` is the DM greeter and it was missing here until 2026-09-19, while
// the comment above the test claimed it was covered — the name that was in the
// list is `ggreet`, the GROUP greeter, which is muted at the gateway for the
// whole time it exists and has never put a word in front of anybody. So the
// one agent here that speaks to a person who has never heard of Olma was the
// one agent the gate did not watch, and the first message a new user read was
// `הם לא משתתףתתייג:message_id:2A72C7B35E53CC579607` above the owner's opening
// copy (`docs/incidents.md`, "The greeter's own message id"). Every other
// reader of that person's first minutes is server-composed; this is the only
// model output in it, which is exactly why it needs the gate and not a line of
// prompt asking the model not to.
const GATED_AGENT_RE = /^agent:(u-\d+|g-\d+|ggreet|intake):/;

export function buildReplyGateHandler({ connect, sock, timeoutMs = 1500, log = trace } = {}) {
  return async (event, ctx) => {
    try {
      const sessionKey = String((event && event.sessionKey) || (ctx && ctx.sessionKey) || "");
      const m = GATED_AGENT_RE.exec(sessionKey);
      if (!m) return undefined;
      const payload = event && event.payload;
      const text = payload && typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) return undefined;
      const agentId = m[1];
      const verdict = gateReply(text, { readerWritesHebrew: readerOf(agentId) });
      // Read off what will actually be SENT — a claim inside notes the gate
      // just cut never reaches anybody. Only a person's own agent: a room has
      // no turn brokerd can speak for.
      const claim = /^u-\d+$/.test(agentId) && verdict.action !== "cancel" ? claimedWrite(verdict.text) : null;
      if (claim) askBroker("reply_claim", { agentId, word: claim }, { connect, sock, timeoutMs }).catch(() => {});
      if (verdict.action === "pass" && !verdict.reported.length) return undefined;
      // brokerd is asked only when something was found, so the ordinary reply
      // never waits on a socket. It is asked BEFORE the text goes (or does
      // not), because after a cancel there is nothing left to prove it
      // happened — and on a short deadline, because a wedged brokerd must
      // cost this reply a second and a half, not the fifteen the hook has.
      const report = {
        agentId, sessionKey: sessionKey.slice(0, 200), action: verdict.action,
        channel: (event && event.channel) || (ctx && ctx.channel) || null,
        leaks: verdict.reported.slice(0, 12).map((l) => ({ kind: l.kind, at: String(l.at).slice(0, 40), line: l.line })),
        chars: text.length, kept: verdict.text.length,
      };
      const reply = await askBroker("reply_gate", report, { connect, sock, timeoutMs });
      log({ gate: agentId, action: verdict.action, kinds: report.leaks.map((l) => l.kind).join(","), chars: report.chars, kept: report.kept, filed: Boolean(reply && reply.ok) });
      if (verdict.action === "pass") return undefined;
      if (verdict.action === "trim") return { payload: { ...payload, text: verdict.text } };
      // A cancel takes the media with it, and a schedule card is not the thing
      // that leaked — so when there is one, the text is emptied and the card
      // still lands. `cancelled_by_reply_payload_sending_hook` is only for a
      // payload that is nothing but the words.
      const hasMedia = Boolean(payload && (payload.mediaUrl || (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length) || payload.presentation || payload.location));
      if (hasMedia) return { payload: { ...payload, text: "" } };
      return { cancel: true, reason: "olma_reply_leak" };
    } catch (e) {
      // Fails open, like every other handler here: a gate that throws must
      // cost a leak we would have caught, never the reply itself.
      log({ gate: "error", error: String((e && e.message) || e).slice(0, 200) });
      return undefined;
    }
  };
}

export default {
  id: "olma-turn",
  name: "Olma turn context",
  description: "Prepends the turn's opening (what turn_start would return) to the prompt, from brokerd — for a group turn, the room's own coordination state; files what the gateway says about a group turn; keeps the model's working-out off a person's phone.",
  register(api) {
    const cfg = (api && api.pluginConfig) || {};
    const agents = Array.isArray(cfg.agents) ? cfg.agents : "all";
    const hooks = ["before_prompt_build", "llm_input", "before_dispatch", "reply_payload_sending"];
    trace({ registered: true, agents, hooks });
    stampRegistration({ agents, hooks });
    api.on("before_prompt_build", buildHandler({ agents: cfg.agents }));
    api.on("llm_input", buildGroupContextHandler());
    // Same argument as the reply gate for not narrowing by `cfg.agents`: this
    // is about what a ROOM may do to her, not about rolling a person out.
    api.on("before_dispatch", buildRoomWriteHandler());
    // Deliberately NOT narrowed by `cfg.agents`: that list is which people get
    // their turn context in the prompt, and a reply reaching the wrong person
    // is not a thing to roll out per person.
    api.on("reply_payload_sending", buildReplyGateHandler());
  },
};
