'use strict';
// issues — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('../html');
const issuesDomain = require('../../../../domain/issues');
const { esc } = require('../../html');

const CATEGORY_LABEL = { bug: 'תקלה', edge_case: 'מקרה קצה', feature_request: 'בקשת פיצ׳ר', friction: 'חיכוך' };

const SOURCE_LABEL = { user_reported: 'דיווח משתמש', agent_detected: 'זוהה אוטומטית' };

const STATUS_ACTION = { triaged: 'בטיפול', fixed: 'טופל', wontfix: 'לא לטיפול' };

async function renderIssues(client, csrf) {
  const res = await issuesDomain.listIssues(client, { limit: 30 });
  const open = res.data.issues.filter((i) => ['new', 'triaged'].includes(i.status));
  if (!open.length) return '<p class="dim">אין תקלות פתוחות ✓</p>';
  return `<table>
    <tr><th>מה קרה</th><th>סוג</th><th>מקור</th><th>מתי</th><th></th></tr>
    ${open.map((i) => `<tr>
      <td>${esc(i.title)}${i.reporter_first_name ? `<div class="dim small">${esc(i.reporter_first_name)}</div>` : ''}</td>
      <td><span class="pill ${i.category === 'bug' ? 'warn' : ''}">${CATEGORY_LABEL[i.category] || esc(i.category)}</span></td>
      <td class="dim small">${SOURCE_LABEL[i.source] || esc(i.source)}</td>
      <td class="dim small nowrap">${ago(i.created_at)}</td>
      <td class="nowrap"><form method="post" action="/issues/status" class="inline">
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#issues"><input type="hidden" name="id" value="${i.id}">
        <select name="status">${Object.entries(STATUS_ACTION).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button>עדכן</button></form></td></tr>`).join('')}</table>`;
}

module.exports = { CATEGORY_LABEL, SOURCE_LABEL, STATUS_ACTION, renderIssues };
