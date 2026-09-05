'use strict';
// metrics — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { esc } = require('../../html');

const METRIC_LABELS = {
  active_users: 'משתמשים פעילים', messages_counted: 'הודעות',
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

async function renderMetrics(client) {
  const { rows } = await client.query(
    `SELECT date, metric, value FROM product_metrics_daily
     WHERE date >= CURRENT_DATE - 7 ORDER BY date DESC, metric`);
  if (!rows.length) return '<p class="dim">עדיין אין נתונים — הסטטיסטיקות מתחשבות כל שעה.</p>';
  const byDate = new Map();
  for (const r of rows) {
    const d = String(r.date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, {});
    byDate.get(d)[r.metric] = Number(r.value);
  }
  const present = METRIC_ORDER.filter((m) => rows.some((r) => r.metric === m && Number(r.value) > 0));
  const cols = present.length ? present : METRIC_ORDER.slice(0, 4);
  const today = byDate.get(new Date().toISOString().slice(0, 10)) || {};
  return `<div class="stats">${cols.slice(0, 5).map((m) =>
      `<div class="stat"><div class="num">${today[m] ?? 0}</div><div class="lbl">${METRIC_LABELS[m]} היום</div></div>`).join('')}</div>
    <table><tr><th>תאריך</th>${cols.map((m) => `<th>${METRIC_LABELS[m] || esc(m)}</th>`).join('')}</tr>
    ${[...byDate.entries()].map(([d, vals]) =>
      `<tr><td class="nowrap">${d}</td>${cols.map((m) => `<td>${vals[m] ?? 0}</td>`).join('')}</tr>`).join('')}</table>`;
}

module.exports = { METRIC_LABELS, METRIC_ORDER, renderMetrics };
