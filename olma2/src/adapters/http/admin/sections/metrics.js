'use strict';
// metrics — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { esc } = require('../../html');

const METRIC_LABELS = {
  active_users: 'משתמשים פעילים', messages_received: 'הודעות שהתקבלו', messages_counted: 'תורות',
  proactive_sent: 'הודעות יזומות', groups_created: 'קבוצות חדשות',
  assistant_messages: 'משפטים של עולמה', hebrew_flaws: 'משפטים עם שגיאת מגדר/סימון',
  tasks_created: 'משימות שנוצרו', reminders_created: 'תזכורות',
  meetings_started: 'פגישות שהתחילו', meetings_confirmed: 'פגישות שסוכמו',
  meetings_no_match: 'פגישות שלא הסתדרו', shares_offered: 'שיתופים שהוצעו',
  shares_accepted: 'שיתופים שהתקבלו', connections_requested: 'בקשות חברות',
  connections_approved: 'חברויות שאושרו', issues_reported: 'תקלות שדווחו',
  users_provisioned: 'משתמשים חדשים',
  facts_remembered: 'עובדות שנשמרו', facts_corrected: 'עובדות שתוקנו',
  preferences_remembered: 'העדפות שנשמרו', preferences_corrected: 'העדפות שתוקנו',
  admin_corrections: 'תיקוני מנהל',
};

const METRIC_ORDER = Object.keys(METRIC_LABELS);

// ---- growth: today against yesterday, this week against last -------------
// The owner's question (2026-09-09) is "are we growing", asked day over day
// and week over week, and a table of daily rows answers it only with a
// calculator. So the top of the section sums each growth metric over six
// windows side by side. `active_users` is the one that cannot be summed —
// twelve people on each of seven days is not eighty-four — so its window
// value is the daily average, and the label says so.
const GROWTH_METRICS = ['messages_received', 'proactive_sent', 'tasks_created', 'reminders_created',
  'users_provisioned', 'groups_created', 'meetings_started', 'meetings_confirmed', 'active_users'];
const WINDOWS = [
  { label: 'היום', from: 0, to: 0 }, { label: 'אתמול', from: 1, to: 1 },
  { label: '7 ימים', from: 0, to: 6 }, { label: '7 שלפניהם', from: 7, to: 13 },
  { label: '30 יום', from: 0, to: 29 }, { label: '30 שלפניהם', from: 30, to: 59 },
];

// Pure: rows of {date, metric, value} → { [metric]: [value per window] }.
// `today` is the UTC date the sweep writes under (jobs/metrics.js), so the
// windows are counted on the same calendar the rows were.
function growthTable(rows, today = new Date().toISOString().slice(0, 10)) {
  const day0 = Date.parse(`${today}T00:00:00Z`);
  const ageOf = (d) => Math.round((day0 - Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`)) / 86400_000);
  const out = {};
  for (const m of GROWTH_METRICS) out[m] = WINDOWS.map(() => 0);
  for (const r of rows) {
    if (!out[r.metric]) continue;
    const age = ageOf(r.date);
    WINDOWS.forEach((w, i) => { if (age >= w.from && age <= w.to) out[r.metric][i] += Number(r.value); });
  }
  // the average, not the sum, for the one metric that is a headcount
  out.active_users = out.active_users.map((v, i) => {
    const days = WINDOWS[i].to - WINDOWS[i].from + 1;
    return days > 1 ? Math.round((v / days) * 10) / 10 : v;
  });
  return out;
}

// The Hebrew count is shown as "flawed of written", never as a rate, and only
// for the days a transcript was actually read — a day with no
// assistant_messages row is a day nobody counted, not a clean one.
function voiceLine(rows, today = new Date().toISOString().slice(0, 10)) {
  const by = new Map();
  for (const r of rows) {
    if (r.metric !== 'assistant_messages' && r.metric !== 'hebrew_flaws') continue;
    const d = String(r.date).slice(0, 10);
    if (!by.has(d)) by.set(d, { assistant_messages: 0, hebrew_flaws: 0 });
    by.get(d)[r.metric] = Number(r.value);
  }
  if (!by.size) return '<p class="dim small">העברית של עולמה עדיין לא נספרה — הספירה מתחילה בשעה הקרובה.</p>';
  const day0 = Date.parse(`${today}T00:00:00Z`);
  const sum = (from, to) => {
    let m = 0, f = 0, days = 0;
    for (const [d, v] of by) {
      const age = Math.round((day0 - Date.parse(`${d}T00:00:00Z`)) / 86400_000);
      if (age < from || age > to) continue;
      m += v.assistant_messages; f += v.hebrew_flaws; days++;
    }
    return { m, f, days };
  };
  const t = sum(0, 0), w = sum(0, 6), pw = sum(7, 13);
  const cell = (x) => x.days ? `${x.f} מתוך ${x.m}` : '—';
  return `<p class="small"><b>העברית של עולמה</b> (משפטים עם התייחסות עצמית בזכר או סימון של המודל, מתוך כל מה שכתבה):
    היום ${cell(t)} · 7 ימים ${cell(w)} · 7 שלפניהם ${cell(pw)}</p>`;
}

async function renderMetrics(client) {
  const { rows } = await client.query(
    `SELECT date, metric, value FROM product_metrics_daily
     WHERE date >= CURRENT_DATE - 60 ORDER BY date DESC, metric`);
  if (!rows.length) return '<p class="dim">עדיין אין נתונים — הסטטיסטיקות מתחשבות כל שעה.</p>';
  const growth = growthTable(rows);
  const growthHtml = `<table><tr><th></th>${WINDOWS.map((w) => `<th>${w.label}</th>`).join('')}</tr>
    ${GROWTH_METRICS.map((m) => `<tr><td class="nowrap">${METRIC_LABELS[m]}${m === 'active_users' ? ' <span class="dim small">(ממוצע ליום)</span>' : ''}</td>${growth[m].map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}
    </table>`;
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.date).slice(0, 10);
    if (Date.now() - Date.parse(`${d}T00:00:00Z`) > 8 * 86400_000) continue;
    if (!byDate.has(d)) byDate.set(d, {});
    byDate.get(d)[r.metric] = Number(r.value);
  }
  const present = METRIC_ORDER.filter((m) => rows.some((r) => r.metric === m && Number(r.value) > 0));
  const cols = present.length ? present : METRIC_ORDER.slice(0, 4);
  const today = byDate.get(new Date().toISOString().slice(0, 10)) || {};
  return `<div class="stats">${cols.slice(0, 5).map((m) =>
      `<div class="stat"><div class="num">${today[m] ?? 0}</div><div class="lbl">${METRIC_LABELS[m]} היום</div></div>`).join('')}</div>
    <h3>צמיחה — יום מול יום, שבוע מול שבוע</h3>
    ${growthHtml}
    ${voiceLine(rows)}
    <h3>יום־יום, השבוע האחרון</h3>
    <table><tr><th>תאריך</th>${cols.map((m) => `<th>${METRIC_LABELS[m] || esc(m)}</th>`).join('')}</tr>
    ${[...byDate.entries()].map(([d, vals]) =>
      `<tr><td class="nowrap">${d}</td>${cols.map((m) => `<td>${vals[m] ?? 0}</td>`).join('')}</tr>`).join('')}</table>`;
}

module.exports = { METRIC_LABELS, METRIC_ORDER, GROWTH_METRICS, WINDOWS, growthTable, voiceLine, renderMetrics };
