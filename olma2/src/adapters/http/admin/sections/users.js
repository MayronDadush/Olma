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
        <th>מכסת הודעות ליום <span class="help" title="כמה הודעות מותר לו לשלוח ביום. השאר ריק כדי להשתמש בברירת המחדל של המנוי שלו.">?</span></th>
        <th>העמוד שלו <span class="help" title="פותח את הדאשבורד האישי של המשתמש, בדיוק כמו שהוא רואה אותו. הכניסה נשארת פתוחה 30 יום.">?</span></th></tr>
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
      </form></td>
      <td>${u.status === 'active' ? dashboardButton(u.id, csrf, '/#users') : '<span class="dim">—</span>'}</td>
      </tr>`).join('')}</table>`;
}

// Open a person's own dashboard, as they see it.
//
// The link a user gets in WhatsApp is single-use and lives 30 minutes, which
// is right for a message somebody might screenshot and wrong for looking
// through a dozen accounts for layout bugs — by the time you have pasted it
// into a browser it has often expired. This mints one and goes straight
// there, so the thirty minutes is never spent waiting; the SESSION it opens
// is the normal one and lasts thirty idle days.
//
// It is a real sign-in as that person, not a read-only preview, so it is
// audited under their id like every other admin edit on this page. Offered
// only for an active user because `createLink` refuses anyone else anyway,
// and a button that cannot work should not be drawn.
function dashboardButton(userId, csrf, back) {
  return `<form method="post" action="/users/dashboard" class="inline">
    <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${userId}">
    <input type="hidden" name="back" value="${esc(back)}">
    <button>פתיחה</button>
  </form>`;
}

module.exports = { STATUS_LABEL, PLAN_LABEL, renderUsers, dashboardButton };
