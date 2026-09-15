'use strict';
// The admin home page: the handful of numbers the owner reads first, each over
// four calendar periods — since the project started, this month, this week,
// today. Everything else on the admin lives on its own menu page (/g/<group>).
//
// Periods are CALENDAR periods in Israel time, the week starting Sunday — not
// the rolling UTC windows of the "שימוש במוצר" section, which answer a
// different question. The eval user is excluded from every count of people
// and activity, and included in money, because its model calls cost money.
//
// `homeMetrics` returns plain numbers and `renderHome` turns them into HTML,
// so the tests assert on the counts rather than on markup.
const infraCost = require('../../infra-cost');
const flagsDomain = require('../../../domain/flags');
const pricing = require('../../../domain/model-pricing');
const { GOOGLE_FAMILY_PROVIDERS } = require('../../../domain/google-family');
const { esc } = require('../html');
const { fmt } = require('./html');

const TZ = 'Asia/Jerusalem';
const WEEKS = 8;

// Same per-minute estimates as the cost section: Twilio reports its own price
// per call, the speech and model legs of a call have no per-call bill.
const EST_VOICE_PER_MIN = 0.0039 + 0.027 + 0.006;

// $1 now, $2 start of today, $3 start of this week, $4 start of this month.
const periodCounts = (ts, cond = 'true') => `
  count(*) FILTER (WHERE ${cond} AND ${ts} <= $1)::int AS total,
  count(*) FILTER (WHERE ${cond} AND ${ts} >= $4 AND ${ts} <= $1)::int AS month,
  count(*) FILTER (WHERE ${cond} AND ${ts} >= $3 AND ${ts} <= $1)::int AS week,
  count(*) FILTER (WHERE ${cond} AND ${ts} >= $2 AND ${ts} <= $1)::int AS day`;

const periodSums = (ts, expr) => `
  COALESCE(sum(${expr}) FILTER (WHERE ${ts} <= $1), 0)::float AS total,
  COALESCE(sum(${expr}) FILTER (WHERE ${ts} >= $4 AND ${ts} <= $1), 0)::float AS month,
  COALESCE(sum(${expr}) FILTER (WHERE ${ts} >= $3 AND ${ts} <= $1), 0)::float AS week,
  COALESCE(sum(${expr}) FILTER (WHERE ${ts} >= $2 AND ${ts} <= $1), 0)::float AS day`;

const pick = (r) => ({ total: Number(r.total), month: Number(r.month), week: Number(r.week), day: Number(r.day) });

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function periodBounds(client, now) {
  const { rows } = await client.query(
    `WITH n AS (SELECT $1::timestamptz AS now, ($1::timestamptz AT TIME ZONE '${TZ}') AS l)
     SELECT now,
            date_trunc('day', l) AT TIME ZONE '${TZ}' AS day_start,
            (date_trunc('week', l + interval '1 day') - interval '1 day') AT TIME ZONE '${TZ}' AS week_start,
            date_trunc('month', l) AT TIME ZONE '${TZ}' AS month_start,
            to_char(l, 'YYYY-MM-DD') AS today,
            to_char(date_trunc('week', l + interval '1 day') - interval '1 day', 'YYYY-MM-DD') AS week_day,
            to_char(date_trunc('month', l), 'YYYY-MM-DD') AS month_day
       FROM n`, [now]);
  const r = rows[0];
  return {
    now: r.now, dayStart: r.day_start, weekStart: r.week_start, monthStart: r.month_start,
    today: r.today, weekDay: r.week_day, monthDay: r.month_day,
  };
}

// Every local calendar day from `from` to `to`, both inclusive, as YYYY-MM-DD.
function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) { out.push(isoDay(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

const daysInMonth = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};

// A monthly bill spread evenly over the days of its month, summed per period.
// `perDay(day)` is the day's share in USD, or 0 for a day the bill did not
// exist yet. `null` from a provider means "could not read", and is returned as
// null rather than 0 so the page can say which part is missing.
function prorate(bounds, perDay, since = infraCost.PROJECT_START) {
  const start = isoDay(new Date(since));
  const sum = (from) => daysBetween(from < start ? start : from, bounds.today)
    .reduce((s, day) => s + perDay(day), 0);
  return { total: sum(start), month: sum(bounds.monthDay), week: sum(bounds.weekDay), day: sum(bounds.today) };
}

function fixedCosts(bounds, infra, overrides = {}) {
  const missing = [];
  const parts = [];
  const readable = (s) => s && s.configured && !s.error;

  parts.push(prorate(bounds, (day) =>
    infraCost.subscriptionCost(new Date(`${day}T12:00:00Z`), overrides).rate / daysInMonth(day)));

  const eleven = infra && infra.elevenlabs;
  if (readable(eleven)) {
    parts.push(prorate(bounds, (day) => Number(eleven.monthlyUsd || 0) / daysInMonth(day), infraCost.ELEVENLABS_START));
  } else if (eleven && eleven.configured) missing.push('ElevenLabs');

  // DigitalOcean reports what was invoiced and what has accrued this month,
  // never a price per day — so the month's accrual over the days elapsed is
  // the daily rate, and the project total stays the real invoiced figure.
  const dO = infra && infra.digitalocean;
  if (readable(dO)) {
    const elapsed = Number(bounds.today.slice(8, 10));
    const accrued = Number(dO.accrued || 0);
    const daily = accrued / elapsed;
    parts.push({
      total: Number(dO.paid || 0) + accrued,
      month: accrued,
      week: daily * daysBetween(bounds.weekDay, bounds.today).length,
      day: daily,
    });
  } else if (dO && dO.configured) missing.push('DigitalOcean');

  const sum = { total: 0, month: 0, week: 0, day: 0 };
  for (const p of parts) for (const k of Object.keys(sum)) sum[k] += p[k];
  return { ...sum, missing };
}

async function usageCosts(client, bounds) {
  const params = [bounds.today, bounds.monthDay, bounds.weekDay];
  const ledger = await client.query(
    `SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
       FROM usage_ledger WHERE date <= $1::date
     UNION ALL
     SELECT date, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd
       FROM usage_system_ledger WHERE date <= $1::date`, [bounds.today]);
  const blended = await pricing.blendedRate(client);
  const model = { total: 0, month: 0, week: 0, day: 0 };
  for (const r of ledger.rows) {
    const p = pricing.priceUsage({
      input: r.input_tokens, output: r.output_tokens,
      cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens,
    }, r.model, blended);
    const cost = p.estimated ? Number(r.cost_usd) : p.cost;
    const day = isoDay(r.date);
    model.total += cost;
    if (day >= params[1]) model.month += cost;
    if (day >= params[2]) model.week += cost;
    if (day === params[0]) model.day += cost;
  }

  const media = await client.query(
    `SELECT COALESCE(sum(cost_usd), 0)::float AS total,
            COALESCE(sum(cost_usd) FILTER (WHERE date >= $2::date), 0)::float AS month,
            COALESCE(sum(cost_usd) FILTER (WHERE date >= $3::date), 0)::float AS week,
            COALESCE(sum(cost_usd) FILTER (WHERE date = $1::date), 0)::float AS day
       FROM media_usage_ledger WHERE date <= $1::date`, params);

  const voice = await client.query(
    `SELECT ${periodSums('started_at', `COALESCE(twilio_usd, 0) + duration_sec / 60.0 * ${EST_VOICE_PER_MIN}`)}
       FROM voice_usage_ledger WHERE duration_sec > 0`,
    [bounds.now, bounds.dayStart, bounds.weekStart, bounds.monthStart]);

  return { model, media: pick(media.rows[0]), voice: pick(voice.rows[0]) };
}

async function homeMetrics(client, { now = new Date(), infra = null } = {}) {
  const b = await periodBounds(client, now);
  const p = [b.now, b.dayStart, b.weekStart, b.monthStart];
  const q = async (sql) => (await client.query(sql, p)).rows[0];

  const users = pick(await q(
    `SELECT ${periodCounts('created_at')} FROM users WHERE NOT is_eval`));

  const active = await client.query(
    `SELECT count(DISTINCT a.actor_id) FILTER (WHERE a.created_at > $1::timestamptz - interval '1 day')::int AS d1,
            count(DISTINCT a.actor_id) FILTER (WHERE a.created_at > $1::timestamptz - interval '7 days')::int AS d7,
            count(DISTINCT a.actor_id)::int AS d30
       FROM audit_log a JOIN users u ON u.id = a.actor_id
      WHERE a.event = 'message.received' AND NOT u.is_eval
        AND a.created_at > $1::timestamptz - interval '30 days' AND a.created_at <= $1`, [b.now]);

  const callsRow = await q(
    `SELECT ${periodCounts('v.started_at')},
            ${periodSums('v.started_at', 'v.duration_sec').replace(/AS (total|month|week|day)/g, 'AS sec_$1')}
       FROM voice_usage_ledger v LEFT JOIN users u ON u.id = v.user_id
      WHERE v.duration_sec > 0 AND NOT COALESCE(u.is_eval, false)`);
  const seconds = {
    total: Number(callsRow.sec_total), month: Number(callsRow.sec_month),
    week: Number(callsRow.sec_week), day: Number(callsRow.sec_day),
  };

  const groups = pick(await q(`SELECT ${periodCounts('created_at')} FROM chat_groups`));

  const googleRow = await client.query(
    `WITH first AS (
       SELECT i.user_id, min(COALESCE(i.connected_at, i.created_at)) AS at
         FROM integrations i JOIN users u ON u.id = i.user_id
        WHERE i.provider = ANY($5) AND i.status = 'connected' AND NOT u.is_eval
        GROUP BY i.user_id)
     SELECT ${periodCounts('at')} FROM first`, [...p, GOOGLE_FAMILY_PROVIDERS]);
  const google = pick(googleRow.rows[0]);

  const meetingsRow = await q(
    `SELECT ${periodCounts('m.created_at')},
            ${periodCounts('m.created_at', 'm.group_id IS NOT NULL').replace(/AS (total|month|week|day)/g, 'AS g_$1')}
       FROM meetings m JOIN users u ON u.id = m.initiator_id WHERE NOT u.is_eval`);
  const meetings = pick(meetingsRow);
  const groupMeetings = {
    total: meetingsRow.g_total, month: meetingsRow.g_month, week: meetingsRow.g_week, day: meetingsRow.g_day,
  };

  // Money. The fixed bills come from the billing APIs through the same
  // 10-minute cache as the cost section; a test injects them.
  let infraData = infra;
  if (!infraData) infraData = await infraCost.getInfraCosts().catch(() => null);
  let overrides = {};
  try { overrides = (await flagsDomain.getFlag(client, 'claude_subscription_overrides')) || {}; } catch { /* standing rate */ }
  const usage = await usageCosts(client, b);
  const fixed = fixedCosts(b, infraData, overrides);
  const money = {};
  for (const k of ['total', 'month', 'week', 'day']) {
    money[k] = usage.model[k] + usage.media[k] + usage.voice[k] + fixed[k];
  }

  return {
    bounds: b,
    users, activeUsers: active.rows[0], calls: pick(callsRow), seconds, groups, google,
    meetings, groupMeetings,
    money: { ...money, parts: { model: usage.model, media: usage.media, voice: usage.voice, fixed }, missing: fixed.missing },
    meetingFocus: await meetingFocus(client, b),
    groupFocus: await groupFocus(client, b),
  };
}

const weekKey = (col) =>
  `to_char(date_trunc('week', (${col} AT TIME ZONE '${TZ}') + interval '1 day') - interval '1 day', 'YYYY-MM-DD')`;

function weekList(bounds) {
  const out = [];
  const d = new Date(`${bounds.weekDay}T00:00:00Z`);
  for (let i = WEEKS - 1; i >= 0; i--) {
    const w = new Date(d); w.setUTCDate(w.getUTCDate() - 7 * i);
    out.push(isoDay(w));
  }
  return out;
}

async function meetingFocus(client, b) {
  const status = await client.query(
    `SELECT (m.group_id IS NOT NULL) AS in_group, m.status, count(*)::int AS n
       FROM meetings m JOIN users u ON u.id = m.initiator_id
      WHERE NOT u.is_eval AND m.created_at <= $1
      GROUP BY 1, 2`, [b.now]);
  const byStatus = { all: {}, group: {}, direct: {} };
  for (const r of status.rows) {
    for (const bucket of ['all', r.in_group ? 'group' : 'direct']) {
      byStatus[bucket][r.status] = (byStatus[bucket][r.status] || 0) + r.n;
    }
  }
  const median = await client.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM m.closed_at - m.created_at))::float AS sec
       FROM meetings m JOIN users u ON u.id = m.initiator_id
      WHERE NOT u.is_eval AND m.status = 'confirmed' AND m.closed_at IS NOT NULL AND m.created_at <= $1`, [b.now]);
  const weeks = weekList(b);
  const weekly = await client.query(
    `SELECT ${weekKey('m.created_at')} AS wk,
            count(*)::int AS started,
            count(*) FILTER (WHERE m.status = 'confirmed')::int AS confirmed,
            count(*) FILTER (WHERE m.group_id IS NOT NULL)::int AS in_group
       FROM meetings m JOIN users u ON u.id = m.initiator_id
      WHERE NOT u.is_eval AND m.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND m.created_at <= $1
      GROUP BY 1`, [b.now, weeks[0]]);
  const map = new Map(weekly.rows.map((r) => [r.wk, r]));
  return {
    byStatus,
    medianConfirmSec: median.rows[0].sec === null ? null : Number(median.rows[0].sec),
    weekly: weeks.map((wk) => ({
      week: wk,
      started: map.get(wk)?.started || 0,
      confirmed: map.get(wk)?.confirmed || 0,
      inGroup: map.get(wk)?.in_group || 0,
    })),
  };
}

async function groupFocus(client, b) {
  const states = await client.query(
    `SELECT state, count(*)::int AS n FROM chat_groups WHERE created_at <= $1 GROUP BY state`, [b.now]);
  const kinds = await client.query(
    `SELECT COALESCE(kind, 'unknown') AS kind, count(*)::int AS n
       FROM chat_groups WHERE created_at <= $1 AND state <> 'retired' GROUP BY 1`, [b.now]);
  const outbox = await client.query(
    `SELECT CASE WHEN kind = 'coordination' THEN COALESCE(payload->'line'->>'kind', 'coordination') ELSE kind END AS kind,
            count(*) FILTER (WHERE sent_at IS NOT NULL AND hold_reason IS NULL)::int AS sent,
            count(*) FILTER (WHERE hold_reason IS NOT NULL)::int AS held,
            count(*) FILTER (WHERE sent_at IS NULL)::int AS pending
       FROM group_outbox WHERE created_at <= $1 GROUP BY 1`, [b.now]);
  const members = await client.query(
    `SELECT count(*)::int AS n FROM chat_group_members gm JOIN chat_groups g ON g.id = gm.group_id
      WHERE gm.left_at IS NULL AND g.state <> 'retired'`);
  const weeks = weekList(b);
  const weekly = await client.query(
    `SELECT ${weekKey('g.created_at')} AS wk, count(*)::int AS n
       FROM chat_groups g
      WHERE g.created_at >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND g.created_at <= $1
      GROUP BY 1`, [b.now, weeks[0]]);
  const map = new Map(weekly.rows.map((r) => [r.wk, r.n]));
  return {
    states: Object.fromEntries(states.rows.map((r) => [r.state, r.n])),
    kinds: Object.fromEntries(kinds.rows.map((r) => [r.kind, r.n])),
    outbox: Object.fromEntries(outbox.rows.map((r) => [r.kind, { sent: r.sent, held: r.held, pending: r.pending }])),
    members: members.rows[0].n,
    weeklyNewGroups: weeks.map((wk) => ({ week: wk, n: map.get(wk) || 0 })),
  };
}

// ---- render ----------------------------------------------------------------

function duration(sec) {
  const s = Math.round(Number(sec) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function humanDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} דק׳`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} שע׳`;
  return `${(sec / 86400).toFixed(1)} ימים`;
}

function makeShekel(rate) {
  return (usd) => {
    const n = Number(usd) || 0;
    if (!rate) return { main: `$${n.toFixed(2)}`, sub: '' };
    return { main: `₪${Math.round(n * rate).toLocaleString('en-US')}`, sub: `$${n.toFixed(2)}` };
  };
}

const PERIOD_LABELS = [['month', 'החודש'], ['week', 'השבוע'], ['day', 'היום']];

function kpi({ id, label, value, sub = '', periods, periodFmt = fmt, note = '', tone = '' }) {
  return `<div class="kpi ${tone}" id="kpi-${id}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    <div class="kpi-periods">${periods.map(([k, l, v]) =>
      `<div class="kpi-period" data-period="${k}"><span class="kpi-p-num">${v === undefined ? '—' : periodFmt(v)}</span><span class="kpi-p-lbl">${l}</span></div>`).join('')}</div>
    ${note ? `<div class="kpi-note">${note}</div>` : ''}
  </div>`;
}

const withPeriods = (obj, fmtFn = (x) => x) => PERIOD_LABELS.map(([k, l]) => [k, l, fmtFn(obj[k])]);

function bars(rows, series) {
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key])));
  const shortDate = (d) => `${Number(d.slice(8, 10))}/${Number(d.slice(5, 7))}`;
  return `<div class="bars" role="img">
    ${rows.map((r) => `<div class="bar-col" title="שבוע ${shortDate(r.week)}">
      <div class="bar-stack">${series.map((s) =>
        `<div class="bar ${s.cls}" style="height:${Math.round((r[s.key] / max) * 100)}%"><span>${r[s.key] || ''}</span></div>`).join('')}</div>
      <div class="bar-lbl">${shortDate(r.week)}</div></div>`).join('')}
  </div>
  <div class="legend">${series.map((s) => `<span><i class="${s.cls}"></i>${s.label}</span>`).join('')}</div>`;
}

function funnelRow(label, n, of, cls) {
  const pct = of ? Math.round((n / of) * 100) : 0;
  return `<div class="funnel-row"><div class="funnel-lbl">${label}</div>
    <div class="funnel-track"><div class="funnel-fill ${cls}" style="width:${pct}%"></div></div>
    <div class="funnel-num">${fmt(n)}</div></div>`;
}

const MEETING_STATUSES = [
  ['negotiating', 'בתיאום עכשיו', 'accent'],
  ['confirmed', 'נקבעו', 'ok'],
  ['no_match', 'לא נמצא זמן', 'warn'],
  ['cancelled', 'בוטלו', 'muted'],
  ['expired', 'פג תוקף', 'muted'],
];

function meetingPanel(f) {
  const total = (s) => Object.values(s).reduce((a, b) => a + b, 0);
  const all = f.byStatus.all;
  const closed = (all.confirmed || 0) + (all.no_match || 0) + (all.cancelled || 0) + (all.expired || 0);
  const rate = closed ? `${Math.round(((all.confirmed || 0) / closed) * 100)}%` : '—';
  const split = (s) => `${fmt(total(s))} <span class="dim small">(${fmt(s.confirmed || 0)} נקבעו)</span>`;
  return `<section class="panel" id="focus-meetings">
    <div class="panel-head"><h3>תיאומי פגישות</h3>
      <p class="hint">כל תיאום שנפתח, איפה הוא עומד היום, וכמה נפתחו ונקבעו בכל שבוע (שבוע מתחיל ביום ראשון).</p></div>
    <div class="mini-stats">
      <div><b>${rate}</b><span>נקבעו מתוך ${fmt(closed)} שנסגרו</span></div>
      <div><b>${humanDuration(f.medianConfirmSec)}</b><span>זמן חציוני עד שנקבע</span></div>
      <div><b>${split(f.byStatus.direct)}</b><span>בפרטי</span></div>
      <div><b>${split(f.byStatus.group)}</b><span>בקבוצות</span></div>
    </div>
    <h4>איפה כל התיאומים עומדים</h4>
    <div class="funnel">${MEETING_STATUSES.map(([k, l, c]) => funnelRow(l, all[k] || 0, total(all), c)).join('')}</div>
    <h4>לפי שבוע — ${WEEKS} שבועות אחרונים</h4>
    ${bars(f.weekly, [
      { key: 'started', label: 'נפתחו', cls: 'accent' },
      { key: 'confirmed', label: 'נקבעו', cls: 'ok' },
      { key: 'inGroup', label: 'מתוכם בקבוצה', cls: 'gold' },
    ])}
  </section>`;
}

const GROUP_STATES = [
  ['open', 'פתוחות', 'ok'],
  ['locked', 'נעולות (מחכות שכולם יכתבו לה)', 'warn'],
  ['too_large', 'גדולות מדי', 'muted'],
  ['retired', 'הוצאו משימוש', 'muted'],
];

const GROUP_LINES = [
  ['intro', 'היכרות בכניסה לקבוצה'],
  ['opened', 'הודעת "הקבוצה נפתחה"'],
  ['base', 'פתיחת תיאום'],
  ['chase', 'תזכורת למי שלא ענה'],
  ['done', 'נקבע'],
  ['dayof', 'ביום הפגישה'],
  ['soon', 'לפני הפגישה'],
];

function groupPanel(f, groupMeetings) {
  const total = Object.values(f.states).reduce((a, b) => a + b, 0);
  const statusAll = f.byStatusGroup || {};
  const sentRows = GROUP_LINES.map(([k, l]) => {
    const r = f.outbox[k] || { sent: 0, held: 0, pending: 0 };
    return `<tr><td>${l}</td><td>${fmt(r.sent)}</td><td class="${r.held ? 'warn' : 'dim'}">${fmt(r.held)}</td><td class="dim">${fmt(r.pending)}</td></tr>`;
  }).join('');
  const kindLabel = { social: 'חברתית', game: 'משחק / מניין', unknown: 'לא ידוע' };
  return `<section class="panel" id="focus-groups">
    <div class="panel-head"><h3>ניהול תיאום בקבוצות וואטסאפ</h3>
      <p class="hint">הקבוצות שעולמה יושבת בהן, התיאומים שנפתחו בתוכן, ומה היא אמרה בחדר. "עוכבה" = הודעה שלא נשלחה ולא תנוסה שוב.</p></div>
    <div class="mini-stats">
      <div><b>${fmt(total)}</b><span>קבוצות בסה״כ</span></div>
      <div><b>${fmt(f.members)}</b><span>חברים בקבוצות פעילות</span></div>
      <div><b>${fmt(groupMeetings.total)}</b><span>תיאומים בקבוצות</span></div>
      <div><b>${fmt(statusAll.negotiating || 0)}</b><span>בתיאום עכשיו</span></div>
    </div>
    <h4>מצב הקבוצות</h4>
    <div class="funnel">${GROUP_STATES.map(([k, l, c]) => funnelRow(l, f.states[k] || 0, total, c)).join('')}</div>
    <p class="dim small">סוג: ${Object.entries(f.kinds).map(([k, n]) => `${kindLabel[k] || esc(k)} ${fmt(n)}`).join(' · ') || '—'}</p>
    <h4>מה נאמר בקבוצות</h4>
    <table class="compact"><tr><th>הודעה</th><th>נשלחו</th><th>עוכבו</th><th>בתור</th></tr>${sentRows}</table>
    <h4>קבוצות חדשות לפי שבוע</h4>
    ${bars(f.weeklyNewGroups, [{ key: 'n', label: 'קבוצות חדשות', cls: 'accent' }])}
  </section>`;
}

function renderHome(m, { alertsHtml = '', fx = null } = {}) {
  const money = makeShekel(fx);
  const moneyMain = money(m.money.total);
  const moneyNote = [
    `מודל ${money(m.money.parts.model.month).main}`,
    `מדיה ${money(m.money.parts.media.month).main}`,
    `שיחות ${money(m.money.parts.voice.month).main}`,
    `קבועות ${money(m.money.parts.fixed.month).main}`,
  ].join(' · ');
  const missing = m.money.missing.length
    ? `<div class="kpi-warn">לא נקרא: ${m.money.missing.map(esc).join(', ')} — לא נכלל בסכום</div>` : '';

  const kpis = [
    kpi({ id: 'users', label: 'משתמשים', value: fmt(m.users.total), sub: 'בלי משתמש הבדיקות',
      periods: withPeriods(m.users).map(([k, l, v]) => [k, `חדשים ${l}`, v]) }),
    kpi({ id: 'active', label: 'משתמשים פעילים', value: fmt(m.activeUsers.d7), sub: 'שלחו הודעה ב-7 ימים אחרונים',
      periods: [['d1', '24 שעות', m.activeUsers.d1], ['d7', '7 ימים', m.activeUsers.d7], ['d30', '30 ימים', m.activeUsers.d30]] }),
    kpi({ id: 'meetings', label: 'תיאומי פגישות', value: fmt(m.meetings.total), sub: `${fmt(m.groupMeetings.total)} מהם בקבוצות`,
      periods: withPeriods(m.meetings), tone: 'focus' }),
    kpi({ id: 'groups', label: 'קבוצות וואטסאפ', value: fmt(m.groups.total), sub: 'מתחילת הפרויקט',
      periods: withPeriods(m.groups), tone: 'focus' }),
    kpi({ id: 'calls', label: 'שיחות טלפון', value: fmt(m.calls.total), sub: 'מתחילת הפרויקט',
      periods: withPeriods(m.calls) }),
    kpi({ id: 'seconds', label: 'שניות בשיחות', value: fmt(Math.round(m.seconds.total)), sub: duration(m.seconds.total),
      periods: withPeriods(m.seconds, Math.round) }),
    kpi({ id: 'google', label: 'מחוברים לגוגל', value: fmt(m.google.total), sub: 'יומן, אנשי קשר או ג׳ימייל',
      periods: withPeriods(m.google).map(([k, l, v]) => [k, `חדשים ${l}`, v]) }),
    kpi({ id: 'money', label: 'כסף שהוצא', value: moneyMain.main, sub: moneyMain.sub ? `${moneyMain.sub} · מתחילת הפרויקט` : 'מתחילת הפרויקט',
      periods: withPeriods(m.money), periodFmt: (v) => money(v).main, note: `החודש: ${moneyNote}${missing}` }),
  ].join('');

  const statusGroup = m.meetingFocus.byStatus.group;
  return `<div class="home">
    <div class="home-head">
      <div><h2>בית</h2><p class="dim">נכון ל-${esc(m.bounds.today.split('-').reverse().join('/'))} · שעון ישראל · השבוע מתחיל ביום ראשון</p></div>
      ${alertsHtml}
    </div>
    <div class="kpi-grid">${kpis}</div>
    <div class="focus-grid">
      ${meetingPanel(m.meetingFocus)}
      ${groupPanel({ ...m.groupFocus, byStatusGroup: statusGroup }, m.groupMeetings)}
    </div>
    <p class="dim small home-foot">כסף: מודל לפי טבלת התעריפים של היום, תמונות ווידאו לפי OpenRouter, שיחות לפי Twilio ועוד הערכה לדקה,
      וחיובים חודשיים (מנוי Claude, השרת, ElevenLabs) מחולקים שווה בין ימי החודש. הערכה, לא חשבונית — הפירוט בעמוד העלויות.</p>
  </div>`;
}

module.exports = { homeMetrics, renderHome, fixedCosts, prorate, periodBounds, duration, TZ };
