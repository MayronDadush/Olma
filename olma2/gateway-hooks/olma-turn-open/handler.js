'use strict';
// Runs INSIDE the gateway process on every accepted inbound message
// (docs/automation/hooks.md, `message:received`). It is an observation
// point: nothing here can block or change the run, which is the point — the
// person's message is already on its way to the model, and this only makes
// brokerd aware of it a few seconds earlier than the model's first tool call.
//
// What travels: the agent id (from the session key), the message id, whether
// it was a voice note, the sender's display name. What does not: the text.
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

function agentIdOf(sessionKey) {
  const m = /^agent:(u-\d+):/.exec(String(sessionKey || ''));
  return m ? m[1] : null;
}

function isVoice(context) {
  const media = Array.isArray(context && context.media) ? context.media : [];
  return media.some((m) => /^audio\//i.test(String((m && (m.mimeType || m.contentType || m.type)) || '')));
}

// Exported for tests: `connect` is the one seam (net.connect in production).
function handle(event, { connect = net.connect, sock = SOCK } = {}) {
  if (!event || event.type !== 'message' || event.action !== 'received') { trace({ skip: 'not-received', type: event && event.type, action: event && event.action }); return false; }
  const agentId = agentIdOf(event.sessionKey);
  if (!agentId) { trace({ skip: 'no-agent', sessionKey: String(event.sessionKey || '').slice(0, 40) }); return false; }
  const ctx = event.context || {};
  const meta = ctx.metadata || {};
  const params = {
    agentId,
    messageId: ctx.messageId ? String(ctx.messageId) : null,
    kind: isVoice(ctx) ? 'voice' : 'text',
    senderName: meta.senderName ? String(meta.senderName).slice(0, 80) : null,
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
    socket.on('data', (d) => { clearTimeout(t); trace({ agentId, outcome: 'sent', reply: String(d).slice(0, 80) }); finish(true); try { socket.end(); } catch { /* gone */ } });
    socket.on('close', () => { clearTimeout(t); finish(done ? undefined : false); });
  });
}

module.exports = handle;
module.exports.default = handle;
module.exports.handle = handle;
module.exports.agentIdOf = agentIdOf;
module.exports.isVoice = isVoice;
