'use strict';
// The weekly growth report (owner, 2026-09-30 — the goal is 100 weekly active
// users, then stop). Once a week, Sunday morning in the owner's clock, one
// message on the raw pipe: where weekly active users stand against the goal
// and against last week, who joined by which door, the invite-link clicks,
// and where each A/B test stands. No model in the path.
//
// Everything here is READ from what already exists — `product_metrics_daily`
// (jobs/metrics.js, the same rows the admin page's goal block reads) and
// experiments.results — so the message and the page cannot disagree. The
// stamp (`growth_report_week`, the Sunday it was for) is written only after
// the send confirms, like every other admin message: a failed pipe is retried
// on the next hourly tick, never swallowed.
const flagsDomain = require('../domain/flags');
const experiments = require('../domain/experiments');
const { ALERT_PHONE_FLAG, DEFAULT_ALERT_PHONE } = require('./credit-watch');
const { JOIN_CHANNELS } = require('./metrics');

const SENT_FLAG = 'growth_report_week';
const WAU_GOAL = 100;
const SEND_DAY = 0; // Sunday: the owner's week starts on it (admin/home.js)
const SEND_HOUR = 9;
const LAST_HOUR = 22;
const TZ = 'Asia/Jerusalem';
const CHANNEL_LABELS = { friend_link: 'קישור מחבר', room: 'קבוצה', invite: 'הזמנה אישית', direct: 'ישירות' };
const VERDICT = { early: 'עוד מוקדם', no_difference: 'אין הבדל ברור', a: 'A מובילה', b: 'B מובילה' };

// The owner's local date, weekday and hour at `now`, through Intl so a DST
// change cannot move it.
function localParts(now, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: days[p.weekday], hour: Number(p.hour) };
}

// The numbers, as of `date` (the owner's local date). WAU is a rolling
// headcount, so it is READ on a day — the latest one on or before `date` —
// never summed; joins and clicks are daily counts and sum over the seven days
// that end on it.
async function gather(client, date) {
  const { rows: [w] } = await client.query(
    `SELECT date::text AS d, value::int AS v FROM product_metrics_daily
      WHERE metric = 'weekly_active_users' AND date <= $1::date ORDER BY date DESC LIMIT 1`, [date]);
  if (!w) return null;
  const { rows: [prev] } = await client.query(
    `SELECT value::int AS v FROM product_metrics_daily
      WHERE metric = 'weekly_active_users' AND date = $1::date - 7`, [w.d]);
  const { rows } = await client.query(
    `SELECT metric, sum(value)::int AS n FROM product_metrics_daily
      WHERE (metric LIKE 'joined\\_%' OR metric = 'referral_clicks')
        AND date BETWEEN $1::date - 6 AND $1::date
      GROUP BY metric`, [w.d]);
  const sums = Object.fromEntries(rows.map((r) => [r.metric, r.n]));
  const { rows: room } = await client.query(
    `SELECT metric, value::int AS v FROM product_metrics_daily
      WHERE date = $1::date AND metric IN ('room_people', 'room_people_met', 'room_people_active')`, [w.d]);
  const r = Object.fromEntries(room.map((x) => [x.metric, x.v]));
  const tests = [];
  for (const key of Object.keys(experiments.EXPERIMENTS)) tests.push(await experiments.results(client, key));
  return {
    asOf: w.d, wau: w.v, lastWeek: prev ? prev.v : null,
    joined: Object.fromEntries(JOIN_CHANNELS.map((c) => [c, sums[`joined_${c}`] ?? null])),
    clicks: sums.referral_clicks ?? null,
    rooms: r.room_people === undefined ? null
      : { people: r.room_people, met: r.room_people_met ?? null, active: r.room_people_active ?? null },
    tests,
  };
}

const n = (v) => (v === null || v === undefined ? '—' : String(v));

function reportText(d) {
  const delta = d.lastWeek === null ? '' : ` (לפני שבוע: ${d.lastWeek})`;
  const joinedTotal = JOIN_CHANNELS.reduce((s, c) => s + (d.joined[c] || 0), 0);
  const lines = [
    '📈 עולמה — השבוע במספרים',
    `פעילים בשבוע: *${d.wau} מתוך ${WAU_GOAL}*${delta}`,
    `הצטרפו השבוע: ${joinedTotal} — ${JOIN_CHANNELS.map((c) => `${CHANNEL_LABELS[c]} ${n(d.joined[c])}`).join(' · ')}`,
    `לחיצות על קישורי הזמנה: ${n(d.clicks)}`,
  ];
  if (d.rooms) lines.push(`בקבוצות עם עולמה: ${d.rooms.people} אנשים — ${n(d.rooms.met)} כבר אצלה, ${n(d.rooms.active)} פעילים השבוע`);
  if (d.tests.length) {
    lines.push('', 'ניסויים:');
    for (const t of d.tests) {
      const arms = t.arms.map((a) => `${a.variant.toUpperCase()} ${a.converted}/${a.done}`).join(' · ');
      const state = t.locked ? `נקבעה ${t.locked.toUpperCase()}` : VERDICT[t.verdict.call];
      lines.push(`• ${t.title}: ${arms} — ${state}`);
    }
    lines.push('(הצליחו / מי שחלון המדידה שלהם נסגר. הפירוט והכפתור לקבע גרסה — בדף הניהול, "ניסויי A/B".)');
  }
  return lines.join('\n');
}

// deps: { send(phone, text) -> { ok }, now }
async function run(client, deps = {}) {
  const now = deps.now || new Date();
  const local = localParts(now);
  if (local.weekday !== SEND_DAY || local.hour < SEND_HOUR || local.hour >= LAST_HOUR) {
    return { sent: false, reason: 'not the hour' };
  }
  if ((await flagsDomain.getFlag(client, SENT_FLAG)) === local.date) return { sent: false, reason: 'already sent' };
  if (!deps.send) return { sent: false, reason: 'no admin pipe' };
  const data = await gather(client, local.date);
  // No metrics row at all is a sweep that has not run, not a week of zeroes.
  if (!data) return { sent: false, reason: 'no metrics yet' };
  const phone = (await flagsDomain.getFlag(client, ALERT_PHONE_FLAG)) || DEFAULT_ALERT_PHONE;
  let res = null;
  try { res = await deps.send(phone, reportText(data)); } catch { res = null; }
  if (!(res && res.ok)) return { sent: false, notifyFailed: true };
  await flagsDomain.setFlag(client, SENT_FLAG, local.date);
  return { sent: true, week: local.date, wau: data.wau };
}

module.exports = { run, gather, reportText, localParts, SENT_FLAG, WAU_GOAL };
