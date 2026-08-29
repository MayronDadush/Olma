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
//
// That comparison has exactly ONE clock, and it is Postgres's. It used to
// straddle two: the outage's first error came from the database (`min(created_at)`)
// and the stamp was written by the Node process (`new Date().toISOString()`).
// Two things went wrong with that, one of them in production:
//
// - **Precision.** `pg` parses a timestamptz into a JS Date, which is
//   millisecond-resolution, and `toISOString()` truncates the microseconds
//   Postgres actually stored. Two events a fraction of a millisecond apart
//   compare EQUAL, and `>=` then reads a genuinely new outage as the old one
//   and stays silent. This is why the test at tests/credit-watch.test.js
//   failed about two runs in three: everything in it happens inside a few
//   milliseconds. So both sides stay in Postgres — `::text` out, `::timestamptz`
//   back in — and never pass through a JS Date.
// - **`now()` is transaction start, not wall clock**, and this function runs
//   inside `withTx` (see bin/olma-brokerd.js). Under READ COMMITTED a row
//   inserted after our transaction opened is still visible to the SELECT — so
//   `now()` can legitimately predate the outage we just read, stamping the flag
//   BEFORE the first error and re-firing the same alarm every tick for the rest
//   of a real outage. `clock_timestamp()` is the wall clock at statement time
//   and cannot land before a row the previous statement already returned.
const flagsDomain = require('../domain/flags');

// Where the alarm goes. A flag so the dashboard can change it without a
// deploy; the default is the operator's own number.
const ALERT_PHONE_FLAG = 'admin_alert_phone';
const DEFAULT_ALERT_PHONE = '+972526269826';
const ALERT_AT_FLAG = 'credit_alert_at';

function alertText(sinceIso) {
  const t = sinceIso ? new Date(sinceIso).toISOString().slice(11, 16) + ' UTC' : 'עכשיו';
  return [
    '⚠️ אולמה: נגמר הקרדיט אצל ספק המודל.',
    `מאז ${t} אף הודעה לא נשלחת ואף פנייה לא נענית.`,
    'OpenRouter: openrouter.ai/settings/credits · Anthropic: console.anthropic.com → Billing (ושווה Auto-reload).',
    'הכל ממתין בתור ויישלח לבד תוך ~10 דקות מהטעינה.',
  ].join('\n');
}

// deps.send(phone, text) -> {ok, error?}  (production: raw `message send`)
async function checkCreditAlert(client, deps = {}) {
  // Two providers, two phrasings for the same empty wallet:
  // Anthropic 400 — "Your credit balance is too low ...";
  // OpenRouter 402 — "Insufficient credits. Add more ...".
  // Since the 2026-08-26 cutover the credit that runs out is OpenRouter's,
  // so an alarm matching only Anthropic's wording would sleep through the
  // exact outage it was built for.
  // `since` is for the message; `since_exact` is the same moment with its
  // microseconds intact, and it is the only one the comparison below may use.
  const { rows } = await client.query(
    `SELECT min(created_at) AS since, min(created_at)::text AS since_exact FROM outbox
      WHERE sent_at IS NULL
        AND (last_error ILIKE '%credit balance%'
          OR last_error ILIKE '%insufficient credits%')`
  );
  const since = rows[0] && rows[0].since;
  if (!since) return { alerted: false };

  const lastAlert = await flagsDomain.getFlag(client, ALERT_AT_FLAG);
  // Already alerted for THIS outage — an alert newer than the outage's first
  // error means this is the same incident, not a new one. Compared in Postgres,
  // at full precision, for the reasons in the header. Costs a round trip, and
  // only ever during an outage: the healthy tick returned above.
  if (lastAlert) {
    const { rows: cmp } = await client.query(
      `SELECT $1::timestamptz >= $2::timestamptz AS same_outage`,
      [lastAlert, rows[0].since_exact]
    );
    if (cmp[0].same_outage) return { alerted: false };
  }

  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  const res = await deps.send(phone, alertText(since));
  if (!res || !res.ok) {
    // The send itself failed (gateway down, WhatsApp unlinked). Do NOT stamp
    // the flag — the next tick tries again. This alarm's whole promise is
    // that it keeps trying on a channel that needs nothing.
    return { alerted: false, error: String((res && res.error) || 'send failed').slice(0, 200) };
  }
  // Postgres's wall clock, rendered by Postgres, with its microseconds — the
  // other half of keeping one clock. A legacy value written by the old JS path
  // still parses as a timestamptz, so nothing has to be migrated.
  const { rows: stamp } = await client.query(`SELECT clock_timestamp()::text AS at`);
  await flagsDomain.setFlag(client, ALERT_AT_FLAG, stamp[0].at);
  return { alerted: true, phone };
}

module.exports = { checkCreditAlert, alertText, ALERT_PHONE_FLAG, DEFAULT_ALERT_PHONE, ALERT_AT_FLAG };
