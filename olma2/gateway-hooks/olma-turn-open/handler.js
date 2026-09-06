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
const TIMEOUT_MS = 2000;
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
    at: new Date(event.timestamp || Date.now()).toISOString(),
  };
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let socket;
    try { socket = connect(sock); } catch { return finish(false); }
    const t = setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } trace({ agentId, outcome: 'timeout' }); finish(false); }, TIMEOUT_MS);
    socket.on('error', (e) => { clearTimeout(t); trace({ agentId, outcome: 'error', error: String(e && e.code || e).slice(0, 40) }); finish(false); });
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 1, method: 'turn_open', params }) + '\n');
    });
    // Resolve BEFORE ending the socket: a synchronous 'close' would otherwise
    // settle the promise as a failure that already succeeded.
    socket.on('data', (d) => { clearTimeout(t); trace({ agentId, outcome: 'sent', replyTo: Boolean(params.replyToId), reply: String(d).slice(0, 80) }); finish(true); try { socket.end(); } catch { /* gone */ } });
    socket.on('close', () => { clearTimeout(t); finish(done ? undefined : false); });
  });
}

module.exports = handle;
module.exports.default = handle;
module.exports.handle = handle;
module.exports.agentIdOf = agentIdOf;
module.exports.isVoice = isVoice;
module.exports.replyToIdOf = replyToIdOf;
module.exports._resetSeen = () => seen.clear();
