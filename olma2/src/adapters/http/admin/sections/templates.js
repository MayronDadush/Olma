'use strict';
// templates — one section of the admin page (see ./index.js).
//
// Every fixed sentence Olma sends verbatim, in one place, each with its
// default beside a box to reword it. The list itself is
// domain/message-templates.TEMPLATES; this file only draws it. One form for
// all of them, like the reaction vocabulary: the stored object is REPLACED on
// save, so clearing a box really does return that sentence to its default.
//
// A box that fails validation (a nudge with its `{{missing}}` tags deleted)
// is not stored, and the page says so under that box on the next render —
// the audit row carries the refusal, and the section reads it back. Silent
// refusal would be the worse failure: the operator would see their text in
// the box and a group would get a sentence that pings nobody.
const { esc } = require('../../html');
const templates = require('../../../../domain/message-templates');

const AUDIENCES = [
  { id: 'private', title: 'לאנשים בפרטי' },
  { id: 'group', title: 'בקבוצות' },
];

// What the last save refused, if it was the last thing that happened to this
// flag: the audit row for admin.message_templates carries `rejected`.
async function lastRejections(client) {
  const { rows } = await client.query(
    `SELECT detail FROM audit_log WHERE event = 'admin.message_templates' ORDER BY id DESC LIMIT 1`
  );
  const d = rows[0] && rows[0].detail;
  return d && d.rejected && typeof d.rejected === 'object' ? d.rejected : {};
}

function varsLine(t) {
  const names = Object.keys(t.vars);
  if (!names.length) return '<div class="dim small">בלי משתנים.</div>';
  const parts = names.map((n) => `<span class="mono">{{${n}}}</span> — ${esc(t.vars[n])}${t.required.includes(n) ? ' <b>(חובה)</b>' : ''}`);
  return `<div class="dim small">משתנים: ${parts.join(' · ')}</div>`;
}

function row(t, stored, rejected) {
  const override = typeof stored[t.key] === 'string' ? stored[t.key] : '';
  const live = templates.textFor(t.key, stored);
  const badge = override && live === override ? ' <span class="pill ok">מנוסח מחדש</span>' : '';
  const refused = rejected[t.key] ? `<div class="warn small">לא נשמר: ${esc(rejected[t.key])}</div>` : '';
  return `<tr id="tpl-${esc(t.key)}">
    <td><div>${esc(t.label)}${badge}</div><div class="dim small">${esc(t.help)}</div>${varsLine(t)}
      <pre class="tpl" title="ברירת המחדל">${esc(t.text)}</pre></td>
    <td><textarea class="tpl" name="${esc(t.key)}" rows="${Math.max(3, t.text.split('\n').length + 1)}" maxlength="${templates.MAX_LENGTH}" placeholder="ריק = ברירת המחדל">${esc(override)}</textarea>${refused}</td>
  </tr>`;
}

async function renderTemplates(client, csrf) {
  const stored = await templates.load(client);
  const rejected = await lastRejections(client);
  const tables = AUDIENCES.map(({ id, title }) => {
    const rows = templates.TEMPLATES.filter((t) => t.audience === id).map((t) => row(t, stored, rejected)).join('');
    return `<h4>${title}</h4><table class="settings templates"><tr><th>ההודעה וברירת המחדל</th><th>במקום זה</th></tr>${rows}</table>`;
  }).join('');
  return `<form method="post" action="/templates">
      <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#templates">
      ${tables}
      <div style="margin-top:8px"><button>שמור ניסוחים</button> <button name="reset" value="1" formnovalidate>הכל חזרה לברירת המחדל</button></div>
    </form>`;
}

module.exports = { renderTemplates, AUDIENCES };
