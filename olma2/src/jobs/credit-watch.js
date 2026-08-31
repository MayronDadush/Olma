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

// ---- the warning BEFORE the outage -------------------------------------------
// checkCreditAlert above fires on failures that have already started — which is
// the outage, not a warning about one. Every prepaid provider publishes what is
// LEFT, so the runway is knowable days ahead, and nothing was reading it: the
// 2026-08-31 cost audit found OpenRouter at $1.75, about four days out, with no
// mechanism anywhere that would have said so before everything stopped.
//
// Three rules keep this from becoming noise nobody reads:
//
// - **Tiers, not repetition.** A balance below threshold alerts ONCE, then only
//   again when it crosses into a genuinely more urgent tier. At most three
//   messages per depletion, each meaning something new. A daily "still low"
//   would be fourteen messages that train the reader to swipe them away — the
//   exact failure the behavioural-evals YELLOW/RED split was built around.
// - **Days where days are knowable.** $2 left is fine on a service nobody uses
//   and an outage tomorrow on the one every model call goes through. Only
//   providers that report their own burn rate get day tiers; the rest fall back
//   to dollars, which is the weaker signal and is treated as one.
// - **A service we could not READ is never a service in trouble.** A billing
//   API being down must not page anyone: no reading, no alert, and the
//   dashboard already shows the error.
//
// Unlike the outage alarm it defers outside waking hours. A prepaid balance
// cannot be topped up better at 03:00 than at 08:00, and the raw pipe bypasses
// the outbox gate entirely — so this function has to hold that line itself.
const BALANCE_TIERS_FLAG = 'balance_alert_tiers';
const ALERT_HOURS = { from: 8, to: 22 };
const DEFAULT_TZ = 'Asia/Jerusalem';

// Ascending, so `.find(v < t)` returns the MOST urgent tier crossed: at 4 days
// left that is 7, not 14. A lower number is a worse situation.
const DAY_TIERS = [3, 7, 14];
const USD_TIERS = [2, 5];

const BALANCE_SERVICES = [
  { key: 'openrouter', label: 'OpenRouter — כל קריאות המודל', topUp: 'openrouter.ai/settings/credits (שווה Auto-reload)' },
  { key: 'twilio', label: 'Twilio — שיחות טלפון', topUp: 'console.twilio.com' },
  { key: 'deepgram', label: 'Deepgram — זיהוי דיבור בשיחות', topUp: 'console.deepgram.com' },
];

function tierFor(s) {
  if (!s || !s.configured || s.error) return null;
  if (s.remaining === null || s.remaining === undefined) return null;
  if (s.daysLeft !== null && s.daysLeft !== undefined) {
    return DAY_TIERS.find((t) => s.daysLeft < t) ?? null;
  }
  return USD_TIERS.find((t) => s.remaining < t) ?? null;
}

function balanceAlertText(low) {
  const lines = ['⚠️ אולמה: יתרה נמוכה בשירות בתשלום.', ''];
  for (const { label, state } of low) {
    const left = `$${Number(state.remaining).toFixed(2)}`;
    lines.push(state.daysLeft !== null && state.daysLeft !== undefined
      ? `• ${label}: ${left} — כ-${Math.floor(state.daysLeft)} ימים בקצב הנוכחי.`
      : `• ${label}: ${left} נשארו.`);
  }
  lines.push('', 'כשיתרה נגמרת — אין תשובות, אין תזכורות, אין דיג׳סטים.');
  for (const { topUp } of low) lines.push(`טעינה: ${topUp}`);
  return lines.join('\n');
}

// deps.send(phone, text) · deps.getInfraCosts() — both injected so a test never
// touches the network or WhatsApp.
async function checkBalanceForecast(client, deps = {}) {
  const getCosts = deps.getInfraCosts || require('../adapters/infra-cost').getInfraCosts;
  const costs = await getCosts();

  const stored = (await flagsDomain.getFlag(client, BALANCE_TIERS_FLAG)) || {};
  const next = { ...stored };
  const low = [];
  for (const svc of BALANCE_SERVICES) {
    const state = costs[svc.key];
    const tier = tierFor(state);
    if (tier === null) {
      // Healthy again (or unreadable): forget what we alerted at, so a future
      // depletion gets the full ladder rather than being silenced by a stale
      // stamp from the last one.
      delete next[svc.key];
      continue;
    }
    const last = stored[svc.key];
    if (last === undefined || last === null || tier < last) {
      low.push({ ...svc, state, tier });
      next[svc.key] = tier;
    } else {
      next[svc.key] = last;
    }
  }

  // Nothing new to say. The recovery bookkeeping above still has to land, or a
  // service that recovered stays permanently silenced.
  if (!low.length) {
    if (JSON.stringify(next) !== JSON.stringify(stored)) {
      await flagsDomain.setFlag(client, BALANCE_TIERS_FLAG, next);
    }
    return { alerted: false };
  }

  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  // Their zone, converted in Postgres like every other local-time decision
  // here, so there is no offset arithmetic to break at a DST boundary.
  const { rows: hr } = await client.query(
    `SELECT extract(hour from now() AT TIME ZONE coalesce(
       (SELECT timezone FROM users WHERE phone = $1), $2))::int AS h`,
    [phone, DEFAULT_TZ]
  );
  const h = hr[0].h;
  // Deferred, NOT dropped: the tier stays unstamped so the next tick inside
  // the window says it. Stamping here would swallow the alert entirely.
  if (h < ALERT_HOURS.from || h >= ALERT_HOURS.to) {
    return { alerted: false, deferred: low.map((l) => l.key) };
  }

  const res = await deps.send(phone, balanceAlertText(low));
  if (!res || !res.ok) {
    // Same promise as the outage alarm: do not stamp, keep trying.
    return { alerted: false, error: String((res && res.error) || 'send failed').slice(0, 200) };
  }
  await flagsDomain.setFlag(client, BALANCE_TIERS_FLAG, next);
  return { alerted: true, phone, services: low.map((l) => l.key) };
}

module.exports = {
  checkCreditAlert, alertText, ALERT_PHONE_FLAG, DEFAULT_ALERT_PHONE, ALERT_AT_FLAG,
  checkBalanceForecast, balanceAlertText, tierFor,
  BALANCE_TIERS_FLAG, BALANCE_SERVICES, DAY_TIERS, USD_TIERS, ALERT_HOURS,
};
