'use strict';
// Feature flags + admin-tunable numbers, changeable from the dashboard without
// a deploy. Quota limits live here (with defaults) precisely because the exact
// numbers were deliberately left open — flipping them must not need code.
const { ok } = require('./results');

const DEFAULTS = {
  registration_open: true,
  quota_daily_free: 50,      // generous placeholders; admin-tunable, not final
  quota_hourly_paid: 50,
  intake_hourly_cap: 30,     // intake circuit breaker: max new-stranger sessions/hour
  // Media generation (domain/media.js): who may, and on which models.
  media_gen_phones: '+972505404255',
  media_image_model: 'meta/muse-image',
  media_video_model: 'bytedance/seedance-2.0-mini',
  // Reminder escalation (domain/reminders.js): how many times one reminder may
  // come back, and how long after a DELIVERED rung the next one is due.
  reminder_escalation_max: 3,
  reminder_escalation_gap_hours: 3,
  live_subscriptions_per_user: 5,   // cap on active live-update subscriptions
  // Mailbox connection (domain/mail.js): '' = nobody but the admin, 'all' =
  // everyone, or a comma-separated E.164 list. Default OFF on purpose — the
  // code half of the feature can merge and auto-deploy while the half that
  // lives in Google's console (the Gmail scope and its verification tier) is
  // still open, and a consent link that lands on a Google error screen is a
  // worse first impression than a feature nobody was offered yet.
  email_access_phones: '',
  // Months the personal Claude subscription was billed at something other than
  // the standing $20 — a Max upgrade, a paused month. {"YYYY-MM": usd}. No API
  // exposes subscription billing, so this is the only way the page can be right
  // about it, and it has to be an edit rather than a deploy.
  claude_subscription_overrides: {},
  // Base for user-facing links (availability picker). The dashboard's own
  // host — Caddy already routes it here.
  public_base_url: 'https://olmachat.duckdns.org',
  // jobs/credit-watch.js: mute just the credit-outage + balance-runway
  // WhatsApp lines to the admin phone. Explicit default (not just "falsy
  // null") so the dashboard's bool dropdown renders "סגור" rather than
  // showing neither option selected before anyone has touched this flag.
  credit_alerts_muted: false,
};

async function getFlag(client, key) {
  const { rows } = await client.query(`SELECT value FROM feature_flags WHERE key = $1`, [key]);
  if (rows[0]) return rows[0].value;
  return key in DEFAULTS ? DEFAULTS[key] : null;
}

async function setFlag(client, key, value) {
  await client.query(
    `INSERT INTO feature_flags (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  return ok({ key, value });
}

module.exports = { getFlag, setFlag, DEFAULTS };
