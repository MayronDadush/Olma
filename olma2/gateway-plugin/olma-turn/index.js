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

const SOCK = process.env.OLMA_SOCK || "/opt/olma2/run/brokerd.sock";
// One bounded line per prompt build, next to the socket — the hook's trace
// found the hook that never ran; this is the same tell for the plugin.
const TRACE = process.env.OLMA_PLUGIN_TRACE || "/opt/olma2/run/turn-context-plugin.log";
// What the RUNNING gateway registered, in a file of its own and OVERWRITTEN
// each time. Plugin code loads at gateway startup and `deploy.sh` deliberately
// does not restart it, so a new handler sits on disk, live and inert, until
// somebody restarts by hand — twice recorded here already, and for a hook that
// merely costs a model call. For a hook that keeps the model's working-out off
// a phone, "shipped" and "running" have to be tellable apart from the outside:
// `jobs/config-guard.checkReplyGateLive` reads this file and says which.
// A tail of the trace above cannot answer it — one busy day buries the last
// registration under thousands of per-prompt lines.
const REGISTER_STAMP = process.env.OLMA_PLUGIN_REGISTER_STAMP || "/opt/olma2/run/turn-context-plugin.registered";
// Well under the gateway's 15s handler timeout, and under the ~4s the model
// used to spend on the turn_start round trip this replaces.
const TIMEOUT_MS = 4000;

export function trace(fields) {
  try { appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + "\n"); } catch { /* best effort */ }
}

export function stampRegistration(fields, file = REGISTER_STAMP) {
  try { writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + "\n"); } catch { /* best effort */ }
}

export function agentIdOf(sessionKey) {
  const m = /^agent:(u-\d+):/.exec(String(sessionKey || ""));
  return m ? m[1] : null;
}

// One request, one line, one reply — the same protocol as the hook. Resolves
// the parsed reply, or null on any failure or timeout; never rejects.
export function askBroker(method, params, { connect = net.connect, sock = SOCK, timeoutMs = TIMEOUT_MS } = {}) {
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
    log({ agentId, outcome: "prepended", directive: reply.directive || null, chars: reply.context.length, promptChars: prompt.length, replyInPrompt: params.replyTarget, ms });
    return { prependContext: reply.context };
  };
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
const GROUP_KEY_RE = /^agent:(ggreet|g-\d+):whatsapp:group:[^:\s]+@g\.us$/;
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
  "opening_sent_at", "timezone_asked_at", "first_turn_at", "last_wrote_at",
  "hold_reason", "paused_reason", "idempotency_key", "checkin_misses", "quiet_days",
  "auto_reminder", "is_eval", "name_confirmed",
  "olma_identity", "identity_token", "agent_id", "session_key", "user_id",
  "message_id", "message_kind", "reply_to_id", "sender_name", "turn_start",
  "task_id", "parent_task_id", "reminder_id", "meeting_id", "event_id",
  "contact_id", "connection_id", "fact_id", "share_id", "option_id",
  "first_name", "last_name", "repeat_rule",
];
const INTERNAL_RE = new RegExp(`(?:^|[^A-Za-z0-9_])(${INTERNAL_NAMES.join("|")})(?![A-Za-z0-9_])`, "i");
const BLOCK_RE = /\b(?:Turn context|Conversation info|Reply target of current user message|OpenClaw heartbeat poll|unknown identity token)\b|^\s*DELIVERY:/im;
const INSTANT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/;
const SENTINEL_RE = /\bNO_REPLY\b/;
const SENTINEL_STRIP_RE = /\s*\bNO_REPLY\b\s*/g;
const IDENTIFIER_RE = /(?:^|[^A-Za-z0-9_/@])([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)(?![A-Za-z0-9_])/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const ADDRESS_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const QUOTED_RE = /["״'][^"״'\n]{1,80}["״']/g;
const TOKEN_RE = /\bolma_(?:tok|grp)_[0-9a-f]{8,}/g;
const KEEPS_LINE = new Set(["identifier", "sentinel"]);
const SENTINEL = "NO_REPLY";

export function scannable(line) {
  return String(line || "").replace(URL_RE, " ").replace(ADDRESS_RE, " ").replace(QUOTED_RE, " ");
}
export function redact(at) { return String(at || "").replace(TOKEN_RE, "olma_***"); }
export function leaksIn(line) {
  const raw = String(line || "");
  const text = scannable(raw);
  const out = [];
  const frame = FRAME_RE.exec(raw);
  if (frame) out.push({ kind: "frame", at: redact(frame[0].slice(0, 40)) });
  const internal = INTERNAL_RE.exec(text);
  if (internal) out.push({ kind: "internal", at: internal[1] });
  const block = BLOCK_RE.exec(text);
  if (block) out.push({ kind: "block", at: block[0].trim().slice(0, 40) });
  const instant = INSTANT_RE.exec(text);
  if (instant) out.push({ kind: "instant", at: instant[0] });
  const sentinel = SENTINEL_RE.exec(text);
  if (sentinel) out.push({ kind: "sentinel", at: sentinel[0] });
  if (!out.length) {
    const id = IDENTIFIER_RE.exec(text);
    if (id) out.push({ kind: "identifier", at: id[1] });
  }
  return out;
}
export function drops(leaks) { return leaks.some((l) => !KEEPS_LINE.has(l.kind)); }
export function paragraphEnd(lines, i) {
  let end = i;
  while (end + 1 < lines.length && lines[end + 1].trim()) end += 1;
  return end;
}
export function gateReply(text) {
  const raw = String(text == null ? "" : text);
  if (raw.trim() === SENTINEL) return { action: "pass", text: raw, leaks: [], reported: [] };
  const lines = raw.split("\n");
  const found = lines.map(leaksIn);
  const reported = [];
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    for (const l of found[i]) reported.push({ ...l, line: i });
    if (drops(found[i])) last = Math.max(last, paragraphEnd(lines, i));
  }
  const leaks = reported.filter((l) => l.kind !== "identifier");
  if (!leaks.length) return { action: "pass", text: raw, leaks, reported };
  const kept = lines.slice(last + 1).join("\n").replace(SENTINEL_STRIP_RE, " ").trim();
  if (!kept) return { action: "cancel", text: "", leaks, reported };
  return { action: "trim", text: kept, leaks, reported };
}

// Whose text this gate is for: every agent that puts MODEL output in front of
// a person or a room. Not `main` — that is the session the raw pipe sends as
// (`channels/openclaw.sendRawMessage`), carrying the owner's own wording with
// no model in the path, and a gate can only ever damage those.
const GATED_AGENT_RE = /^agent:(u-\d+|g-\d+|ggreet):/;

export function buildReplyGateHandler({ connect, sock, timeoutMs = 1500, log = trace } = {}) {
  return async (event, ctx) => {
    try {
      const sessionKey = String((event && event.sessionKey) || (ctx && ctx.sessionKey) || "");
      const m = GATED_AGENT_RE.exec(sessionKey);
      if (!m) return undefined;
      const payload = event && event.payload;
      const text = payload && typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) return undefined;
      const verdict = gateReply(text);
      if (verdict.action === "pass" && !verdict.reported.length) return undefined;
      // brokerd is asked only when something was found, so the ordinary reply
      // never waits on a socket. It is asked BEFORE the text goes (or does
      // not), because after a cancel there is nothing left to prove it
      // happened — and on a short deadline, because a wedged brokerd must
      // cost this reply a second and a half, not the fifteen the hook has.
      const agentId = m[1];
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
  description: "Prepends the turn's opening (what turn_start would return) to the prompt, from brokerd; files what the gateway says about a group turn; keeps the model's working-out off a person's phone.",
  register(api) {
    const cfg = (api && api.pluginConfig) || {};
    const agents = Array.isArray(cfg.agents) ? cfg.agents : "all";
    const hooks = ["before_prompt_build", "llm_input", "reply_payload_sending"];
    trace({ registered: true, agents, hooks });
    stampRegistration({ agents, hooks });
    api.on("before_prompt_build", buildHandler({ agents: cfg.agents }));
    api.on("llm_input", buildGroupContextHandler());
    // Deliberately NOT narrowed by `cfg.agents`: that list is which people get
    // their turn context in the prompt, and a reply reaching the wrong person
    // is not a thing to roll out per person.
    api.on("reply_payload_sending", buildReplyGateHandler());
  },
};
