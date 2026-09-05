'use strict';
// The address book: its summary section and its own paged page (/contacts).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('./html');
const { esc } = require('../html');

// ---- the address book ------------------------------------------------------
// Every contact every user saved or imported, keyed by the phone number rather
// than by the row — the same number usually carries several names, one per
// person who saved it ("אמא" to one user, "רותי כהן" to another), and the
// question worth answering here is "who is this number, to everyone who knows
// them, and are they already with us".
//
// OPERATOR-ONLY, deliberately. A user's address book is private to them: no
// agent can read another user's contacts, and domain/contacts.js#namesForPhone
// (the same cross-user lookup) is kept out of the MCP registry for exactly
// that reason. This page exists because the person running Olma needs to see
// their own data, and it sits behind the dashboard's Basic Auth like the rest.
const CONTACTS_PAGE_SIZE = 100;

// One row per distinct phone, with every name given to it and whether that
// number belongs to a user of ours. Returns { rows, total }.
async function readContactBook(client, { q = '', onlyOlma = false, page = 0 } = {}) {
  const like = q.trim() ? `%${q.trim()}%` : null;
  const where = `WHERE ($1::text IS NULL OR uc.display_name ILIKE $1 OR uc.phone ILIKE $1)
                   ${onlyOlma ? 'AND u.id IS NOT NULL' : ''}`;
  const { rows: totals } = await client.query(
    `SELECT count(DISTINCT uc.phone)::int AS n
     FROM user_contacts uc LEFT JOIN users u ON u.phone = uc.phone ${where}`, [like]);
  const { rows } = await client.query(
    `SELECT uc.phone,
            array_agg(DISTINCT uc.display_name) AS names,
            array_agg(DISTINCT uc.user_id)      AS owner_ids,
            max(uc.updated_at)                  AS last_seen,
            u.id AS olma_id, u.first_name, u.last_name, u.status
     FROM user_contacts uc LEFT JOIN users u ON u.phone = uc.phone
     ${where}
     GROUP BY uc.phone, u.id, u.first_name, u.last_name, u.status
     ORDER BY (u.id IS NOT NULL) DESC, count(DISTINCT uc.user_id) DESC, max(uc.updated_at) DESC
     LIMIT $2 OFFSET $3`,
    [like, CONTACTS_PAGE_SIZE, page * CONTACTS_PAGE_SIZE]);
  return { rows, total: totals[0].n };
}

// Owner ids → display names, from one small query: there are a handful of
// users, so this is cheaper and simpler than joining the owner table back into
// the grouped query above.
async function ownerNames(client) {
  const { rows } = await client.query(`SELECT id, first_name, last_name, phone FROM users`);
  const map = new Map();
  for (const u of rows) {
    map.set(Number(u.id), [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone);
  }
  return map;
}

function contactSearchForm(q, onlyOlma) {
  return `<form method="get" action="/contacts" class="inline" style="margin-bottom:12px">
    <input name="q" value="${esc(q)}" placeholder="שם או מספר" size="22">
    <label class="dim small"><input type="checkbox" name="only" value="olma" ${onlyOlma ? 'checked' : ''}>
      רק מי שכבר אצלנו</label>
    <button>חיפוש</button></form>`;
}

// The main page gets the shape of the thing, not 3000 rows: counts, the few
// numbers more than one person saved, and the way in.
async function renderContactsSection(client) {
  const { rows: sum } = await client.query(
    `SELECT count(*)::int AS saved,
            count(DISTINCT phone)::int AS people,
            count(DISTINCT user_id)::int AS owners
     FROM user_contacts`);
  const { rows: known } = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT uc.phone FROM user_contacts uc JOIN users u ON u.phone = uc.phone GROUP BY uc.phone
     ) t`);
  const { rows: shared } = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT phone FROM user_contacts GROUP BY phone HAVING count(DISTINCT user_id) > 1
     ) t`);
  const s = sum[0];
  if (!s.saved) return '<p class="dim">אף אחד עוד לא שמר או ייבא אנשי קשר.</p>';
  return `<div class="stats">
      <div class="stat"><div class="num">${s.people}</div><div class="lbl">אנשים (מספרים שונים)</div></div>
      <div class="stat"><div class="num">${s.saved}</div><div class="lbl">שמירות סה״כ</div></div>
      <div class="stat"><div class="num">${known[0].n}</div><div class="lbl">מתוכם כבר משתמשים אצלנו</div></div>
      <div class="stat"><div class="num">${shared[0].n}</div><div class="lbl">מוכרים ליותר ממשתמש אחד</div></div>
      <div class="stat"><div class="num">${s.owners}</div><div class="lbl">משתמשים ששמרו</div></div>
    </div>
    ${contactSearchForm('', false)}
    <p class="hint"><a href="/contacts">פתיחת ספר הכתובות המלא ←</a></p>`;
}

async function renderContactsPage(client, { q = '', onlyOlma = false, page = 0 } = {}) {
  const { rows, total } = await readContactBook(client, { q, onlyOlma, page });
  const owners = await ownerNames(client);
  const pages = Math.ceil(total / CONTACTS_PAGE_SIZE);
  const link = (p) => `/contacts?q=${encodeURIComponent(q)}${onlyOlma ? '&only=olma' : ''}&page=${p}`;

  const body = rows.length ? `<table>
    <tr><th>טלפון</th><th>שמות שניתנו לו</th><th>מי שמר</th><th>אצלנו?</th><th>עודכן</th></tr>
    ${rows.map((r) => `<tr>
      <td class="mono">${esc(r.phone)}</td>
      <td>${r.names.map((n) => esc(n)).join('<span class="dim"> · </span>')}</td>
      <td class="dim small">${r.owner_ids.map((id) => esc(owners.get(Number(id)) || `#${id}`)).join(', ')}</td>
      <td>${r.olma_id
        ? `<a href="/user?id=${r.olma_id}"><span class="pill ok">${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || 'משתמש')}</span></a>`
        : '<span class="dim">—</span>'}</td>
      <td class="dim small nowrap">${ago(r.last_seen)}</td></tr>`).join('')}</table>`
    : '<p class="dim">אין תוצאות לחיפוש הזה.</p>';

  const nav = pages > 1 ? `<p class="hint">
      ${page > 0 ? `<a href="${link(page - 1)}">← הקודם</a>` : ''}
      עמוד ${page + 1} מתוך ${pages}
      ${page + 1 < pages ? `<a href="${link(page + 1)}">הבא →</a>` : ''}</p>` : '';

  return `
    <section><h3>← <a href="/">חזרה</a></h3></section>
    <section>
      <h3>ספר הכתובות</h3>
      <p class="hint">${total} אנשים${q ? ` שתואמים "${esc(q)}"` : ''}${onlyOlma ? ', מסונן למי שכבר משתמש אצלנו' : ''}.
        מקובץ לפי מספר טלפון — כל השמות שניתנו לאותו מספר מופיעים יחד.</p>
      ${contactSearchForm(q, onlyOlma)}
      ${body}
      ${nav}
    </section>`;
}

module.exports = { CONTACTS_PAGE_SIZE, readContactBook, ownerNames, contactSearchForm, renderContactsSection, renderContactsPage };
