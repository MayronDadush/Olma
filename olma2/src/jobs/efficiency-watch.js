'use strict';
// ── The efficiency watch ─────────────────────────────────────────────────────
// Owner ask, 2026-09-04: whenever something crosses a threshold RELATIVE TO OUR
// ACTIVITY AND USER COUNT, work out on its own what happened and how to shorten
// or optimise it, and tell the admin afterwards.
//
// The "relative to activity" half is the whole design. An absolute dollar
// threshold on a system this size is useless in both directions: $4.57 in one
// day was once a single honest WhatsApp conversation, and $2 can be a runaway
// prefix nobody is reading. So every metric here is a RATIO — per inbound
// message, or as a share — and every ratio is judged against what this system's
// own recent days looked like, not against a number somebody guessed.
//
// ── What this deliberately does NOT do ───────────────────────────────────────
// It never edits anything. It measures, gathers the evidence that explains the
// jump, asks the background model for a short recommendation, files a dashboard
// row, and messages the admin. The change itself stays a human decision that
// goes through CI and the behavioural evals.
//
// That boundary is not timidity, it is this repo's own finding. The one thing
// every ratio here can be improved by is shortening what the model reads — and
// `agents-template.md` is doctrine: rules written after real incidents, several
// of them about consent between users. A process that shortens its own doctrine
// overnight to save tokens is optimising the exact thing the evals exist to
// protect, with nobody reading the diff. Hours before this file was written,
// 1,227 chars of that same doctrine were being silently deleted by the gateway
// and nothing noticed for a day; the lesson taken from that is not "let a
// second automatic process cut it too".
//
// So: detection, investigation and the recommendation are automatic and cost
// about $0.0001 a day. Applying is a PR. Flipping that is a deliberate,
// separate decision, not a config change.
const flagsDomain = require('../domain/flags');

// Ratios worth watching, each with the direction that is BAD and why it earns
// a place. Adding one is an entry here — the sweep, the baseline, the
// tiering and the notification are all generic over this table (the same
// registry shape live-updates uses for its sources).
//
// `min` is the activity floor below which the ratio is noise rather than a
// signal: two messages on a quiet Saturday can produce any number at all, and
// a watchdog that fires on a slow weekend is one nobody reads by November.
const METRICS = [
  {
    key: 'input_tokens_per_message',
    label: 'טוקני קלט להודעה',
    // Reading tokens are ~97% of everything here — 53.2M of 54.5M input tokens
    // are cache reads. When this ratio moves, the prompt got bigger or the
    // cache stopped being hit; both are fixable and neither announces itself.
    worse: 'higher',
    factor: 2,
    minMessages: 20,
  },
  {
    key: 'cost_per_message',
    label: 'עלות להודעה',
    // The measured baseline is ≈$0.0053/message all-in. This is the ratio the
    // owner actually feels, and the one a pricing decision rests on.
    worse: 'higher',
    factor: 2,
    minMessages: 20,
  },
  {
    key: 'cache_hit_rate',
    // Not a cost by itself — it is the EXPLANATION for most jumps in the two
    // above, and it moves first. 1h cache retention was bought precisely to
    // keep this high; a collapse means that bet stopped paying without anyone
    // being told.
    label: 'שיעור פגיעה במטמון',
    worse: 'lower',
    factor: 2,
    minMessages: 20,
  },
  {
    key: 'system_cost_share',
    // Background sweeps (planning, extraction, digests, the evals judge) have
    // no user waiting on them, so they are the one class that can grow without
    // anybody noticing it got slower or chattier.
    label: 'חלק העלות של תהליכי הרקע',
    worse: 'higher',
    factor: 2,
    minMessages: 20,
  },
];

const BASELINE_DAYS = 7;
const ALERTED_FLAG = 'efficiency_watch_alerted';

// One row per day: the four ratios plus the denominators that produced them,
// so a later reading can tell "the cost doubled" from "the traffic halved".
async function dailyRatios(client, days) {
  const { rows } = await client.query(
    `WITH days AS (
       SELECT generate_series((current_date - ($1::int - 1))::date, current_date, '1 day')::date AS d
     ),
     msgs AS (
       SELECT (created_at AT TIME ZONE 'UTC')::date AS d, count(*)::bigint AS n
         FROM audit_log WHERE event = 'message.received'
          AND created_at >= current_date - ($1::int - 1)
        GROUP BY 1
     ),
     usr AS (
       SELECT date AS d,
              sum(input_tokens + cache_read_tokens + cache_write_tokens)::bigint AS in_tok,
              sum(cache_read_tokens)::bigint AS cache_tok,
              sum(cost_usd)::numeric AS cost
         FROM usage_ledger WHERE date >= current_date - ($1::int - 1) GROUP BY 1
     ),
     sys AS (
       SELECT date AS d, sum(cost_usd)::numeric AS cost
         FROM usage_system_ledger WHERE date >= current_date - ($1::int - 1) GROUP BY 1
     )
     SELECT days.d::text AS date,
            coalesce(msgs.n, 0)::bigint      AS messages,
            coalesce(usr.in_tok, 0)::bigint  AS in_tokens,
            coalesce(usr.cache_tok, 0)::bigint AS cache_tokens,
            coalesce(usr.cost, 0)::float8    AS user_cost,
            coalesce(sys.cost, 0)::float8    AS system_cost
       FROM days
       LEFT JOIN msgs ON msgs.d = days.d
       LEFT JOIN usr  ON usr.d  = days.d
       LEFT JOIN sys  ON sys.d  = days.d
      ORDER BY days.d`,
    [days]
  );
  return rows.map((r) => {
    const messages = Number(r.messages);
    const inTok = Number(r.in_tokens);
    const total = Number(r.user_cost) + Number(r.system_cost);
    return {
      date: r.date,
      messages,
      inTokens: inTok,
      userCost: Number(r.user_cost),
      systemCost: Number(r.system_cost),
      // null, never 0, on a day with no denominator. A zero here would read as
      // "perfectly efficient" and drag every baseline down with it — the same
      // rule the cost page's `remaining: null` follows.
      input_tokens_per_message: messages ? inTok / messages : null,
      cost_per_message: messages ? total / messages : null,
      cache_hit_rate: inTok ? Number(r.cache_tokens) / inTok : null,
      system_cost_share: total ? Number(r.system_cost) / total : null,
    };
  });
}

// Median, not mean: one pilot day, one long negotiation, or one day the evals
// ran twice must not redefine what normal costs. With an even count this takes
// the lower of the two middles — deliberately the more conservative side, so
// the baseline is never flattered.
function median(values) {
  const xs = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.floor((xs.length - 1) / 2)];
}

// Compares the day under test against the median of the days before it.
// Returns one entry per metric that crossed, never a boolean — what crossed and
// by how much is the whole content of the report.
function crossings(history, today) {
  const prior = history.filter((d) => d.date !== today.date);
  const out = [];
  for (const m of METRICS) {
    const now = today[m.key];
    if (now === null) continue;
    if (today.messages < m.minMessages) continue;
    const base = median(prior.map((d) => d[m.key]));
    // No baseline is not a crossing. A system with four days of history has
    // nothing to be surprised by yet, and inventing a threshold for it would
    // make the watch's first week pure noise.
    if (base === null || base === 0) continue;
    const ratio = m.worse === 'higher' ? now / base : base / now;
    if (!Number.isFinite(ratio) || ratio < m.factor) continue;
    out.push({ key: m.key, label: m.label, now, baseline: base, times: ratio, worse: m.worse });
  }
  return out;
}

// The investigation, and it is deliberately plain SQL rather than anything
// clever: which models and which users moved, on the day it moved. This is the
// evidence a person would go and pull by hand, gathered before anyone has to.
async function evidence(client, date) {
  const [models, users] = await Promise.all([
    client.query(
      `SELECT model,
              sum(input_tokens + cache_read_tokens + cache_write_tokens)::bigint AS in_tokens,
              sum(cache_read_tokens)::bigint AS cache_tokens,
              sum(cost_usd)::float8 AS cost
         FROM usage_ledger WHERE date = $1::date
        GROUP BY model ORDER BY cost DESC LIMIT 5`, [date]),
    client.query(
      `SELECT user_id, sum(cost_usd)::float8 AS cost,
              sum(input_tokens + cache_read_tokens + cache_write_tokens)::bigint AS in_tokens
         FROM usage_ledger WHERE date = $1::date AND user_id IS NOT NULL
        GROUP BY user_id ORDER BY cost DESC LIMIT 5`, [date]),
  ]);
  return {
    models: models.rows.map((r) => ({
      model: r.model,
      inTokens: Number(r.in_tokens),
      cacheRate: Number(r.in_tokens) ? Number(r.cache_tokens) / Number(r.in_tokens) : null,
      cost: Number(r.cost),
    })),
    users: users.rows.map((r) => ({ userId: Number(r.user_id), cost: Number(r.cost), inTokens: Number(r.in_tokens) })),
  };
}

const pct = (v) => (v === null ? '?' : `${Math.round(v * 100)}%`);
const usd = (v) => `$${Number(v).toFixed(4)}`;
const num = (v) => Math.round(Number(v)).toLocaleString('en-US');

function fmtValue(key, v) {
  if (v === null) return '?';
  if (key === 'cache_hit_rate' || key === 'system_cost_share') return pct(v);
  if (key === 'cost_per_message') return usd(v);
  return num(v);
}

// What the model is asked. It gets numbers and nothing else — no transcripts,
// no user content — and it is asked for the two things a person would want and
// a query cannot produce: the likeliest cause, and what to shorten. The server
// stays the judge: this returns text for a human, and no part of it is ever
// executed, applied, or written anywhere but the report.
function briefFor(crossed, today, ev, promptChars) {
  return [
    'You are looking at one day of cost telemetry for a small WhatsApp assistant',
    `(${today.messages} inbound messages that day, ${ev.users.length} paying users measured).`,
    'These ratios crossed 2x their own 7-day median:',
    ...crossed.map((c) => `- ${c.key}: ${fmtValue(c.key, c.now)} vs baseline ${fmtValue(c.key, c.baseline)} (${c.times.toFixed(1)}x)`),
    '',
    'Models that day:',
    ...ev.models.map((m) => `- ${m.model}: ${num(m.inTokens)} input tokens, cache hit ${pct(m.cacheRate)}, ${usd(m.cost)}`),
    '',
    promptChars ? `The system prompt each turn injects is ${num(promptChars)} characters.` : '',
    '',
    'Answer in Hebrew, at most 4 short lines, no preamble:',
    '1. The single most likely cause, stated as a guess and labelled as one.',
    '2. The one change that would cut this most, concretely.',
    'Do not suggest changing the model unless the numbers point at the model.',
    'If the numbers do not support a confident cause, say so instead of inventing one.',
  ].filter(Boolean).join('\n');
}

function reportText(crossed, today, ev, advice) {
  const lines = [
    '📈 אולמה — יעילות: משהו חרג מהרגיל',
    `${today.date} · ${today.messages} הודעות נכנסות`,
    '',
    ...crossed.map((c) => `• ${c.label}: ${fmtValue(c.key, c.now)} (רגיל: ${fmtValue(c.key, c.baseline)}, פי ${c.times.toFixed(1)})`),
  ];
  if (ev.models.length) {
    lines.push('', 'מודלים:');
    for (const m of ev.models.slice(0, 3)) {
      lines.push(`• ${m.model} — ${usd(m.cost)}, מטמון ${pct(m.cacheRate)}`);
    }
  }
  if (advice) lines.push('', advice.trim());
  // Said every time, because it is the thing that would otherwise be assumed
  // after the third or fourth of these arrives.
  lines.push('', 'לא שיניתי כלום — זו בדיקה בלבד. הפרטים בדשבורד.');
  return lines.join('\n');
}

const SELF_AGENT_ID = 'efficiency-watch';

async function recordOwnUsage(client, res) {
  const pricing = require('../domain/model-pricing');
  const u = res.usage;
  // The provider's own stated price wins whenever it gave one; the rate table
  // is the fallback only, and `0` is a real price that must stay
  // distinguishable from "not reported" — a truthiness check here throws one
  // away with the other.
  const stated = Number(u.costUsd);
  const priced = Number.isFinite(stated) && stated >= 0
    ? { cost: stated, estimated: false }
    : pricing.priceUsage(u, res.model, null);
  await client.query(
    `INSERT INTO usage_system_ledger
       (agent_id, date, model, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, cost_usd, estimated)
     VALUES ($1, current_date, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (agent_id, date, model) DO UPDATE SET
       input_tokens = usage_system_ledger.input_tokens + $3,
       output_tokens = usage_system_ledger.output_tokens + $4,
       cache_read_tokens = usage_system_ledger.cache_read_tokens + $5,
       cache_write_tokens = usage_system_ledger.cache_write_tokens + $6,
       cost_usd = usage_system_ledger.cost_usd + $7,
       estimated = usage_system_ledger.estimated OR $8`,
    [SELF_AGENT_ID, res.model || '', u.input || 0, u.output || 0,
     u.cacheRead || 0, u.cacheWrite || 0, Number(priced.cost).toFixed(8), !!priced.estimated]
  );
}

// ── The sweep ────────────────────────────────────────────────────────────────
// deps: { send, llm, promptChars, alertHourOpen, today }
//   send          — the raw `openclaw message send` pipe (no model, no credit)
//   llm           — { complete, backgroundModel } or null to skip the advice
//   promptChars   — current rendered AGENTS.md size, for the brief
//   alertHourOpen — shared with credit-watch: nothing wakes anybody at night
async function run(client, deps = {}) {
  // The same flag and the same fallback the credit alarm uses — imported, not
  // re-typed, so the two alarms can never end up pointing at different people.
  const creditWatch = require('./credit-watch');
  const phone = deps.adminPhone
    || (await flagsDomain.getFlag(client, creditWatch.ALERT_PHONE_FLAG))
    || creditWatch.DEFAULT_ALERT_PHONE;
  const history = await dailyRatios(client, BASELINE_DAYS + 1);
  const today = history[history.length - 1];
  if (!today) return { checked: 0 };

  const crossed = crossings(history, today);
  const stats = {
    date: today.date,
    messages: today.messages,
    // Reported every tick even when nothing crossed, so the ratios are numbers
    // an operator watches drift rather than news they hear once. A watch that
    // is silent when healthy is indistinguishable from a watch that is broken.
    ratios: Object.fromEntries(METRICS.map((m) => [m.key, today[m.key]])),
  };
  if (!crossed.length) {
    // Recovery re-arms the alert: a condition that cleared drops out, so the
    // same regression next month is news again instead of being swallowed by a
    // stale stamp. Written unconditionally, even on ticks that send nothing.
    await flagsDomain.setFlag(client, ALERTED_FLAG, []);
    return { ...stats, crossed: 0 };
  }

  const ev = await evidence(client, today.date);

  // Announced once per condition, exactly like the runway warning: the same
  // ratio still being high tomorrow is not new information, and a daily
  // "still expensive" is how somebody learns to swipe these away.
  const already = (await flagsDomain.getFlag(client, ALERTED_FLAG)) || [];
  const keys = crossed.map((c) => c.key);
  const fresh = crossed.filter((c) => !already.includes(c.key));

  let advice = null;
  if (fresh.length && deps.llm !== null) {
    const llm = deps.llm || require('../adapters/llm');
    try {
      const res = await llm.complete({
        ...(await llm.backgroundModel(client)),
        user: briefFor(fresh, today, ev, deps.promptChars),
        // A reasoning model can spend its whole answer budget thinking and
        // return nothing — the live-updates summariser lost a real run to
        // exactly that at 700. Four short lines need nowhere near this; the
        // reasoning does.
        maxTokens: 2000,
      });
      advice = res && res.ok && res.text ? String(res.text).trim().slice(0, 600) : null;
      // Recorded even though it is a hundredth of a cent: a direct call has no
      // transcript for the usage sweep to find, so unrecorded spend does not
      // exist on paper (migration 012's whole lesson). It belongs in the SYSTEM
      // ledger — there is no user behind it — which also keeps this job's own
      // cost inside the `system_cost_share` ratio it is watching. That is
      // deliberate: a watchdog that grew expensive should show up in its own
      // numbers rather than being exempt from them.
      if (res && res.ok && res.usage) await recordOwnUsage(client, res);
    } catch {
      // A failed advice call must never cost the report. The numbers are the
      // part that is true; the recommendation is only the part that is helpful.
      advice = null;
    }
  }

  // The durable record first, the message second — the dashboard row has to
  // exist even if the pipe is down, which is the same order config_guard files
  // in and for the same reason.
  let filed = 0;
  for (const c of fresh) {
    // No number in the title: fileViolations-style dedup keys on it, and a
    // ratio in the title would file a new issue every single day.
    const title = `efficiency: ${c.key} is far above its own recent baseline`;
    const { rows } = await client.query(
      `SELECT 1 FROM issues WHERE title = $1 AND status IN ('new','triaged')`, [title]);
    if (rows[0]) continue;
    await client.query(
      `INSERT INTO issues (category, source, title, detail, status)
       VALUES ('bug', 'agent_detected', $1, $2, 'new')`,
      [title, JSON.stringify({ ...c, date: today.date, evidence: ev, advice }).slice(0, 4000)]);
    filed++;
  }

  const out = { ...stats, crossed: crossed.length, newConditions: fresh.length, filed };
  if (!fresh.length) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return out;
  }
  if (!phone || !deps.send) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return { ...out, notified: false, reason: 'no admin pipe' };
  }
  // Nothing wakes the owner any more (2026-09-01). This is the least urgent
  // alarm in the system — a ratio cannot be fixed at 03:00 and reads exactly
  // the same at 09:00 — so it simply waits, unstamped, and the next tick
  // inside the window sends it.
  if (deps.alertHourOpen && !(await deps.alertHourOpen(client, phone))) {
    return { ...out, notified: false, deferredToMorning: true };
  }
  let sent = null;
  try { sent = await deps.send(phone, reportText(fresh, today, ev, advice)); } catch { sent = null; }
  // Only a CONFIRMED send marks the condition as announced. A failed pipe
  // leaves it unstamped so the next tick retries — the promise credit-watch,
  // the balance forecast and config_guard all make.
  if (sent && sent.ok) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return { ...out, notified: true, phone };
  }
  return { ...out, notified: false, notifyFailed: true };
}

module.exports = {
  run, dailyRatios, crossings, median, evidence, reportText, briefFor,
  METRICS, BASELINE_DAYS, ALERTED_FLAG, SELF_AGENT_ID,
};
