'use strict';
// Real infrastructure spend for running Olma — every external service the
// project actually pays for. Each fetcher degrades to {configured:false} when
// its secret isn't set, and never throws: a billing API being slow or down
// must not break the admin dashboard.
//
// Two kinds of money, and the distinction is the whole point of the layout:
//
// - **Prepaid** (OpenRouter, Twilio, Deepgram): credits bought up front that
//   drain. The number that predicts an outage is what is LEFT, not what was
//   spent — a spend figure alone reads healthy right up to the moment
//   everything stops. Olma has now been taken down by an empty prepaid
//   balance three times (see jobs/credit-watch.js), every time discovered
//   from the silence, so these carry `remaining` and, where the provider
//   reports a burn rate, `daysLeft`.
// - **Recurring** (DigitalOcean, ElevenLabs, Anthropic, the personal Claude
//   subscription): billed after the fact. There is nothing to run out of, so
//   what matters is the trend — spent-since-start and spent-this-month.
//
// The Anthropic figure is deliberately scoped to ONE api_key_id (the bot's own
// key) via usage_report/messages, never the org-wide cost_report endpoint —
// that endpoint mixes in Claude Code usage covered by the owner's personal
// subscription, which looks like real spend but isn't (see the Olma
// weekly-cost-report incident this was learned from). Getting that wrong here
// would misinform the one person reading this page for real numbers.

const PROJECT_START = '2026-06-27T00:00:00Z';
const ELEVENLABS_START = '2026-08-18T00:00:00Z';
const BOT_API_KEY_ID = 'apikey_01KzQWmjukHb3FV9y9geCo1J';

// The owner's personal claude.ai subscription — not queryable via any API (no
// endpoint exposes subscription billing), so it's a hardcoded recurring charge,
// same as the WhatsApp weekly cost report uses. Shown separately from the bot's
// own Anthropic usage above — this is the flat monthly fee, not infra spend.
const SUBSCRIPTION_USD = 20;
const SUBSCRIPTION_BILLING_DAY = 27;

// cw5m/cw1h: Anthropic prices cache writes by TTL — 1.25x input for the 5m
// cache, 2x for the 1h one — and the usage report splits `cache_creation`
// into exactly those two buckets, so each is priced at its own rate. Olma
// switched to 1h retention on 2026-08-22; pricing per-bucket keeps both the
// history before that and any mixed day after it exact.
const ANTHROPIC_PRICES = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00, cw5m: 1.25, cw1h: 2.00, cr: 0.10 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cw5m: 3.75, cw1h: 6.00, cr: 0.30 },
  'claude-opus-4-8': { in: 15.00, out: 75.00, cw5m: 18.75, cw1h: 30.00, cr: 1.50 },
};

const CACHE_TTL_MS = 10 * 60_000;
let cache = null; // { at, data }

function priceFor(model) {
  for (const [key, table] of Object.entries(ANTHROPIC_PRICES)) {
    if (model && model.startsWith(key)) return table;
  }
  return null;
}

function monthStartIso(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function fetchJson(url, headers, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Anthropic: the bot's own key only ---------------------------------------

async function anthropicBotCost(adminKey) {
  const headers = { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' };
  const monthStart = monthStartIso();
  let sinceTotal = 0, monthTotal = 0, page = null;
  for (;;) {
    const params = new URLSearchParams({
      starting_at: PROJECT_START, bucket_width: '1d', limit: '31',
    });
    params.append('group_by[]', 'model');
    params.append('api_key_ids[]', BOT_API_KEY_ID);
    if (page) params.set('page', page);
    const { ok, status, body } = await fetchJson(
      `https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`, headers);
    if (!ok) return { configured: true, error: `http_${status}` };
    for (const bucket of body?.data ?? []) {
      const day = bucket.starting_at;
      for (const row of bucket.results ?? []) {
        const table = priceFor(row.model);
        if (!table) continue;
        // Some fields come back as a scalar and some as an object of
        // sub-buckets; sum either shape.
        const tok = (field) => {
          const v = row[field];
          return typeof v === 'object' && v ? Object.values(v).reduce((a, b) => a + (b || 0), 0) : (v || 0);
        };
        // Cache writes arrive under `cache_creation`, an object keyed by TTL
        // ({ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}) — NOT under
        // `cache_creation_input_tokens`, which this read for a month and which
        // simply does not exist in the response. Missing it silently zeroed the
        // single largest line on an Olma turn: the system prompt plus 59 tool
        // schemas are re-cached constantly. Measured on 2026-08-20 — 2,808,131
        // cache-write tokens dropped, turning a real $4.57 day into $1.06, and
        // making the page under-report by ~4x while looking perfectly healthy.
        // The name is kept alongside as a fallback in case the API ever adds
        // the flat form.
        const cc = row.cache_creation && typeof row.cache_creation === 'object'
          ? row.cache_creation : {};
        const cw5m = Number(cc.ephemeral_5m_input_tokens) || 0;
        const cw1h = Number(cc.ephemeral_1h_input_tokens) || 0;
        // Older responses might only carry the flat field; price it at the 5m
        // rate, which is what it meant when it existed.
        const cwFlat = cw5m + cw1h === 0 ? (Number(row.cache_creation_input_tokens) || 0) : 0;
        const cost = (tok('uncached_input_tokens') * table.in
          + tok('output_tokens') * table.out
          + cw5m * table.cw5m + cw1h * table.cw1h + cwFlat * table.cw5m
          + tok('cache_read_input_tokens') * table.cr) / 1_000_000;
        sinceTotal += cost;
        if (day >= monthStart) monthTotal += cost;
      }
    }
    if (body?.has_more && body?.next_page) page = body.next_page;
    else break;
  }
  return { configured: true, sinceTotal, monthTotal };
}

// ---- DigitalOcean: the droplet -------------------------------------------------

async function digitalOceanCost(token) {
  const headers = { Authorization: `Bearer ${token}` };
  const history = await fetchJson('https://api.digitalocean.com/v2/customers/my/billing_history?per_page=100', headers);
  if (!history.ok) return { configured: true, error: `http_${history.status}` };
  let paid = 0;
  for (const item of history.body?.billing_history ?? []) {
    if (item.type === 'Invoice') paid += Number(item.amount || 0);
  }

  const invoices = await fetchJson('https://api.digitalocean.com/v2/customers/my/invoices?per_page=100', headers);
  const preview = invoices.body?.invoice_preview;
  let accrued = 0, credit = 0, creditNote = null;
  if (preview?.invoice_uuid) {
    const detail = await fetchJson(`https://api.digitalocean.com/v2/customers/my/invoices/${preview.invoice_uuid}`, headers);
    for (const item of detail.body?.invoice_items ?? []) {
      const amount = Number(item.amount || 0);
      if (amount < 0 || item.product === 'Credits') { credit += amount; creditNote = item.description; }
      else accrued += amount;
    }
  }
  return { configured: true, paid, accrued, credit, creditNote };
}

// ---- ElevenLabs: STT ------------------------------------------------------------

function monthsElapsedSince(startIso, now = new Date()) {
  const start = new Date(startIso);
  return (now.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (now.getUTCMonth() - start.getUTCMonth()) + 1;
}

async function elevenLabsCost(apiKey) {
  const { ok, status, body } = await fetchJson(
    'https://api.elevenlabs.io/v1/user/subscription', { 'xi-api-key': apiKey });
  if (!ok) {
    if (status === 401 && body?.detail?.status === 'missing_permissions') {
      return { configured: true, error: 'missing_permission' };
    }
    return { configured: true, error: `http_${status}` };
  }
  const monthlyUsd = typeof body?.next_invoice?.amount_due_cents === 'number'
    ? body.next_invoice.amount_due_cents / 100 : 0;
  const months = monthsElapsedSince(ELEVENLABS_START);
  return {
    configured: true,
    tier: body?.tier ?? null,
    monthlyUsd,
    sinceTotal: monthlyUsd * months,
    monthTotal: monthlyUsd,
    characterCount: body?.character_count ?? null,
    characterLimit: body?.character_limit ?? null,
  };
}

// ---- OpenRouter: the model provider Olma actually runs on ----------------------
// Since the 2026-08-26 cutover this IS the model bill — every background
// cognition call (fact extraction, planning, live-update summaries), every
// image and video generation, the evals judge. The Anthropic row above it is
// now mostly history, which makes this the single most important line on the
// page and the one that was missing from it entirely.
//
// Both figures come from OpenRouter's own reporting, never token arithmetic:
// /auth/key carries lifetime + monthly + daily usage for this key, /credits
// carries what was purchased. daysLeft is those two divided — the provider's
// own burn rate against the provider's own balance, so it needs no
// bookkeeping of ours to stay true.
async function openRouterCost(apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const [key, credits] = await Promise.all([
    fetchJson('https://openrouter.ai/api/v1/auth/key', headers),
    fetchJson('https://openrouter.ai/api/v1/credits', headers),
  ]);
  if (!key.ok) return { configured: true, error: `http_${key.status}` };
  const d = key.body?.data ?? {};
  const c = credits.ok ? (credits.body?.data ?? {}) : {};
  const purchased = Number(c.total_credits);
  const used = Number(c.total_usage ?? d.usage) || 0;
  // Only a purchased figure we actually read makes a remaining balance
  // meaningful. Defaulting it to 0 would render a confident "$0.00 left" for
  // a call that simply failed — the alarming shape, from missing data.
  const remaining = Number.isFinite(purchased) ? purchased - used : null;
  const daily = Number(d.usage_daily) || 0;
  return {
    configured: true, prepaid: true,
    sinceTotal: used,
    monthTotal: Number(d.usage_monthly) || 0,
    dailyTotal: daily,
    remaining,
    daysLeft: remaining !== null && daily > 0 ? remaining / daily : null,
  };
}

// ---- Twilio: the phone number the voice bridge calls out on --------------------
async function twilioCost(sid, token) {
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const { ok, status, body } = await fetchJson(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`,
    { Authorization: auth });
  if (!ok) return { configured: true, error: `http_${status}` };
  return {
    configured: true, prepaid: true,
    remaining: Number(body?.balance) || 0,
    currency: body?.currency || 'USD',
  };
}

// ---- Deepgram: speech-to-text on live calls -----------------------------------
// The balance is per project and the key does not name one, so this is two
// calls: list projects, then read the first one's balances.
async function deepgramCost(apiKey) {
  const headers = { Authorization: `Token ${apiKey}` };
  const projects = await fetchJson('https://api.deepgram.com/v1/projects', headers);
  if (!projects.ok) return { configured: true, error: `http_${projects.status}` };
  const id = projects.body?.projects?.[0]?.project_id;
  if (!id) return { configured: true, error: 'no_project' };
  const bal = await fetchJson(`https://api.deepgram.com/v1/projects/${id}/balances`, headers);
  if (!bal.ok) return { configured: true, error: `http_${bal.status}` };
  const remaining = (bal.body?.balances ?? [])
    .reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  return { configured: true, prepaid: true, remaining };
}

// ---- Cartesia: text-to-speech on live calls -----------------------------------
// Probed 2026-08-31: /subscription, /usage and /account all 404 — there is no
// billing endpoint to read. It is listed anyway, with that said plainly,
// because a paid service missing from the page is one the owner cannot see
// they are paying for. Silence here would be the same failure the whole
// prepaid/recurring split above exists to prevent.
function cartesiaCost(apiKey) {
  return { configured: Boolean(apiKey), noBillingApi: true };
}

// ---- USD/ILS: every dollar figure on the page is shown in shekels too ---------
// Free, no key, no signup — open.er-api.com wraps exchangerate-api.com's free
// tier and refreshes once a day, which is what sets this cache's TTL: a rate
// that only changes once every 24h gains nothing from being fetched more
// often, and the page is read far more often than that.
const FX_CACHE_MS = 12 * 3600_000;
let fxCache = null; // { at, rate }

async function usdIlsRate() {
  if (fxCache && Date.now() - fxCache.at < FX_CACHE_MS) return { configured: true, rate: fxCache.rate };
  const { ok, status, body } = await fetchJson('https://open.er-api.com/v6/latest/USD');
  if (!ok || body?.result !== 'success') {
    // A stale cached rate is still a real rate; only a first-ever failure with
    // nothing cached yet has to say so honestly.
    if (fxCache) return { configured: true, rate: fxCache.rate, stale: true };
    return { configured: true, error: `http_${status}` };
  }
  const rate = Number(body?.rates?.ILS);
  if (!Number.isFinite(rate) || rate <= 0) return { configured: true, error: 'bad_rate' };
  fxCache = { at: Date.now(), rate };
  return { configured: true, rate };
}

// ---- Claude subscription: hardcoded, no network -------------------------------

// `overrides` is {"YYYY-MM": usd} for months billed at something other than the
// standing rate — a one-month Max upgrade, a paused month, a price change. It
// exists because the flat constant became wrong the first time the plan changed
// and there is no API anywhere that could have noticed: subscription billing is
// not exposed by the org endpoints, which cover API keys only. So the number
// has to come from the one person who sees the receipt, and it must reach the
// page as an edit rather than a deploy.
function subscriptionCost(now = new Date(), overrides = {}) {
  // Each billing month named the way the override map keys it, so a month is
  // priced by exactly one rule and there is nothing to keep in sync.
  const rateFor = (d) => {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const v = Number(overrides[key]);
    return Number.isFinite(v) ? v : SUBSCRIPTION_USD;
  };

  let count = 0, sinceTotal = 0;
  const cursor = new Date(PROJECT_START);
  while (cursor <= now) {
    count += 1;
    sinceTotal += rateFor(cursor);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const billedThisWeek = [...Array(7).keys()].some((i) => {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    return d.getUTCDate() === SUBSCRIPTION_BILLING_DAY;
  });
  return {
    configured: true, count, sinceTotal,
    monthTotal: billedThisWeek ? rateFor(now) : 0,
    rate: rateFor(now),
    overridden: rateFor(now) !== SUBSCRIPTION_USD,
  };
}

// ---- entry point ------------------------------------------------------------

async function getInfraCosts() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const guarded = (secret, fn) => (secret
    ? fn().catch((e) => ({ configured: true, error: e.message }))
    : Promise.resolve({ configured: false }));

  const [anthropic, digitalocean, elevenlabs, openrouter, twilio, deepgram] = await Promise.all([
    guarded(process.env.ANTHROPIC_ADMIN_KEY, () => anthropicBotCost(process.env.ANTHROPIC_ADMIN_KEY)),
    guarded(process.env.DO_API_TOKEN, () => digitalOceanCost(process.env.DO_API_TOKEN)),
    guarded(process.env.ELEVENLABS_API_KEY, () => elevenLabsCost(process.env.ELEVENLABS_API_KEY)),
    guarded(process.env.OPENROUTER_API_KEY, () => openRouterCost(process.env.OPENROUTER_API_KEY)),
    guarded(process.env.TWILIO_SID && process.env.TWILIO_TOKEN,
      () => twilioCost(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)),
    guarded(process.env.DEEPGRAM_API_KEY, () => deepgramCost(process.env.DEEPGRAM_API_KEY)),
  ]);
  const subscription = subscriptionCost();
  const cartesia = cartesiaCost(process.env.CARTESIA_API_KEY);

  const data = {
    anthropic, digitalocean, elevenlabs, subscription,
    openrouter, twilio, deepgram, cartesia,
    generatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

// anthropicBotCost is exported for the test that pins the response shape —
// the field-name bug it covers was invisible to every other kind of check.
module.exports = {
  getInfraCosts, anthropicBotCost, openRouterCost, twilioCost, deepgramCost,
  subscriptionCost, usdIlsRate, PROJECT_START, ELEVENLABS_START, SUBSCRIPTION_USD,
};
