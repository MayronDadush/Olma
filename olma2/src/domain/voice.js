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
const flags = require('./flags');
const { ok, err } = require('./results');

// Who the personal page may OFFER a call to. This is not a second security
// boundary — the bridge refuses a number it does not serve however the dial
// arrives — it is a release valve, so the button can be finished and wired
// while nobody sees it. Empty list, nobody: the tile draws itself "בקרוב"
// exactly as it did before this shipped.
const PAGE_CALL_PHONES_FLAG = 'dashboard_call_phones';

async function pageCallAllowed(client, user) {
  if (!user || !user.phone) return false;
  const raw = (await flags.getFlag(client, PAGE_CALL_PHONES_FLAG)) ?? '';
  return String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    .includes(user.phone);
}

function dialUrl() {
  return process.env.VOICE_BRIDGE_DIAL_URL || 'http://127.0.0.1:8792/dial';
}

// The probe is its own PATH on the same port, derived from the dial URL so a
// deployment that moved the bridge moves both together. It is a path and not a
// flag on /dial deliberately: olma2 and the bridge ship on separate workflows,
// so a probe can reach a bridge that predates it — a `probe: true` field an old
// /dial simply ignores would ring somebody's phone to answer a question about
// rendering a card. A 404 from an old bridge is the harmless answer, and
// callAvailable reads it as "could not ask".
function probeUrl() {
  return dialUrl().replace(/\/dial(?=$|[?#])/, '/probe');
}

async function askBridge(payload, deps = {}, timeoutMs = 8000, url = dialUrl()) {
  const doFetch = deps.fetch || fetch;
  const ctrl = new AbortController();
  // The bridge answers in milliseconds when up; a hung socket must not eat
  // the MCP shim's 30s budget, so give up well before it.
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return { res, body: await res.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

// Would a call to this person go through — asked without placing one.
//
// THREE values, never two: true (the bridge serves this number), false (it
// refuses it) and null (we could not ask). `null` is not `false`: a bridge
// that is down, absent, or slow means we do not know, and rendering "calls are
// not available for you" off an unanswered socket would tell someone their
// feature is gone every time the process restarts. The card simply omits the
// line on null — a check that declines to judge says nothing rather than
// something wrong (CLAUDE.md, "A thing that could not be READ").
//
// Short timeout on purpose: this runs while a card is being rendered, not
// while a person waits for a phone to ring.
async function callAvailable(user, deps = {}) {
  if (!user || !user.phone) return null;
  try {
    const { res, body } = await askBridge({ phone: user.phone }, deps, 2000, probeUrl());
    if (res.ok && body.ok) return true;
    // A refusal the bridge actually made is an answer. Anything else — a 500,
    // a 404 from a bridge too old to have /probe, a body we cannot read — is not.
    if (res.status === 403) return false;
    return null;
  } catch { return null; }
}

async function requestCall(client, user, deps = {}) {
  let res, body;
  try {
    ({ res, body } = await askBridge({ phone: user.phone }, deps));
  } catch {
    return err('unavailable', 'voice calls are not available right now (bridge unreachable)');
  }
  if (!res.ok || !body.ok) {
    return err('unavailable', body.error || `voice bridge refused (${res.status})`);
  }
  await audit.record(client, user.id, 'voice.call_requested', { callSid: body.callSid || null });
  return ok({ calling: true });
}

module.exports = { requestCall, callAvailable, dialUrl, probeUrl, pageCallAllowed, PAGE_CALL_PHONES_FLAG };
