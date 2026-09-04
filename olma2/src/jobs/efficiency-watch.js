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

// Money is the only thing here that gets to send a WhatsApp. Everything still
// gets DETECTED, filed and reported — the gate is on the interruption, not on
// the knowledge.
//
// This watch's first real alert, 2026-09-04 08:41, is what the distinction
// costs. Input tokens per message had gone 50k → 224k over a week and the
// cache had fallen 70% → 29%, so it filed two issues and messaged the owner
// about a regression; `cost_per_message` across those same eight days was
// $0.0153, $0.0112, $0.0127, $0.0270, $0.0091, $0.0415, $0.0152, $0.0209 — no
// trend at all, and the spikes in it were model pilots. An alarm that
// overstates is spent the first time somebody checks it.
//
// But the first version of this rule went too far and would have deleted a
// real finding. Measured per API CALL rather than per message, the thing that
// moved was structural and genuine: model calls per inbound message 0.6 → 7.8,
// cache reads per call flat while fresh tokens grew 2.4x. That is worth
// knowing, and a rule that can only ever notice a regression once it has become
// money learns about that class of problem last. So the proxies keep their
// detection, their dashboard row and their line in the heartbeat, and lose only
// the right to make somebody's phone buzz.
//
// This also subsumes the floor `system_cost_share` would otherwise need: a
// share doubles when the numerator grows OR when the denominator shrinks, and
// only the first is a regression. Requiring money to have moved before
// interrupting rules out the second without a second rule to keep in step.
const MONEY_KEY = 'cost_per_message';

// Splits crossings into the ones that may INTERRUPT and the ones that are only
// recorded. It never DROPS a crossing — `observed` is reported in the heartbeat
// and files its issue exactly like the rest — because a check that quietly
// declines to judge is indistinguishable from one that passed.
function escalate(crossed) {
  const money = crossed.some((c) => c.key === MONEY_KEY);
  return money ? { alerting: crossed, observed: [] } : { alerting: [], observed: crossed };
}

// Four significant digits. The only consumer of `ratios` is a 200-char
// heartbeat note, and full float precision spends twenty characters proving a
// ratio is 0.023642541081081082 rather than 0.02364 — characters the note was
// paying out of the verdict at the end of it.
function sig4(v) {
  return v === null || !Number.isFinite(v) ? v : Number(v.toPrecision(4));
}

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

// ── Spikes and slides are different failures ─────────────────────────────────
// On 2026-09-04 this watch fired on cache_hit_rate and was RIGHT about the
// number and wrong about everything after it. The rate had walked
// 73% → 71% → 46% → 30% → 31% → 21% → 20% across seven days; the report
// presented the last of those as a same-day event, the brief below asked what
// changed today, and the model answered with the only shape the question
// allowed — "a template changed / a new user joined". Neither was true. The
// real driver was gradual: model calls per inbound message went 0.6 → 7.8 over
// the same window, while cache reads per call stayed flat. The suggested fix
// that came back — shorten the system prompt — would have deleted the one
// region that WAS cached and raised the bill.
//
// Note what this is NOT a story about: the spike test was not late. Replayed
// over the real series it crosses on 09-01, a day before the trend test does
// (`tests/efficiency-watch.test.js` pins both). The watch was quiet until
// 09-04 because it did not exist until 09-04. Two things follow, and only the
// second is about detection at all:
//
//   1. The FRAMING was the defect. A slide and a jump need different questions
//      asked about them, so the entry now carries which one it is and the
//      day-by-day series travels with it into both the report and the brief.
//   2. There is still a real blind spot beside it: a ratio that compounds
//      gently never crosses 2x against a trailing median that is rising with
//      it. Measured — 12%/day for eight days is a 2.2x total degradation whose
//      spike ratio peaks at 1.57 and never fires. This second test sees it.
//
// So: compare the median of the last few days against the median of the days
// before THOSE. It needs no day to be extreme. The factor is lower than a
// spike's deliberately — a shift that persisted for three days earns less
// surprise per unit than one that arrived at once, but more confidence.
const TREND_RECENT_DAYS = 3;
const TREND_FACTOR = 1.5;

// A sustained shift, or null. `series` rides along because the whole point is
// that the reader (and the model in briefFor) can see it is a slope rather
// than a jump — that is the half that was actually wrong in September.
function trendFor(history, m) {
  const days = history.filter((d) => d[m.key] !== null && Number.isFinite(d[m.key]));
  // Two windows, each needing enough days to have a median worth the name.
  if (days.length < TREND_RECENT_DAYS + 2) return null;
  const recent = days.slice(-TREND_RECENT_DAYS);
  const prior = days.slice(0, -TREND_RECENT_DAYS);
  if (prior.length < 2) return null;
  // The same activity floor the spike test applies, over the window rather
  // than over one day: three quiet days in a row can produce any slope at all.
  const activity = median(recent.map((d) => d.messages));
  if (activity === null || activity < m.minMessages) return null;
  const now = median(recent.map((d) => d[m.key]));
  const base = median(prior.map((d) => d[m.key]));
  if (now === null || base === null || base === 0) return null;
  const times = m.worse === 'higher' ? now / base : base / now;
  if (!Number.isFinite(times) || times < (m.trendFactor || TREND_FACTOR)) return null;
  return {
    now, baseline: base, times,
    recentDays: recent.length, priorDays: prior.length,
    from: days[0].date, to: days[days.length - 1].date,
    series: days.map((d) => ({ date: d.date, value: d[m.key] })),
  };
}

// Compares the day under test against the median of the days before it, and
// separately asks whether it has been drifting. Returns one entry per metric —
// never two for the same one, because "it spiked" and "it has been sliding"
// are one piece of news to the person reading, not two. A spike wins the
// headline and carries the trend as context; a trend alone is its own entry,
// and that is the one that arrives days earlier than this watch used to.
function crossings(history, today) {
  const prior = history.filter((d) => d.date !== today.date);
  const out = [];
  for (const m of METRICS) {
    const trend = trendFor(history, m);
    const now = today[m.key];
    let spike = null;
    if (now !== null && today.messages >= m.minMessages) {
      const base = median(prior.map((d) => d[m.key]));
      // No baseline is not a crossing. A system with four days of history has
      // nothing to be surprised by yet, and inventing a threshold for it would
      // make the watch's first week pure noise.
      if (base !== null && base !== 0) {
        const ratio = m.worse === 'higher' ? now / base : base / now;
        if (Number.isFinite(ratio) && ratio >= m.factor) spike = { base, ratio };
      }
    }
    if (spike) {
      out.push({ key: m.key, label: m.label, now, baseline: spike.base, times: spike.ratio, worse: m.worse, kind: 'spike', trend });
    } else if (trend) {
      out.push({ key: m.key, label: m.label, now: trend.now, baseline: trend.baseline, times: trend.times, worse: m.worse, kind: 'trend', trend });
    }
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
  const drifting = crossed.filter((c) => c.kind === 'trend' || c.trend);
  return [
    'You are looking at cost telemetry for a small WhatsApp assistant',
    `(${today.messages} inbound messages on the latest day, ${ev.users.length} paying users measured).`,
    '',
    // `!== 'trend'`, never `=== 'spike'`: an entry that reaches here without a
    // kind is a caller this function does not know about, and the one outcome
    // worse than mislabelling it is dropping it out of the brief in silence.
    ...(crossed.some((c) => c.kind !== 'trend') ? [
      'These ratios crossed 2x their own 7-day median IN A SINGLE DAY:',
      ...crossed.filter((c) => c.kind !== 'trend').map((c) =>
        `- ${c.key}: ${fmtValue(c.key, c.now)} vs baseline ${fmtValue(c.key, c.baseline)} (${c.times.toFixed(1)}x)`),
      '',
    ] : []),
    ...(crossed.some((c) => c.kind === 'trend') ? [
      'These ratios did NOT jump on any one day — they have drifted steadily:',
      ...crossed.filter((c) => c.kind === 'trend').map((c) =>
        `- ${c.key}: last ${c.trend.recentDays} days median ${fmtValue(c.key, c.now)} vs the ${c.trend.priorDays} days before them ${fmtValue(c.key, c.baseline)} (${c.times.toFixed(1)}x)`),
      '',
    ] : []),
    // The series is the correction for the mistake this watch actually made:
    // asked "what changed today" about a six-day slope, the model invented a
    // same-day cause. Shown the slope, it cannot.
    ...(drifting.length ? [
      'Day by day, oldest first — read the SHAPE before proposing a cause:',
      ...drifting.map((c) => `- ${c.key}: ${c.trend.series.map((s) => fmtValue(c.key, s.value)).join(' → ')}`),
      '',
      'A metric that moved a little every day is NOT explained by one change on the last day.',
      'Prefer causes that themselves grow gradually — more work per request, accumulating',
      'context, a growing prompt, more tools, more retries — over a discrete edit or a new user.',
      '',
    ] : []),
    'Models on the latest day:',
    ...ev.models.map((m) => `- ${m.model}: ${num(m.inTokens)} input tokens, cache hit ${pct(m.cacheRate)}, ${usd(m.cost)}`),
    '',
    promptChars ? `The system prompt each turn injects is ${num(promptChars)} characters.` : '',
    // Learned the same day: the advice came back "shorten the system prompt to
    // 1,000 chars" for a cache-hit fall whose cached region WAS the system
    // prompt. Cutting it would have deleted the only part that was cached and
    // left the growing uncached part untouched.
    'Note: a falling cache hit rate can mean the cached part shrank OR that the uncached',
    'part grew. Those need opposite fixes, and shortening a stable, cacheable system prompt',
    'makes the second case worse. Say which one the numbers show, or say you cannot tell.',
    '',
    'Answer in Hebrew, at most 4 short lines, no preamble:',
    '1. The single most likely cause, stated as a guess and labelled as one.',
    '2. The one change that would cut this most, concretely.',
    'Do not suggest changing the model unless the numbers point at the model.',
    'If the numbers do not support a confident cause, say so instead of inventing one.',
  ].filter(Boolean).join('\n');
}

function reportText(crossed, day, ev, advice) {
  const lines = [
    '📈 עולמה — יעילות: משהו חרג מהרגיל',
    `${day.date} · ${day.messages} הודעות נכנסות`,
    '',
    // A slide and a jump read identically in a single line of numbers, and the
    // difference is the first thing the reader needs in order to think about
    // a cause at all. So the line says which one it is.
    ...crossed.map((c) => (c.kind === 'trend'
      ? `• ${c.label}: ${fmtValue(c.key, c.now)} (לפני כן: ${fmtValue(c.key, c.baseline)}, פי ${c.times.toFixed(1)}) — במגמה כבר ${c.trend.recentDays + c.trend.priorDays} ימים, לא קפיצה של יום`
      : `• ${c.label}: ${fmtValue(c.key, c.now)} (רגיל: ${fmtValue(c.key, c.baseline)}, פי ${c.times.toFixed(1)})${c.trend ? ' — וגם במגמה כבר כמה ימים' : ''}`)),
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
// deps: { send, llm, promptChars, alertHourOpen }
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
  // One row more than the baseline needs, because the last one is thrown away.
  const history = await dailyRatios(client, BASELINE_DAYS + 2);
  // The day under test is the last COMPLETE one, never the one in progress. A
  // partial day is not a small version of a finished day: at 08:41 on
  // 2026-09-04 this read 306k input tokens per message, when 31 of the day's 37
  // messages so far were morning digests, and 224k by 11:30 as ordinary traffic
  // diluted them. Held against seven finished days, that measures the hour
  // rather than the system — and it is half of why the first alert was false.
  // The partial day leaves the baseline too, for the same reason.
  const complete = history.slice(0, -1);
  const day = complete[complete.length - 1];
  if (!day) return { checked: 0 };

  const crossed = crossings(complete, day);
  const { alerting, observed } = escalate(crossed);
  // The verdict BEFORE the numbers: brokerd stores this as a 200-char heartbeat
  // note, and until now the note ran out mid-ratio and carried no `crossed` and
  // no `filed` at all — the one question an operator brings to it, did this
  // alert, was the part being truncated away.
  const report = (extra) => ({
    date: day.date,
    messages: day.messages,
    crossed: crossed.length,
    observed: observed.map((c) => `${c.key}:${c.kind}`),
    ...extra,
    // Reported every tick even when nothing crossed, so the ratios are numbers
    // an operator watches drift rather than news they hear once. A watch that
    // is silent when healthy is indistinguishable from a watch that is broken.
    ratios: Object.fromEntries(METRICS.map((m) => [m.key, sig4(day[m.key])])),
  });
  if (!crossed.length) {
    // Recovery re-arms the alert: a condition that cleared drops out, so the
    // same regression next month is news again instead of being swallowed by a
    // stale stamp. Written unconditionally, even on ticks that send nothing.
    await flagsDomain.setFlag(client, ALERTED_FLAG, []);
    return report({ alerted: 0, filed: 0 });
  }

  const ev = await evidence(client, day.date);

  // Announced once per condition, exactly like the runway warning: the same
  // ratio still being high tomorrow is not new information, and a daily
  // "still expensive" is how somebody learns to swipe these away.
  const already = (await flagsDomain.getFlag(client, ALERTED_FLAG)) || [];
  // Keyed by metric AND kind, so a ratio that was announced as a slide and
  // then genuinely jumps is news a second time — the runway warning's
  // climbs-tiers-instead-of-repeating rule, applied to a second axis.
  //
  // Before this change the flag could only ever hold a bare metric key, and a
  // bare key meant exactly one thing: that metric's SPIKE was announced. So a
  // legacy entry still silences the spike it recorded, and does not silence a
  // trend — which is information the owner has never been sent. Without that
  // asymmetry the upgrade would either re-announce every live condition or
  // swallow the first trend report of every one of them.
  const condKey = (c) => `${c.key}:${c.kind}`;
  const announced = (c) => already.includes(condKey(c))
    || (c.kind === 'spike' && already.includes(c.key));
  const keys = crossed.map(condKey);
  const fresh = crossed.filter((c) => !announced(c));

  // Only asked for on the path that will actually send. A suppressed
  // condition still files its row with the numbers and the series — the part
  // that is true — and does not spend a model call inventing a cause for
  // something nobody is being interrupted about. September's advice was
  // actively wrong (it proposed shortening the one region that WAS cached),
  // which is the second reason not to generate it where nobody will read it.
  let advice = null;
  if (fresh.length && alerting.length && deps.llm !== null) {
    const llm = deps.llm || require('../adapters/llm');
    try {
      const res = await llm.complete({
        ...(await llm.backgroundModel(client)),
        user: briefFor(fresh, day, ev, deps.promptChars),
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
    // Deterministic, and distinct per kind: the title IS the dedup key, and a
    // slide and a jump in the same ratio are two different things to go and
    // look at. Neither carries a number, for the reason above.
    const title = c.kind === 'trend'
      ? `efficiency: ${c.key} has been drifting away from its baseline for days`
      : `efficiency: ${c.key} is far above its own recent baseline`;
    const { rows } = await client.query(
      `SELECT 1 FROM issues WHERE title = $1 AND status IN ('new','triaged')`, [title]);
    if (rows[0]) continue;
    await client.query(
      `INSERT INTO issues (category, source, title, detail, status)
       VALUES ('bug', 'agent_detected', $1, $2, 'new')`,
      // `observed` travels with the issue: a proxy that crossed on the same day
      // is the first thing an investigation would want, and it is the only
      // place a suppressed crossing is written down in full.
      [title, JSON.stringify({
        ...c, date: day.date, evidence: ev, advice, observed,
      }).slice(0, 4000)]);
    filed++;
  }

  const base = { alerted: alerting.length, newConditions: fresh.length, filed };
  // Detected, filed, reported — and deliberately not sent. The stamp is NOT
  // written here: it records what the owner has been TOLD, so leaving it clear
  // means that when the cost crossing this may have been the early warning for
  // finally arrives, the message carries the whole picture instead of one line
  // about money with its explanation already marked as old news.
  if (!alerting.length) return report({ ...base, notified: false });
  if (!fresh.length) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return report(base);
  }
  if (!phone || !deps.send) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return report({ ...base, notified: false, reason: 'no admin pipe' });
  }
  // Nothing wakes the owner any more (2026-09-01). This is the least urgent
  // alarm in the system — a ratio cannot be fixed at 03:00 and reads exactly
  // the same at 09:00 — so it simply waits, unstamped, and the next tick
  // inside the window sends it.
  if (deps.alertHourOpen && !(await deps.alertHourOpen(client, phone))) {
    return report({ ...base, notified: false, deferredToMorning: true });
  }
  let sent = null;
  try { sent = await deps.send(phone, reportText(fresh, day, ev, advice)); } catch { sent = null; }
  // Only a CONFIRMED send marks the condition as announced. A failed pipe
  // leaves it unstamped so the next tick retries — the promise credit-watch,
  // the balance forecast and config_guard all make.
  if (sent && sent.ok) {
    await flagsDomain.setFlag(client, ALERTED_FLAG, keys);
    return report({ ...base, notified: true, phone });
  }
  return report({ ...base, notified: false, notifyFailed: true });
}

module.exports = {
  run, dailyRatios, crossings, trendFor, escalate, median, evidence, reportText, briefFor,
  METRICS, BASELINE_DAYS, TREND_RECENT_DAYS, TREND_FACTOR, ALERTED_FLAG, MONEY_KEY,
  SELF_AGENT_ID,
};
