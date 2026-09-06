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
      // The gateway puts `reply_to_id` in the prompt's Conversation info block
      // ONLY when the person replied to one specific message. A yes/no about
      // the prompt's shape is all brokerd needs to hand back the hint.
      replyTarget: /"reply_to_id"\s*:/.test(prompt),
    };
    const t0 = Date.now();
    const reply = await askBroker("turn_context", params, { connect, sock, timeoutMs });
    const ms = Date.now() - t0;
    if (!reply || reply.ok !== true) { log({ agentId, outcome: reply ? "refused" : "unreachable", ms }); return undefined; }
    if (!reply.enabled) { log({ agentId, outcome: "not-enabled", ms }); return undefined; }
    if (typeof reply.context !== "string" || !reply.context) { log({ agentId, outcome: "no-open", trigger: params.trigger, ms }); return undefined; }
    log({ agentId, outcome: "prepended", directive: reply.directive || null, chars: reply.context.length, ms });
    return { prependContext: reply.context };
  };
}

export default {
  id: "olma-turn",
  name: "Olma turn context",
  description: "Prepends the turn's opening (what turn_start would return) to the prompt, from brokerd.",
  register(api) {
    const cfg = (api && api.pluginConfig) || {};
    trace({ registered: true, agents: Array.isArray(cfg.agents) ? cfg.agents : "all" });
    api.on("before_prompt_build", buildHandler({ agents: cfg.agents }));
  },
};
