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

// The preview above the box shows the LIVE sentence — the override when there
// is one, the default otherwise — with real values in place of the
// placeholders (message-templates.example). The owner asked for that on
// 2026-09-09: a legend describing `{{inviter_name}}` is not the same as seeing
// the message, and the thing being decided here is how it READS.
//
// The legend stays underneath it, small, because it is not decoration: an
// override that drops a required placeholder is refused by name, and the
// operator cannot type one whose name the page never showed him. What it is
// no longer asked to do is stand in for the message itself.
function varsLine(t) {
  const names = Object.keys(t.vars);
  if (!names.length) return '';
  const parts = names.map((n) => `<span class="mono">{{${n}}}</span> — ${esc(t.vars[n])}${t.required.includes(n) ? ' <b>(חובה)</b>' : ''}`);
  return `<div class="dim small">משתנים: ${parts.join(' · ')}</div>`;
}

// One language of one message: the default, the box, and what the last save
// refused for it. An empty cell is a message that exists in Hebrew only —
// everything said in a group, today — and says so rather than offering a box
// that nothing would ever send.
function cell(t, stored, rejected) {
  if (!t) return '<td class="dim small">רק בעברית — אין גרסה באנגלית להודעה הזו.</td>';
  const override = typeof stored[t.key] === 'string' ? stored[t.key] : '';
  const live = templates.textFor(t.key, stored);
  const badge = override && live === override ? ' <span class="pill ok">מנוסח מחדש</span>' : '';
  const refused = rejected[t.key] ? `<div class="warn small">לא נשמר: ${esc(rejected[t.key])}</div>` : '';
  return `<td>${badge}
      <pre class="tpl" title="ככה ההודעה תיראה בוואטסאפ">${esc(templates.example(t.key, stored))}</pre>
      ${varsLine(t)}
      <textarea class="tpl" name="${esc(t.key)}" rows="${Math.max(3, t.text.split('\n').length + 1)}" maxlength="${templates.MAX_LENGTH}" placeholder="ריק = ברירת המחדל">${esc(override)}</textarea>${refused}</td>`;
}

// One row per MESSAGE, Hebrew beside English (domain/message-templates
// .families): the owner asked (2026-09-08) for every fixed sentence in one
// place, in both languages, rather than the English twins scattered down the
// same list as separate entries.
function row(f, stored, rejected) {
  return `<tr id="tpl-${esc(f.id)}">
    <td><div>${esc(f.label)}</div><div class="dim small">${esc(f.help)}</div></td>
    ${cell(f.he, stored, rejected)}
    ${cell(f.en, stored, rejected)}
  </tr>`;
}

async function renderTemplates(client, csrf) {
  const stored = await templates.load(client);
  const rejected = await lastRejections(client);
  const tables = AUDIENCES.map(({ id, title }) => {
    const rows = templates.families().filter((f) => f.audience === id).map((f) => row(f, stored, rejected)).join('');
    return `<h4>${title}</h4><table class="settings templates bilingual"><tr><th>ההודעה</th><th>עברית</th><th>אנגלית</th></tr>${rows}</table>`;
  }).join('');
  return `<form method="post" action="/templates">
      <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#templates">
      ${tables}
      <div style="margin-top:8px"><button>שמור ניסוחים</button> <button name="reset" value="1" formnovalidate>הכל חזרה לברירת המחדל</button></div>
    </form>`;
}

module.exports = { renderTemplates, AUDIENCES };
