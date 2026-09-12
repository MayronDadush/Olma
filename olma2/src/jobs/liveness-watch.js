'use strict';
// "Is everything working, and will I hear if it is not?" — the owner's ask,
// 2026-09-05. Two questions, every five minutes:
//
//   1. the gateway answers its health route (adapters/gateway-health.js);
//   2. its CHANNELS can carry a message — the gateway's own `channels.status`,
//      asked over the WebSocket, not the 4.1s CLI;
//   3. messages are actually leaving: no outbox row stuck after three failed
//      attempts, none that expired after failing in the last half hour.
//
// (2) was added 2026-09-11, after a WhatsApp channel died at 06:07 and came
// back at 12:05. The process was healthy the whole time — (1) said `live` on
// every tick and `/health` served `{"ok":true}` — and the only thing that
// ever fixed it was the restart this job already knows how to perform, six
// hours later and by hand. (3) did see it, as `stuck`, but a queue backing up
// is a symptom that arrives late and names nothing; a channel that says
// `connected: false` names the fault on the first tick.
//
// What this can and cannot see, said plainly. It runs inside brokerd, so a
// dead brokerd, a dead box or a dead network is invisible to it — only an
// external monitor on https://allma.world/health covers that. And it speaks
// over the gateway's own pipe (the owner chose no second channel, 2026-09-05),
// so a gateway that stays dead cannot be REPORTED from here — it can only be
// REPAIRED from here, which is what the restart below is for. A restart that
// works is announced once the pipe is back; one that does not shows on the
// heartbeat as alertFailed, and the external monitor is the alarm.
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
const { checkGateway, checkChannels } = require('../adapters/gateway-health');
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

// The noun follows what actually broke. A channel outage leaves the gateway
// answering every probe it has, and telling the owner "the gateway fell" for
// one would be the alert describing a fault nobody had — the same rule that
// makes every other alert here check its wording against reality at send time
// rather than at queue time.
function healedText(sinceMs, nowMs, channelDown = false) {
  const mins = Math.max(1, Math.round((nowMs - sinceMs) / 60000));
  const what = channelDown
    ? 'ערוץ התקשורת התנתק והשער הופעל מחדש אוטומטית'
    : 'שער התקשורת (OpenClaw) נפל והופעל מחדש אוטומטית';
  return `🔧 עולמה: ${what} — חזר לעבוד (השבתה של כ-${mins} דקות).`;
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

// Delivery to the owner over the raw WhatsApp pipe. Returns 'whatsapp' when
// the send confirmed, null otherwise — and null is a real answer the caller
// records on the heartbeat rather than a silence.
async function tell(deps, phone, text) {
  if (typeof deps.send !== 'function') return null;
  try {
    const r = await deps.send(phone, text);
    return r && r.ok ? 'whatsapp' : null;
  } catch { return null; }
}

// Both probes, in the one order that makes sense: a gateway that will not
// answer its health route will not answer an RPC either, so asking would cost
// a refused connect and — worse — spend one of the three consecutive failures
// that put `gateway-rpc` to sleep for a minute, which is the pipe the raw
// sends use. When the process is down the channel question has no answer, and
// saying so is the honest reading, not a gap.
async function probeBoth(deps) {
  const probeGateway = deps.checkGateway || checkGateway;
  const probeChannels = deps.checkChannels || checkChannels;
  const gateway = await probeGateway({ configPath: deps.configPath });
  if (gateway.status !== 'live') {
    return { gateway, channels: { status: 'unknown', detail: 'gateway not answering; not asked', channels: [] } };
  }
  return { gateway, channels: await probeChannels({}) };
}

async function run(client, deps = {}) {
  const now = Number(deps.now) || Date.now();
  let { gateway, channels } = await probeBoth(deps);
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
  //
  // A dead CHANNEL earns the same restart, and for a measured reason: on
  // 2026-09-11 the channel's own auto-restart tried ten times over six hours
  // and lost every time to "Another process owns this WhatsApp connection".
  // Restarting the unit fixed it on the first attempt. Two ticks of confirmation
  // matter more here than for the process, because a channel flaps briefly by
  // design — a reconnect the same day was down and back inside one second, and
  // ten minutes of continuous `connected: false` is what separates the two.
  let restarted = false, restartOk = null;
  const broken = (g, c) => g.status === 'down' || c.status === 'down';
  if (broken(gateway, channels) && prev0.down && (prev0.ticks || 0) + 1 >= TICKS_BEFORE_ALERT
      && (!prev0.lastRestartAt || now - prev0.lastRestartAt >= RESTART_COOLDOWN_MS)) {
    const restart = deps.restartGateway || gatewayRestart.restartGateway;
    try { restartOk = Boolean(await restart()); } catch { restartOk = false; }
    restarted = true;
    if (restartOk) {
      await new Promise((r) => setTimeout(r, Number.isFinite(deps.settleMs) ? deps.settleMs : RESTART_SETTLE_MS));
      ({ gateway, channels } = await probeBoth(deps));
    }
  }
  const gatewayNow = gateway;

  const reasons = [];
  if (gatewayNow.status === 'down') {
    reasons.push(`שער התקשורת (OpenClaw) לא מגיב: ${gatewayNow.detail || ''}`.trim()
      + (restarted ? (restartOk ? ' — הופעל מחדש אוטומטית ועדיין לא עונה' : ' — ניסיון הפעלה מחדש אוטומטי נכשל') : ''));
  }
  // Named separately from the process, because they are different faults with
  // the same remedy and the alert has to say which one it is: the gateway was
  // answering perfectly for all six hours of the outage that produced this.
  if (channels.status === 'down') {
    reasons.push(`ערוץ התקשורת מנותק — אי אפשר לשלוח הודעות (${channels.detail})`
      + (restarted ? (restartOk ? ' — השער הופעל מחדש אוטומטית והערוץ עדיין מנותק' : ' — ניסיון הפעלה מחדש אוטומטי נכשל') : ''));
  }
  if (stuck > 0) reasons.push(`${stuck} הודעות תקועות אחרי ${STUCK_ATTEMPTS}+ ניסיונות משלוח`);
  if (dying > 0) reasons.push(`${dying} הודעות פגו אחרי כשלונות משלוח בחצי השעה האחרונה`);

  const prev = restarted ? { ...prev0, lastRestartAt: now } : prev0;
  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  const note = { gateway: gatewayNow.status, channels: channels.status, stuck, dying, delivered30m: delivered };
  if (gatewayNow.status === 'unknown') note.gatewayDetail = gatewayNow.detail;
  // "Could not tell" and "nothing wrong" must read differently on the board —
  // a check that goes quiet is otherwise indistinguishable from one that
  // passes, which is how this gap lasted as long as it did.
  if (channels.status !== 'live') note.channelDetail = channels.detail;
  if (restarted) { note.restarted = true; note.restartOk = restartOk; }

  let next;
  if (reasons.length) {
    // `channelDown` rides the state, because the recovery message is written
    // one tick LATER — when the fault is already gone and nothing in hand can
    // still say which of the two it was.
    const channelDown = channels.status === 'down';
    next = prev.down
      ? { ...prev, ticks: (prev.ticks || 0) + 1, reasons, channelDown }
      : { down: true, since: now, ticks: 1, reasons, channelDown, lastAlertAt: null };
    const due = next.ticks >= TICKS_BEFORE_ALERT && (!next.lastAlertAt || now - next.lastAlertAt >= REALERT_MS);
    if (due) {
      const channel = await tell(deps, phone, alertText(reasons, next.since));
      if (channel) { next.lastAlertAt = now; note.alerted = channel; } else note.alertFailed = true;
    }
  } else if (prev.down) {
    next = {};
    if (restarted && restartOk) {
      // Fell and came back on its own: said once, as the outcome it is. The
      // pipe just came back, so WhatsApp carries it.
      const channel = await tell(deps, phone, healedText(prev.since, now, prev.channelDown));
      if (channel) note.selfHealed = channel; else { note.alertFailed = true; next = { ...prev, recoveredAt: now }; }
    } else if (prev.lastAlertAt) {
      const channel = await tell(deps, phone, recoveredText(prev.since, now));
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
