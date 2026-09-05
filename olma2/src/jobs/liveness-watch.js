'use strict';
// "Is everything working, and will I hear if it is not?" — the owner's ask,
// 2026-09-05. Two questions, every five minutes:
//
//   1. the gateway answers its health route (adapters/gateway-health.js);
//   2. messages are actually leaving: no outbox row stuck after three failed
//      attempts, none that expired after failing in the last half hour.
//
// What this can and cannot see, said plainly. It runs inside brokerd, so a
// dead brokerd, a dead box or a dead network is invisible to it — only an
// external monitor on https://allma.world/health covers that. What it adds is
// the half that used to be impossible: a DEAD GATEWAY. Every alarm rode the
// gateway's own pipe; this one has a second channel, Twilio SMS
// (channels/twilio-sms.js), and uses it exactly when the pipe is the problem.
//
// Rules, each earned elsewhere in this repo:
//   - two consecutive bad ticks before a word (a single probe timeout on a
//     loaded 1-vCPU box is not an outage — "an alarm that overstates is spent
//     the first time someone checks it");
//   - one alert per outage, repeated every six hours while it lasts, and one
//     recovery message ("we told them" is stamped only after a send confirmed);
//   - a probe that could not judge (config unreadable) is reported, never
//     alarmed ("a thing that could not be READ is never a thing in trouble");
//   - the state lives in a flag, so a brokerd restart mid-outage does not
//     re-alert from scratch, and the heartbeat note carries every number so
//     "nothing wrong" and "not looking" read differently on the board.
const { checkGateway } = require('../adapters/gateway-health');
const twilioSms = require('../channels/twilio-sms');
const flagsDomain = require('../domain/flags');
const { ALERT_PHONE_FLAG, DEFAULT_ALERT_PHONE } = require('./credit-watch');
const gatewayRestart = require('../intake/gateway-restart');

const STATE_FLAG = 'liveness_state';
const TICKS_BEFORE_ALERT = 2;
const REALERT_MS = 6 * 3600_000;
const STUCK_ATTEMPTS = 3;
const STUCK_AGE = '15 minutes';
const DYING_WINDOW = '30 minutes';
const DASHBOARD = 'https://olmachat.duckdns.org';
// Self-healing, owner's ask 2026-09-05 ("try to fix it before telling me").
// The one repair this can perform on its own is the one that has fixed every
// dead-gateway incident so far: restart the unit. Once per half hour at most
// — a gateway that dies again within the cooldown is not a hiccup, and a loop
// of restarts would hide that. After the restart the probe is asked again
// before anything is said, so the owner hears the OUTCOME: "fell and came
// back on its own" over WhatsApp (the pipe works again), or "fell, restart
// did not help" over SMS.
const RESTART_COOLDOWN_MS = 30 * 60_000;
const RESTART_SETTLE_MS = 8_000;

function hhmm(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(11, 16); }
}

function alertText(reasons, sinceMs) {
  return `⚠️ עולמה: תקלה במערכת מאז ${hhmm(sinceMs)}.\n${reasons.map((r) => '• ' + r).join('\n')}\n${DASHBOARD}`;
}

function healedText(sinceMs, nowMs) {
  const mins = Math.max(1, Math.round((nowMs - sinceMs) / 60000));
  return `🔧 עולמה: שער התקשורת (OpenClaw) נפל והופעל מחדש אוטומטית — חזר לעבוד (השבתה של כ-${mins} דקות).`;
}

function recoveredText(sinceMs, nowMs) {
  const mins = Math.max(1, Math.round((nowMs - sinceMs) / 60000));
  return `✅ עולמה: המערכת חזרה לעבוד (התקלה נמשכה כ-${mins} דקות).`;
}

async function readState(client) {
  try {
    const v = await flagsDomain.getFlag(client, STATE_FLAG);
    const s = typeof v === 'string' ? JSON.parse(v) : v;
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

// Delivery to the owner: WhatsApp (the raw pipe) when the gateway is up, SMS
// when it is not — and the other one as a fallback either way. Returns the
// channel that confirmed, or null.
async function tell(deps, phone, text, gatewayDown) {
  const sms = deps.sms || twilioSms.send;
  const order = gatewayDown ? ['sms', 'whatsapp'] : ['whatsapp', 'sms'];
  for (const ch of order) {
    try {
      if (ch === 'sms') {
        if (!(deps.smsConfigured ?? twilioSms.configured())) continue;
        const r = await sms(phone, text);
        if (r && r.ok) return 'sms';
      } else if (typeof deps.send === 'function') {
        const r = await deps.send(phone, text);
        if (r && r.ok) return 'whatsapp';
      }
    } catch { /* the next channel is the answer */ }
  }
  return null;
}

async function run(client, deps = {}) {
  const now = Number(deps.now) || Date.now();
  const probe = deps.checkGateway || checkGateway;
  const gateway = await probe({ configPath: deps.configPath });
  const { rows: q } = await client.query(
    `SELECT
       count(*) FILTER (WHERE sent_at IS NULL AND attempts >= $1 AND created_at < now() - $2::interval)::int AS stuck,
       count(*) FILTER (WHERE hold_reason = 'expired' AND attempts > 0 AND last_error IS NOT NULL AND sent_at > now() - $3::interval)::int AS dying,
       count(*) FILTER (WHERE sent_at IS NOT NULL AND hold_reason IS NULL AND sent_at > now() - $3::interval)::int AS delivered
     FROM outbox`, [STUCK_ATTEMPTS, STUCK_AGE, DYING_WINDOW]);
  const stuck = q[0].stuck, dying = q[0].dying, delivered = q[0].delivered;

  const prev0 = await readState(client);
  // The repair, before the verdict: a gateway down for two ticks is restarted
  // (cooldown permitting) and probed again. Nothing below reads the first probe
  // if the second one is good.
  let gatewayNow = gateway, restarted = false, restartOk = null;
  if (gateway.status === 'down' && prev0.down && (prev0.ticks || 0) + 1 >= TICKS_BEFORE_ALERT
      && (!prev0.lastRestartAt || now - prev0.lastRestartAt >= RESTART_COOLDOWN_MS)) {
    const restart = deps.restartGateway || gatewayRestart.restartGateway;
    try { restartOk = Boolean(await restart()); } catch { restartOk = false; }
    restarted = true;
    if (restartOk) {
      await new Promise((r) => setTimeout(r, Number.isFinite(deps.settleMs) ? deps.settleMs : RESTART_SETTLE_MS));
      gatewayNow = await probe({ configPath: deps.configPath });
    }
  }

  const reasons = [];
  if (gatewayNow.status === 'down') {
    reasons.push(`שער התקשורת (OpenClaw) לא מגיב: ${gatewayNow.detail || ''}`.trim()
      + (restarted ? (restartOk ? ' — הופעל מחדש אוטומטית ועדיין לא עונה' : ' — ניסיון הפעלה מחדש אוטומטי נכשל') : ''));
  }
  if (stuck > 0) reasons.push(`${stuck} הודעות תקועות אחרי ${STUCK_ATTEMPTS}+ ניסיונות משלוח`);
  if (dying > 0) reasons.push(`${dying} הודעות פגו אחרי כשלונות משלוח בחצי השעה האחרונה`);

  const prev = restarted ? { ...prev0, lastRestartAt: now } : prev0;
  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  const smsConfigured = deps.smsConfigured ?? twilioSms.configured();
  const note = { gateway: gatewayNow.status, stuck, dying, delivered30m: delivered, smsConfigured };
  if (gatewayNow.status === 'unknown') note.gatewayDetail = gatewayNow.detail;
  if (restarted) { note.restarted = true; note.restartOk = restartOk; }

  let next;
  if (reasons.length) {
    next = prev.down
      ? { ...prev, ticks: (prev.ticks || 0) + 1, reasons }
      : { down: true, since: now, ticks: 1, reasons, lastAlertAt: null };
    const due = next.ticks >= TICKS_BEFORE_ALERT && (!next.lastAlertAt || now - next.lastAlertAt >= REALERT_MS);
    if (due) {
      const channel = await tell(deps, phone, alertText(reasons, next.since), gatewayNow.status === 'down');
      if (channel) { next.lastAlertAt = now; note.alerted = channel; } else note.alertFailed = true;
    }
  } else if (prev.down) {
    next = {};
    if (restarted && restartOk) {
      // Fell and came back on its own: said once, as the outcome it is. The
      // pipe just came back, so WhatsApp carries it.
      const channel = await tell(deps, phone, healedText(prev.since, now), false);
      if (channel) note.selfHealed = channel; else { note.alertFailed = true; next = { ...prev, recoveredAt: now }; }
    } else if (prev.lastAlertAt) {
      const channel = await tell(deps, phone, recoveredText(prev.since, now), false);
      if (channel) note.recovered = channel; else { note.alertFailed = true; next = { ...prev, recoveredAt: now }; }
    }
  } else {
    next = {};
  }
  note.down = Boolean(next.down);
  if (next.down) { note.ticks = next.ticks; note.since = new Date(next.since).toISOString(); }
  if (JSON.stringify(next) !== JSON.stringify(prev)) await flagsDomain.setFlag(client, STATE_FLAG, next);
  return note;
}

module.exports = { run, alertText, recoveredText, healedText, STATE_FLAG, TICKS_BEFORE_ALERT, REALERT_MS, STUCK_ATTEMPTS, RESTART_COOLDOWN_MS };
