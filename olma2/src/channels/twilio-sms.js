'use strict';
// The one outbound channel that does not go through the OpenClaw gateway.
//
// Every alarm this system had rode `openclaw message send`, and that pipe IS
// the gateway — so a dead gateway could not report itself (CLAUDE.md, "The
// gateway can only ever be watched from OUTSIDE itself"). Twilio is already
// on the box for the voice bridge; one SMS from the same account is the second
// channel. Configured by TWILIO_SID / TWILIO_TOKEN / TWILIO_FROM in
// /opt/olma2/.env; absent, `configured()` is false and callers say so on
// their heartbeat rather than pretending an alert went out.
//
// Nothing here logs the token, the SID, or the body.
function configured(env = process.env) {
  return Boolean(env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM);
}

async function send(to, body, { env = process.env, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!configured(env)) return { ok: false, error: 'twilio not configured' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: env.TWILIO_FROM, To: to, Body: String(body).slice(0, 1500) }).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `twilio http ${res.status}` };
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { ok: true, sid: parsed && parsed.sid ? String(parsed.sid) : null };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'twilio timeout' : String(e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

module.exports = { configured, send };
