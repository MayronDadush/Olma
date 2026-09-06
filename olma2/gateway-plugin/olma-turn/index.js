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
import { appendFileSync } from "node:fs";

const SOCK = process.env.OLMA_SOCK || "/opt/olma2/run/brokerd.sock";
// One bounded line per prompt build, next to the socket — the hook's trace
// found the hook that never ran; this is the same tell for the plugin.
const TRACE = process.env.OLMA_PLUGIN_TRACE || "/opt/olma2/run/turn-context-plugin.log";
// Well under the gateway's 15s handler timeout, and under the ~4s the model
// used to spend on the turn_start round trip this replaces.
const TIMEOUT_MS = 4000;

export function trace(fields) {
  try { appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...fields }) + "\n"); } catch { /* best effort */ }
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

export default {
  id: "olma-turn",
  name: "Olma turn context",
  description: "Prepends the turn's opening (what turn_start would return) to the prompt, from brokerd; files what the gateway says about a group turn.",
  register(api) {
    const cfg = (api && api.pluginConfig) || {};
    trace({ registered: true, agents: Array.isArray(cfg.agents) ? cfg.agents : "all" });
    api.on("before_prompt_build", buildHandler({ agents: cfg.agents }));
    api.on("llm_input", buildGroupContextHandler());
  },
};
