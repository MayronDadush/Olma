'use strict';
// Voice calls: the WhatsApp side of "תתקשרי אליי". The actual call — Twilio
// media stream, Hebrew STT/TTS, the live conversation — lives in the voice
// bridge, a separate process (/opt/olma2-voice-bridge) with its own blast
// radius, deliberately NOT part of olma2. This module only asks that bridge
// to dial, over a loopback-only HTTP port (8792) the internet cannot reach.
//
// The bridge is the judge of who may be called: it is hard-scoped to the
// numbers it serves and refuses everyone else, so this module never needs a
// user allowlist of its own that could drift out of sync. A refusal comes
// back as a plain err envelope the agent can relay honestly — never a throw,
// because "calls aren't available for you yet" is an answer, not a failure.
const audit = require('./audit');
const { ok, err } = require('./results');

function dialUrl() {
  return process.env.VOICE_BRIDGE_DIAL_URL || 'http://127.0.0.1:8792/dial';
}

async function requestCall(client, user, deps = {}) {
  const doFetch = deps.fetch || fetch;
  let res, body;
  try {
    const ctrl = new AbortController();
    // The bridge answers in milliseconds when up; a hung socket must not eat
    // the MCP shim's 30s budget, so give up well before it.
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      res = await doFetch(dialUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: user.phone }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(t); }
    body = await res.json().catch(() => ({}));
  } catch {
    return err('unavailable', 'voice calls are not available right now (bridge unreachable)');
  }
  if (!res.ok || !body.ok) {
    return err('unavailable', body.error || `voice bridge refused (${res.status})`);
  }
  await audit.record(client, user.id, 'voice.call_requested', { callSid: body.callSid || null });
  return ok({ calling: true });
}

module.exports = { requestCall, dialUrl };
