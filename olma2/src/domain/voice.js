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

// Two lifetime attempts, ever — not a windowed daily/hourly allowance, so
// quota_counters' shape does not fit. Each dashboard-initiated call is asked
// to run no longer than this, matching Twilio's own per-minute billing
// boundary the owner had in mind.
const CALL_ATTEMPTS_LIMIT = 2;
const CALL_MAX_DURATION_SEC = 120;

// Same staged-rollout shape as mail.requireMailAccess / google-connect-gate:
// admin always allowed (they need to try this before anyone else is exposed
// to it), then 'all' opens it to everyone, otherwise a CSV allowlist.
async function pageCallAllowed(client, user) {
  if (!user || !user.phone) return false;
  if (user.role === 'admin') return true;
  const raw = String((await flags.getFlag(client, PAGE_CALL_PHONES_FLAG)) ?? '').trim();
  if (raw.toLowerCase() === 'all') return true;
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    .includes(user.phone);
}

async function attemptsRemaining(client, userId) {
  const { rows } = await client.query(
    `SELECT voice_call_attempts_used FROM users WHERE id = $1`, [userId]);
  const used = rows[0] ? Number(rows[0].voice_call_attempts_used) : 0;
  return { used, limit: CALL_ATTEMPTS_LIMIT, remaining: Math.max(0, CALL_ATTEMPTS_LIMIT - used) };
}

async function recordCallAttempt(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET voice_call_attempts_used = voice_call_attempts_used + 1
     WHERE id = $1 RETURNING voice_call_attempts_used`, [userId]);
  return rows[0] ? Number(rows[0].voice_call_attempts_used) : null;
}

// Idempotent — a second click after "sent" no-ops, the same "once ever,
// stamped on the person" doctrine as timezone_asked_at / opening_sent_at.
async function requestMoreCalls(client, userId) {
  const { rows } = await client.query(
    `UPDATE users SET voice_more_requested_at = now()
     WHERE id = $1 AND voice_more_requested_at IS NULL
     RETURNING voice_more_requested_at`, [userId]);
  if (rows[0]) await audit.record(client, userId, 'voice.more_requested', {});
  return ok({ requested: true, alreadyRequested: !rows[0] });
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

// opts.maxDurationSec is optional and additive: only the dashboard call path
// sends it (capping the lifetime-limited calls at CALL_MAX_DURATION_SEC).
// The chat tool (`call_me_on_the_phone`) calls this with no opts at all, so
// its wire payload — and therefore its behavior against whatever the bridge's
// own VOICE_ENABLED_PHONES allows today — is unchanged by this addition.
async function requestCall(client, user, deps = {}, opts = {}) {
  let res, body;
  const payload = { phone: user.phone };
  if (opts.maxDurationSec) payload.maxDurationSec = opts.maxDurationSec;
  try {
    ({ res, body } = await askBridge(payload, deps));
  } catch {
    return err('unavailable', 'voice calls are not available right now (bridge unreachable)');
  }
  if (!res.ok || !body.ok) {
    return err('unavailable', body.error || `voice bridge refused (${res.status})`);
  }
  await audit.record(client, user.id, 'voice.call_requested', { callSid: body.callSid || null });
  return ok({ calling: true });
}

module.exports = {
  requestCall, callAvailable, dialUrl, probeUrl, pageCallAllowed, PAGE_CALL_PHONES_FLAG,
  attemptsRemaining, recordCallAttempt, requestMoreCalls, CALL_ATTEMPTS_LIMIT, CALL_MAX_DURATION_SEC,
};
