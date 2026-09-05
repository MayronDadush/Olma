'use strict';
// users — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { esc } = require('../../html');

const STATUS_LABEL = { active: 'פעיל', pending: 'ממתין', blocked: 'חסום' };

const PLAN_LABEL = { free: 'חינם', paid: 'מנוי' };

async function renderUsers(client, csrf) {
  const { rows } = await client.query(
    `SELECT u.id, u.phone, u.first_name, u.last_name, u.status, u.agent_id,
            u.quota_blocked_until, u.quota_override_daily, u.onboarded_at, u.paused_at, e.plan,
            (SELECT count(*) FROM tasks t WHERE t.owner_id = u.id AND t.status = 'open' AND t.archived_at IS NULL) AS open_tasks
     FROM users u LEFT JOIN entitlements e ON e.user_id = u.id
     ORDER BY u.id LIMIT 200`);
  if (!rows.length) return '<p class="dim">אין עדיין משתמשים. מי שישלח הודעה לוואטסאפ ייקלט אוטומטית.</p>';

  const blocked = (u) => u.quota_blocked_until && new Date(u.quota_blocked_until) > new Date();
  return `<table>
    <tr><th>שם</th><th>טלפון</th><th>מצב</th><th>מנוי</th><th>משימות פתוחות</th>
        <th>מכסת הודעות ליום <span class="help" title="כמה הודעות מותר לו לשלוח ביום. השאר ריק כדי להשתמש בברירת המחדל של המנוי שלו.">?</span></th></tr>
    ${rows.map((u) => `<tr>
      <td><a href="/user?id=${u.id}">${esc([u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone)}</a></td>
      <td class="mono dim">${esc(u.phone)}</td>
      <td>${u.paused_at ? '<span class="pill warn">ביקש להפסיק</span>'
        : blocked(u) ? '<span class="pill warn">הגיע למכסה</span>'
        : u.status === 'active' ? '<span class="pill ok">פעיל</span>'
        : `<span class="pill">${STATUS_LABEL[u.status] || esc(u.status)}</span>`}</td>
      <td>${PLAN_LABEL[u.plan] || '—'}</td>
      <td>${u.open_tasks}</td>
      <td><form method="post" action="/users/quota" class="inline">
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#users"><input type="hidden" name="id" value="${u.id}">
        <input name="override" value="${u.quota_override_daily ?? ''}" size="5"
               placeholder="ברירת מחדל" title="מספר הודעות ליום. ריק = לפי המנוי.">
        <button>שמור</button>
      </form></td></tr>`).join('')}</table>`;
}

module.exports = { STATUS_LABEL, PLAN_LABEL, renderUsers };
