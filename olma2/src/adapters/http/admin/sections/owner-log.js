'use strict';
// owner-log — "מה כתבתי בעצמי": every proactive message the owner wrote by
// hand from a user page, with what Olma actually said and whether the person
// answered. Read back together to find the moments Olma should have noticed on
// her own (domain/owner-messages.js, migration 089).
const { ago } = require('../html');
const { esc } = require('../../html');
const ownerMessages = require('../../../../domain/owner-messages');
const { userLink } = require('./planned');

const LIMIT = 100;

function span(fromTs, toTs) {
  const s = Math.max(0, (new Date(toTs).getTime() - new Date(fromTs).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} דק׳`;
  if (s < 86400) return `${Math.round(s / 3600)} שע׳`;
  return `${Math.round(s / 86400)} ימים`;
}

// What went out. A row whose outbox entry has aged out and was never seen sent
// is unknown — not "never sent".
function sentCell(r) {
  if (r.outbox_hold === 'cancelled_by_admin') return '<span class="dim">בוטל לפני שיצא</span>';
  if (!r.sent_at) {
    return r.outbox_exists && !r.outbox_sent
      ? '<span class="dim">עוד בתור</span>'
      : '<span class="dim">לא ידוע</span>';
  }
  if (r.sent_text) return `<span class="small">${esc(r.sent_text)}</span>`;
  return '<span class="dim small">יצא — הטקסט לא נמצא בתמליל</span>';
}

function replyCell(r, now) {
  if (!r.sent_at) return '<span class="dim">—</span>';
  if (r.replied_at) return `ענה אחרי ${span(r.sent_at, r.replied_at)}`;
  const waited = now.getTime() - new Date(r.sent_at).getTime();
  return waited < 86400000
    ? '<span class="dim">עוד לא</span>'
    : '<span class="dim">לא ענה</span>';
}

async function renderOwnerLogAt(client, { scan, now = new Date() } = {}) {
  await ownerMessages.fillOutcomes(client, { ...(scan ? { scan } : {}), now });
  const rows = await ownerMessages.list(client, LIMIT);
  if (!rows.length) {
    return '<p class="dim">עוד לא נכתבה מכאן אף הודעה. כותבים אחת מדף המשתמש, בתחתית "מה מתוכנן להישלח אליו".</p>';
  }
  const total = rows[0].total;
  return `<table>
    <tr><th>מתי</th><th>למי</th><th>מה ביקשתי</th><th>מה עולמה כתבה בפועל</th><th>ענה?</th></tr>
    ${rows.map((r) => `<tr>
      <td class="dim small nowrap">${ago(r.created_at)}</td>
      <td>${userLink(r)}</td>
      <td>${esc(r.instruction)}${r.urgency === 'urgent' ? ' <span class="dim small">(דחופה)</span>' : ''}</td>
      <td>${sentCell(r)}</td>
      <td class="small nowrap">${replyCell(r, now)}</td>
    </tr>`).join('')}</table>
    ${total > rows.length ? `<p class="dim small">מוצגות ${rows.length} האחרונות מתוך ${total}.</p>` : ''}`;
}

// The SECTIONS signature is positional and owned by the router — nothing is
// appended to it (rules: dashboard-and-domains); tests call renderOwnerLogAt.
async function renderOwnerLog(client) {
  return renderOwnerLogAt(client);
}

module.exports = { renderOwnerLog, renderOwnerLogAt };
