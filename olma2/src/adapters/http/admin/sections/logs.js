'use strict';
// logs — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { esc } = require('../../html');

async function renderWaitlist(client) {
  const { rows } = await client.query(`SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 50`);
  if (!rows.length) return '<p class="dim">ריק.</p>';
  return `<table><tr><th>טלפון</th><th>הצטרף</th><th>עודכן על פתיחה</th></tr>
    ${rows.map((w) => `<tr><td>${esc(w.phone)}</td><td>${esc(String(w.created_at).slice(0, 16))}</td>
      <td>${w.notified_at ? '✓' : '—'}</td></tr>`).join('')}</table>`;
}

async function renderAudit(client) {
  const { rows } = await client.query(
    `SELECT a.created_at, a.event, u.first_name, u.phone, a.detail
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT 40`);
  return `<table><tr><th>מתי</th><th>מי</th><th>אירוע</th><th>פרטים</th></tr>
    ${rows.map((r) => `<tr><td>${esc(String(r.created_at).slice(5, 16))}</td>
      <td>${esc(r.first_name || r.phone || 'system')}</td><td>${esc(r.event)}</td>
      <td class="dim">${esc(JSON.stringify(r.detail || {}).slice(0, 90))}</td></tr>`).join('')}</table>`;
}

module.exports = { renderWaitlist, renderAudit };
