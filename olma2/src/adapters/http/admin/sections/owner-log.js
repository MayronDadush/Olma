'use strict';
// owner-log — "מה כתבתי בעצמי": every proactive message the owner wrote by
// hand from a user page, with what Olma actually said and whether the person
// answered, plus what each one taught and the feature it might become.
// Collected here until the owner decides to go through it (2026-09-25);
// nothing is built off it on its own (domain/owner-messages.js, migration 089).
const { ago } = require('../html');
const { esc } = require('../../html');
const ownerMessages = require('../../../../domain/owner-messages');
const { userLink } = require('./planned');

const LIMIT = 100;

const STATUS_LABELS = { open: 'פתוח', building: 'בבנייה', built: 'נבנה', dropped: 'נזנח' };

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

const hidden = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf || '')}">
  <input type="hidden" name="back" value="/#owner-log">`;

function statusSelect(current) {
  return `<select name="status">${ownerMessages.IDEA_STATUSES.map((s) =>
    `<option value="${s}"${s === current ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select>`;
}

function ideasHtml(ideas, csrf) {
  const rows = ideas.map((f) => `<tr>
    <td colspan="3"><form method="post" action="/owner-log/idea">${hidden(csrf)}
      <input type="hidden" name="id" value="${f.id}">
      <p><input name="title" value="${esc(f.title)}" style="width:100%"></p>
      <p><textarea name="detail" rows="2" style="width:100%" placeholder="מה ראינו, ומה הפיצ'ר היה עושה">${esc(f.detail || '')}</textarea></p>
      <p class="small">${statusSelect(f.status)}
        <span class="dim">${f.evidence} הודעות מאחוריו</span>
        <button>שמור</button></p>
    </form></td></tr>`).join('');
  return `<h4>פיצ'רים אפשריים</h4>
    ${ideas.length ? `<table>${rows}</table>` : '<p class="dim">עוד אין. רעיון נולד כאן, ואז משייכים אליו הודעות מהיומן שלמטה.</p>'}
    <form method="post" action="/owner-log/idea">${hidden(csrf)}
      <p class="small"><input name="title" placeholder="רעיון חדש — למשל: תזכורת חד־פעמית לתרופה → להציע קבועה" style="width:70%">
        <button>הוסף</button></p>
    </form>`;
}

function noteForm(r, ideas, csrf) {
  const options = ideas.filter((f) => f.status !== 'dropped' || f.id === r.idea_id)
    .map((f) => `<option value="${f.id}"${f.id === r.idea_id ? ' selected' : ''}>${esc(f.title)}</option>`).join('');
  return `<form method="post" action="/owner-log/note">${hidden(csrf)}
    <input type="hidden" name="id" value="${r.id}">
    <textarea name="insight" rows="2" style="width:100%" placeholder="מה זה מלמד">${esc(r.insight || '')}</textarea>
    <span class="small"><select name="idea_id"><option value="">— בלי פיצ'ר —</option>${options}</select>
    <button>שמור</button></span>
  </form>`;
}

async function renderOwnerLogAt(client, { scan, now = new Date(), csrf = '' } = {}) {
  await ownerMessages.fillOutcomes(client, { ...(scan ? { scan } : {}), now });
  const ideas = await ownerMessages.listIdeas(client);
  const rows = await ownerMessages.list(client, LIMIT);
  if (!rows.length) {
    return ideasHtml(ideas, csrf)
      + '<h4>היומן</h4><p class="dim">עוד לא נכתבה מכאן אף הודעה. כותבים אחת מדף המשתמש, בתחתית "מה מתוכנן להישלח אליו".</p>';
  }
  const total = rows[0].total;
  return `${ideasHtml(ideas, csrf)}
    <h4>היומן</h4>
    <table>
    <tr><th>מתי</th><th>למי</th><th>מה ביקשתי</th><th>מה עולמה כתבה בפועל</th><th>ענה?</th><th>תובנה ופיצ'ר</th></tr>
    ${rows.map((r) => `<tr>
      <td class="dim small nowrap">${ago(r.created_at)}</td>
      <td>${userLink(r)}</td>
      <td>${esc(r.instruction)}${r.urgency === 'urgent' ? ' <span class="dim small">(דחופה)</span>' : ''}</td>
      <td>${sentCell(r)}</td>
      <td class="small nowrap">${replyCell(r, now)}</td>
      <td>${noteForm(r, ideas, csrf)}</td>
    </tr>`).join('')}</table>
    ${total > rows.length ? `<p class="dim small">מוצגות ${rows.length} האחרונות מתוך ${total}.</p>` : ''}`;
}

// The SECTIONS signature is positional and owned by the router — nothing is
// appended to it (rules: dashboard-and-domains); tests call renderOwnerLogAt.
async function renderOwnerLog(client, csrf) {
  return renderOwnerLogAt(client, { csrf });
}

module.exports = { renderOwnerLog, renderOwnerLogAt, STATUS_LABELS };
