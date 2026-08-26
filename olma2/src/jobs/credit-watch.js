'use strict';
// The credit-out alarm, on the zero-cost pipe.
//
// The Anthropic account has now run dry three times in one week (08-20,
// 08-23, 08-26). Each time, every model turn fails — no replies, no digests,
// no checkins — and each time the operator found out hours later, from the
// silence. The system knew within a minute: the outbox rows say "credit
// balance is too low" on their very first failed attempt.
//
// What makes an alarm possible at all is the raw pipe: `openclaw message
// send` was proven live (2026-08-24, during an outage) to deliver WhatsApp
// with ZERO model involvement. So the one message that matters — "the money
// ran out" — rides the one channel that does not need money.
//
// Folded into the existing outbox_worker beat rather than a sweeper of its
// own (the house rule): detection is one indexed query over rows the worker
// just touched. Alert at most once per outage: `credit_alert_at` is compared
// against the FIRST error of the current outage, so a new outage re-arms the
// alarm and a long one does not re-fire it.
const flagsDomain = require('../domain/flags');

// Where the alarm goes. A flag so the dashboard can change it without a
// deploy; the default is the operator's own number.
const ALERT_PHONE_FLAG = 'admin_alert_phone';
const DEFAULT_ALERT_PHONE = '+972526269826';
const ALERT_AT_FLAG = 'credit_alert_at';

function alertText(sinceIso) {
  const t = sinceIso ? new Date(sinceIso).toISOString().slice(11, 16) + ' UTC' : 'עכשיו';
  return [
    '⚠️ אולמה: נגמר הקרדיט ב-Anthropic.',
    `מאז ${t} אף הודעה לא נשלחת ואף פנייה לא נענית.`,
    'טעינה: console.anthropic.com → Billing (ושווה להדליק Auto-reload).',
    'הכל ממתין בתור ויישלח לבד תוך ~10 דקות מהטעינה.',
  ].join('\n');
}

// deps.send(phone, text) -> {ok, error?}  (production: raw `message send`)
async function checkCreditAlert(client, deps = {}) {
  const { rows } = await client.query(
    `SELECT min(created_at) AS since FROM outbox
      WHERE sent_at IS NULL AND last_error ILIKE '%credit balance%'`
  );
  const since = rows[0] && rows[0].since;
  if (!since) return { alerted: false };

  const lastAlert = await flagsDomain.getFlag(client, ALERT_AT_FLAG);
  // Already alerted for THIS outage — an alert newer than the outage's first
  // error means this is the same incident, not a new one.
  if (lastAlert && new Date(lastAlert).getTime() >= new Date(since).getTime()) {
    return { alerted: false };
  }

  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  const res = await deps.send(phone, alertText(since));
  if (!res || !res.ok) {
    // The send itself failed (gateway down, WhatsApp unlinked). Do NOT stamp
    // the flag — the next tick tries again. This alarm's whole promise is
    // that it keeps trying on a channel that needs nothing.
    return { alerted: false, error: String((res && res.error) || 'send failed').slice(0, 200) };
  }
  await flagsDomain.setFlag(client, ALERT_AT_FLAG, new Date().toISOString());
  return { alerted: true, phone };
}

module.exports = { checkCreditAlert, alertText, ALERT_PHONE_FLAG, DEFAULT_ALERT_PHONE, ALERT_AT_FLAG };
