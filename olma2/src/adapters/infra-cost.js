'use strict';
// Real infrastructure spend for running Olma — the droplet, the bot's own
// Anthropic usage, and ElevenLabs STT. Each fetcher degrades to
// {configured:false} when its secret isn't set, and never throws: a billing
// API being slow or down must not break the admin dashboard.
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

const ANTHROPIC_PRICES = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00, cw: 1.25, cr: 0.10 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cw: 3.75, cr: 0.30 },
  'claude-opus-4-8': { in: 15.00, out: 75.00, cw: 18.75, cr: 1.50 },
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
        const cacheWrite = tok('cache_creation') || tok('cache_creation_input_tokens');
        const cost = (tok('uncached_input_tokens') * table.in
          + tok('output_tokens') * table.out
          + cacheWrite * table.cw
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

// ---- Claude subscription: hardcoded, no network -------------------------------

function subscriptionCost(now = new Date()) {
  let count = 0;
  const cursor = new Date(PROJECT_START);
  while (cursor <= now) {
    count += 1;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const monthTotal = [...Array(7).keys()].some((i) => {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    return d.getUTCDate() === SUBSCRIPTION_BILLING_DAY;
  }) ? SUBSCRIPTION_USD : 0;
  return { configured: true, count, sinceTotal: count * SUBSCRIPTION_USD, monthTotal };
}

// ---- entry point ------------------------------------------------------------

async function getInfraCosts() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const [anthropic, digitalocean, elevenlabs] = await Promise.all([
    process.env.ANTHROPIC_ADMIN_KEY
      ? anthropicBotCost(process.env.ANTHROPIC_ADMIN_KEY).catch((e) => ({ configured: true, error: e.message }))
      : Promise.resolve({ configured: false }),
    process.env.DO_API_TOKEN
      ? digitalOceanCost(process.env.DO_API_TOKEN).catch((e) => ({ configured: true, error: e.message }))
      : Promise.resolve({ configured: false }),
    process.env.ELEVENLABS_API_KEY
      ? elevenLabsCost(process.env.ELEVENLABS_API_KEY).catch((e) => ({ configured: true, error: e.message }))
      : Promise.resolve({ configured: false }),
  ]);
  const subscription = subscriptionCost();

  const data = { anthropic, digitalocean, elevenlabs, subscription, generatedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

// anthropicBotCost is exported for the test that pins the response shape —
// the field-name bug it covers was invisible to every other kind of check.
module.exports = { getInfraCosts, anthropicBotCost, PROJECT_START, ELEVENLABS_START };
