'use strict';
// Runs INSIDE the gateway process on every accepted inbound message
// (docs/automation/hooks.md, `message:received`). It is an observation
// point: nothing here can block or change the run, which is the point — the
// person's message is already on its way to the model, and this only makes
// brokerd aware of it a few seconds earlier than the model's first tool call.
//
// What travels: the agent id (from the session key), the message id, whether
// it was a voice note, the sender's display name, and the id of the message
// they replied to when they used WhatsApp reply. What does not: the text.
// brokerd has no use for it and the shim never sent it either.
//
// Fire-and-forget over the unix socket with a short timeout. brokerd being
// down is not this hook's problem: the model's own turn_start (or the
// implicit opener on its first tool call) still opens the turn as before.
const net = require('node:net');

const SOCK = process.env.OLMA_SOCK || '/opt/olma2/run/brokerd.sock';
// Two clocks, not one. The brokerd budget starts when the socket CONNECTS;
// before that a separate, longer cap covers a socket that never does. One
// clock from the start was wrong in a way the trace could finally show
// (2026-09-07, u-3): the 2s timer fired at 3.8s with `connected:false`. A
// timer that fires late means the gateway's own event loop was blocked — its
// pre-model bookkeeping for a heavy user runs seconds — and when the loop
// came back the timer ran before the connect callback and destroyed a socket
// that was about to succeed. Eleven of the first ~200 opens died that way,
// every one with nothing on brokerd's side, because none ever reached it.
// The gateway runs this hook through `fireAndForgetHook`, so nobody is kept
// waiting by a longer cap; it only bounds how long a socket may sit unopened.
const TIMEOUT_MS = 2000;      // from connect: brokerd's answer
const CONNECT_CAP_MS = 10000; // from start: a socket that never connects
// One bounded line per event, next to the socket, so "did the hook run" is a
// question with an answer. Shape only: type, action, agent, outcome. Never the
// text, never the sender. Best-effort; a failed write is not this hook's job.
const TRACE = process.env.OLMA_HOOK_TRACE || '/opt/olma2/run/turn-open-hook.log';
function trace(fields) {
  try { require('node:fs').appendFileSync(TRACE, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n'); } catch { /* best effort */ }
}

// One line at import time, so "was THIS file loaded, by which process" is
// answerable from the trace alone.
trace({ loaded: true, pid: process.pid, file: __filename });

function agentIdOf(sessionKey) {
  const m = /^agent:(u-\d+):/.exec(String(sessionKey || ''));
  return m ? m[1] : null;
}

// `received` carries a `media` array; `preprocessed` carries a flat
// `mediaType` (and a `transcript` once a voice note was transcribed).
function isVoice(context) {
  const c = context || {};
  const media = Array.isArray(c.media) ? c.media : [];
  if (media.some((m) => /^audio\//i.test(String((m && (m.mimeType || m.contentType || m.type)) || '')))) return true;
  if (/^audio\//i.test(String(c.mediaType || ''))) return true;
  return typeof c.transcript === 'string' && c.transcript.trim() !== '';
}

// WhatsApp reply. The event carries no `replyToId` field on OpenClaw 2026.8.1
// (the mapper that builds the preprocessed context drops it), but the `body`
// it does carry is the channel's envelope line, and the WhatsApp channel
// writes the quoted message into it as
//   [Replying to <sender> id:<message id>]\n<quoted text>\n[/Replying]
// Only the id is read out of that — the quoted text stays in the gateway
// like everything else here. A future gateway that puts `replyToId` on the
// event wins over the parse. Why brokerd needs it at all: the prompt the
// `before_prompt_build` plugin sees is the bare text (measured 2026-09-06 —
// the Conversation info block with `reply_to_id` is attached to the prompt
// AFTER that hook), so for the people whose turn opens in the prompt this is
// the only place the reply is visible before the model runs.
const REPLY_MARKER_RE = /\[Replying to [^\]\n]*?\bid:([^\s\]]+)\]/;
function replyToIdOf(context) {
  const c = context || {};
  const direct = c.replyToId || c.replyToIdFull;
  if (direct) return String(direct).slice(0, 80);
  const m = REPLY_MARKER_RE.exec(String(c.body || ''));
  return m ? m[1].slice(0, 80) : null;
}

// ── A message that is only thanks ────────────────────────────────────────────
// "תודה" earns a reply, a sign-off and a good evening, and every one of those
// is a notification for an exchange that was already over. A 🙏 says the same
// thing for the price of nothing (brokerd places it; see domain/reactions.js),
// and the hint that rides the opening tells the model the mark is the answer.
//
// The classification happens HERE, inside the gateway, and only the BOOLEAN
// travels — the text stays on this side like everything else in this file.
//
// Deliberately strict, and the asymmetry is the whole design: a miss costs one
// "בשמחה", which is today's behaviour, while a false positive means Olma
// silently ignores something somebody actually asked. So the message must
// CONTAIN an explicit thanks and every other word must be on a short filler
// list; anything else — a question mark, a verb, a noun nobody listed — is not
// this. Long-form gratitude ("תודה על כל העזרה אתמול") takes the ordinary path
// on purpose.
const THANKS_WORD_RE = /^(תודה|תודות|thanks|thankyou|thank|thx|tnx|ty|merci)$/u;
const FILLER_WORD_RE = /^(רבה|ענק|ענקית|גדולה|לך|לכם|מראש|מעולה|סבבה|אחלה|מושלם|יאללה|אוקיי|אוקי|ok|okay|you|u|so|much|very|lots|lot|a|great|perfect|cool|nice)$/u;
const REPLY_BLOCK_RE = /\[Replying to[^\]]*\][\s\S]*?\[\/Replying\]/g;
const MAX_THANKS_WORDS = 5;

function thanksOnly(text) {
  const raw = String(text || '').replace(REPLY_BLOCK_RE, ' ');
  // A question is never a closed exchange, whatever else is in the sentence.
  if (/[?？]/.test(raw)) return false;
  // Everything that is not a letter or a space goes: punctuation, digits,
  // emoji and the direction marks WhatsApp sprinkles through Hebrew.
  const words = raw.replace(/[^\p{L}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_THANKS_WORDS) return false;
  let sawThanks = false;
  for (const w of words) {
    if (THANKS_WORD_RE.test(w)) { sawThanks = true; continue; }
    if (!FILLER_WORD_RE.test(w)) return false;
  }
  return sawThanks;
}

// Which inbound events open a turn. Measured on OpenClaw 2026.8.1 (2026-09-06,
// olma-hook-probe): a WhatsApp DM fires `message:preprocessed` ~300ms after
// the inbound log line and `agent:bootstrap` a second later — and NEVER
// `message:received`, which this hook had listened for alone while fifteen
// real messages went by. Both are accepted; a message id seen once is not
// opened twice should a later gateway fire both.
const OPENING_ACTIONS = new Set(['received', 'preprocessed']);
const SEEN_MAX = 500;
const seen = new Map(); // messageId → true, insertion-ordered, bounded
function seenBefore(messageId) {
  if (!messageId) return false;
  if (seen.has(messageId)) return true;
  seen.set(messageId, true);
  if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
  return false;
}

// Exported for tests: `connect` is the one seam (net.connect in production).
function handle(event, { connect = net.connect, sock = SOCK } = {}) {
  if (!event || event.type !== 'message' || !OPENING_ACTIONS.has(event.action)) { trace({ skip: 'not-inbound', type: event && event.type, action: event && event.action }); return false; }
  const agentId = agentIdOf(event.sessionKey);
  if (!agentId) { trace({ skip: 'no-agent', sessionKey: String(event.sessionKey || '').slice(0, 40) }); return false; }
  const ctx = event.context || {};
  const meta = ctx.metadata || {};
  const messageId = ctx.messageId ? String(ctx.messageId) : null;
  if (seenBefore(messageId)) { trace({ skip: 'duplicate', agentId, action: event.action }); return false; }
  // `received` puts the sender's name under metadata; `preprocessed` flattens it.
  const senderName = meta.senderName || ctx.senderName;
  const params = {
    agentId,
    messageId,
    kind: isVoice(ctx) ? 'voice' : 'text',
    senderName: senderName ? String(senderName).slice(0, 80) : null,
    replyToId: replyToIdOf(ctx),
    // The transcript when there is one — a voice note that says only "תודה"
    // is the same exchange — and the envelope body otherwise.
    thanks: thanksOnly(ctx.transcript || ctx.body),
    at: new Date(event.timestamp || Date.now()).toISOString(),
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    // `ms` from the start and `connectMs` for when the socket opened, on every
    // line: the gap between them is the gateway's own stall, and what follows
    // `connectMs` is brokerd's.
    const started = Date.now();
    let connected = false;
    let connectMs = null;
    let socket;
    try { socket = connect(sock); } catch { return finish(false); }
    const timing = () => ({ ms: Date.now() - started, connected, ...(connectMs === null ? {} : { connectMs }) });
    const giveUp = () => { try { socket.destroy(); } catch { /* gone */ } trace({ agentId, outcome: 'timeout', ...timing() }); finish(false); };
    let t = setTimeout(giveUp, CONNECT_CAP_MS);
    socket.on('error', (e) => { clearTimeout(t); trace({ agentId, outcome: 'error', ...timing(), error: String(e && e.code || e).slice(0, 40) }); finish(false); });
    socket.on('connect', () => {
      connected = true;
      connectMs = Date.now() - started;
      clearTimeout(t);
      t = setTimeout(giveUp, TIMEOUT_MS);
      socket.write(JSON.stringify({ id: 1, method: 'turn_open', params }) + '\n');
    });
    // Resolve BEFORE ending the socket: a synchronous 'close' would otherwise
    // settle the promise as a failure that already succeeded.
    socket.on('data', (d) => { clearTimeout(t); trace({ agentId, outcome: 'sent', ...timing(), replyTo: Boolean(params.replyToId), thanks: params.thanks, reply: String(d).slice(0, 80) }); finish(true); try { socket.end(); } catch { /* gone */ } });
    socket.on('close', () => { clearTimeout(t); finish(done ? undefined : false); });
  });
}

module.exports = handle;
module.exports.default = handle;
module.exports.handle = handle;
module.exports.agentIdOf = agentIdOf;
module.exports.isVoice = isVoice;
module.exports.replyToIdOf = replyToIdOf;
module.exports.thanksOnly = thanksOnly;
module.exports._resetSeen = () => seen.clear();
