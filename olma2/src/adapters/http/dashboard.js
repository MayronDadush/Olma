'use strict';
// Admin dashboard v2 — zero deps, server-rendered HTML, form POSTs. Reads the
// same domain/tables as the MCP adapter; renders pre-aggregated snapshots
// (usage_ledger, product_metrics_daily, job_heartbeats), never raw scans.
//
// Security (decided): Basic Auth stays while there's one admin, but every
// mutating POST is CSRF-protected via double-submit (SameSite=Strict cookie +
// matching form field) — Basic Auth alone is CSRF-able from any browser tab.
const http = require('node:http');
const crypto = require('node:crypto');
const flagsDomain = require('../../domain/flags');
const issuesDomain = require('../../domain/issues');
const { withTx } = require('../../db/pool');
const { assessJobs, isStale } = require('../../jobs/expectations');
const { deprovisionUser, previewDeletion } = require('../../intake/deprovision');
const sessionIndex = require('../../channels/sessions');

// ---- helpers ----------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function checkBasicAuth(req, user, pass) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  return eq(u || '', user) && eq(p || '', pass);
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 64_000) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
  });
}

const fmt = (n) => Number(n).toLocaleString('en-US');

// Relative time in Hebrew — "לפני 3 דק׳" beats a raw timestamp for scanning.
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'הרגע';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} שע׳`;
  return `לפני ${Math.round(s / 86400)} ימים`;
}

// ---- sections (named, not positional — the v1 pitfall) ----------------------
// Each carries a one-line explanation shown under its title: this is a tool
// looked at daily, not a diagnostics dump. Nothing unlabelled, nothing cryptic.

const SECTIONS = [
  { id: 'health', title: 'מצב המערכת', hint: 'האם כל התהליכים הפנימיים רצים כשורה. אדום = משהו תקוע וצריך טיפול.', render: renderHeartbeats },
  { id: 'users', title: 'משתמשים', hint: 'כל מי שרשום. אפשר לקבוע לכל אחד מכסת הודעות יומית משלו.', render: renderUsers },
  { id: 'issues', title: 'תקלות ובקשות', hint: 'דברים שאולמה או המשתמשים דיווחו עליהם ומחכים לטיפול.', render: renderIssues },
  { id: 'cost', title: 'עלות', hint: 'כמה עולה השימוש במודל — לפי יום ולפי משתמש. הערכה, לא חשבונית.', render: renderCost },
  { id: 'metrics', title: 'שימוש במוצר', hint: 'מה באמת קורה במוצר: כמה אנשים פעילים, כמה נוצר, מה הצליח.', render: renderMetrics },
  { id: 'outbox', title: 'הודעות יוצאות', hint: 'הודעות שאולמה יוזמת. "ממתין" = מחכה לשעה מתאימה אצל המשתמש.', render: renderOutbox },
  { id: 'flags', title: 'הגדרות מערכת', hint: 'שינוי כאן חל מיד, בלי עדכון גרסה. כל הגדרה מוסברת בשורה שלה.', render: renderFlags },
  { id: 'waitlist', title: 'רשימת המתנה', hint: 'אנשים שפנו כשההרשמה הייתה סגורה. יקבלו הודעה כשתיפתח.', render: renderWaitlist },
  { id: 'audit', title: 'יומן פעילות', hint: 'הפעולות האחרונות במערכת, לפי סדר.', render: renderAudit },
];

// Plain-Hebrew name for every internal job — nobody should need to know
// what "reopen_sweep" is to read this page.
const JOB_LABELS = {
  brokerd: 'מנוע ראשי',
  outbox_worker: 'שליחת הודעות',
  minute_sweeps: 'תזכורות, סיכומים ושחרור ממכסה',
  intake_sweep: 'קליטת משתמשים חדשים',
  reopen_sweep: 'עדכון רשימת המתנה',
  intake_template_sync: 'עדכון הודעת קליטה',
  config_guard: 'שומר אבטחה',
  checkin_ladder: 'פנייה יזומה למשתמשים',
  unanswered_sweep: 'תיקון הודעות שלא נענו',
  usage_sweep: 'חישוב עלויות',
  metrics_sweep: 'חישוב סטטיסטיקות',
  retention_sweep: 'ניקוי נתונים ישנים',
};

async function renderHeartbeats(client) {
  const { rows } = await client.query(`SELECT * FROM job_heartbeats ORDER BY job_name`);
  const now = Date.now();
  const problems = rows.filter((r) => isStale(r.job_name, r.last_run_at, now) || (r.note && String(r.note).startsWith('ERR')));

  const banner = problems.length === 0
    ? `<div class="banner ok">✓ הכל תקין — ${rows.length} תהליכים רצים כסדרם</div>`
    : `<div class="banner bad">⚠ ${problems.length} תהליכים דורשים תשומת לב</div>`;

  const tr = rows.map((r) => {
    const bad = isStale(r.job_name, r.last_run_at, now) || (r.note && String(r.note).startsWith('ERR'));
    const err = r.note && String(r.note).startsWith('ERR');
    return `<tr class="${bad ? 'bad' : ''}">
      <td>${bad ? '⚠' : '✓'} ${esc(JOB_LABELS[r.job_name] || r.job_name)}</td>
      <td class="dim">${r.last_run_at ? ago(r.last_run_at) : 'טרם רץ'}</td>
      <td class="dim mono">${err ? esc(String(r.note).slice(0, 90)) : ''}</td></tr>`;
  }).join('');
  return banner + `<table><tr><th>תהליך</th><th>רץ לאחרונה</th><th>שגיאה</th></tr>${tr}</table>`;
}

async function renderCost(client) {
  const days = await client.query(
    `SELECT date, sum(total_tokens) AS tokens, sum(cost_usd) AS cost
     FROM usage_ledger GROUP BY date ORDER BY date DESC LIMIT 14`);
  const top = await client.query(
    `SELECT u.first_name, u.phone, sum(l.total_tokens) AS tokens, sum(l.cost_usd) AS cost
     FROM usage_ledger l JOIN users u ON u.id = l.user_id
     WHERE l.date >= date_trunc('month', CURRENT_DATE)
     GROUP BY u.id ORDER BY cost DESC LIMIT 10`);
  if (!days.rows.length) return '<p class="dim">עדיין אין נתוני עלות — החישוב רץ כל שעה.</p>';
  const monthTotal = top.rows.reduce((s, r) => s + Number(r.cost), 0);
  const todayRow = days.rows[0];
  return `<div class="stats">
      <div class="stat"><div class="num">$${monthTotal.toFixed(2)}</div><div class="lbl">סה״כ החודש</div></div>
      <div class="stat"><div class="num">$${Number(todayRow.cost).toFixed(2)}</div><div class="lbl">היום</div></div>
      <div class="stat"><div class="num">${top.rows.length}</div><div class="lbl">משתמשים פעילים החודש</div></div>
    </div>
    <div class="cols"><div><h4>לפי יום</h4><table><tr><th>תאריך</th><th>עלות</th></tr>
    ${days.rows.map((r) => `<tr><td class="nowrap">${esc(String(r.date).slice(0, 10))}</td><td>$${Number(r.cost).toFixed(3)}</td></tr>`).join('')}</table></div>
    <div><h4>לפי משתמש (החודש)</h4><table><tr><th>מי</th><th>עלות</th></tr>
    ${top.rows.map((r) => `<tr><td>${esc(r.first_name || r.phone)}</td><td>$${Number(r.cost).toFixed(3)}</td></tr>`).join('')}</table></div></div>
    <p class="dim small">הערכה לפי צריכת הטוקנים בפועל. החיוב האמיתי מגיע מ-Anthropic.</p>`;
}

const METRIC_LABELS = {
  active_users: 'משתמשים פעילים', messages_counted: 'הודעות',
  tasks_created: 'משימות שנוצרו', reminders_created: 'תזכורות',
  meetings_started: 'פגישות שהתחילו', meetings_confirmed: 'פגישות שסוכמו',
  meetings_no_match: 'פגישות שלא הסתדרו', shares_offered: 'שיתופים שהוצעו',
  shares_accepted: 'שיתופים שהתקבלו', connections_requested: 'בקשות חברות',
  connections_approved: 'חברויות שאושרו', issues_reported: 'תקלות שדווחו',
  users_provisioned: 'משתמשים חדשים',
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
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${i.id}">
        <select name="status">${Object.entries(STATUS_ACTION).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button>עדכן</button></form></td></tr>`).join('')}</table>`;
}

// Every setting gets a human label, an explanation, and the right input type.
// A bare JSON box is a trap: it invites typos into live behaviour.
const FLAG_SPECS = [
  { key: 'registration_open', label: 'הרשמת משתמשים חדשים', type: 'bool',
    help: 'כשסגור — מי שפונה מקבל הודעה שההרשמה מושהית ונכנס לרשימת המתנה. מי שהוזמן ע״י חבר קיים ממשיך להיקלט כרגיל.' },
  { key: 'quota_daily_free', label: 'מכסת הודעות ליום — משתמש חינם', type: 'int',
    help: 'מעבר לזה אולמה שולחת סיכום אחרון ומפסיקה להגיב עד למחרת.' },
  { key: 'quota_hourly_paid', label: 'מכסת הודעות לשעה — מנוי', type: 'int',
    help: 'למנויים המכסה מתחדשת כל שעה במקום כל יום.' },
  { key: 'proactive_daily_budget', label: 'הודעות יזומות ליום', type: 'int',
    help: 'כמה פעמים ביום אולמה תפנה מיוזמתה. מעבר לזה — דברים לא דחופים מתאגדים לסיכום הבא במקום להישלח בנפרד.' },
  { key: 'intake_hourly_cap', label: 'תקרת נרשמים חדשים בשעה', type: 'int',
    help: 'הגנה מפני הצפה: אם יותר מזה אנשים לא מוכרים פונים תוך שעה, ההרשמה נסגרת אוטומטית ונפתחת תקלה כאן.' },
  { key: 'cost_per_mtok_usd', label: 'תעריף למיליון טוקנים ($)', type: 'num',
    help: 'משמש רק לחישוב ההערכה במסך העלות.' },
  { key: 'audit_retention_days', label: 'שמירת יומן פעילות (ימים)', type: 'int',
    help: 'אירועים שגרתיים נמחקים אחרי התקופה הזו. אירועי הרשאות ופרטיות נשמרים תמיד.' },
];
const EDITABLE_FLAGS = FLAG_SPECS.map((f) => f.key);

async function renderFlags(client, csrf) {
  const rows = [];
  for (const spec of FLAG_SPECS) {
    const val = await flagsDomain.getFlag(client, spec.key);
    const field = spec.type === 'bool'
      ? `<select name="value">
           <option value="true" ${val === true ? 'selected' : ''}>פתוח</option>
           <option value="false" ${val === false ? 'selected' : ''}>סגור</option>
         </select>`
      : `<input name="value" value="${esc(String(val))}" size="7" inputmode="decimal">`;
    rows.push(`<tr>
      <td><div>${spec.label}</div><div class="dim small">${spec.help}</div></td>
      <td class="nowrap"><form method="post" action="/flags" class="inline">
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="key" value="${esc(spec.key)}">
        ${field}<button>שמור</button>
      </form></td></tr>`);
  }
  return `<table class="settings"><tr><th>הגדרה</th><th>ערך</th></tr>${rows.join('')}</table>`;
}

const STATUS_LABEL = { active: 'פעיל', pending: 'ממתין', blocked: 'חסום' };
const PLAN_LABEL = { free: 'חינם', paid: 'מנוי' };

async function renderUsers(client, csrf) {
  const { rows } = await client.query(
    `SELECT u.id, u.phone, u.first_name, u.last_name, u.status, u.agent_id,
            u.quota_blocked_until, u.quota_override_daily, u.onboarded_at, e.plan,
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
      <td>${blocked(u) ? '<span class="pill warn">הגיע למכסה</span>'
        : u.status === 'active' ? '<span class="pill ok">פעיל</span>'
        : `<span class="pill">${STATUS_LABEL[u.status] || esc(u.status)}</span>`}</td>
      <td>${PLAN_LABEL[u.plan] || '—'}</td>
      <td>${u.open_tasks}</td>
      <td><form method="post" action="/users/quota" class="inline">
        <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${u.id}">
        <input name="override" value="${u.quota_override_daily ?? ''}" size="5"
               placeholder="ברירת מחדל" title="מספר הודעות ליום. ריק = לפי המנוי.">
        <button>שמור</button>
      </form></td></tr>`).join('')}</table>`;
}

const OUTBOX_STATE = {
  sent: 'נשלחו', ready: 'ממתינות לשליחה',
  night: 'ממתינות לשעה מתאימה', blocked: 'ממתינות (המשתמש במכסה)',
  budget: 'יצטרפו לסיכום הבא', expired: 'פג תוקפן',
  settling: 'ממתינות לייצוב המערכת',
};

async function renderOutbox(client) {
  const { rows } = await client.query(
    `SELECT coalesce(hold_reason, CASE WHEN sent_at IS NULL THEN 'ready' ELSE 'sent' END) AS state, count(*) AS n
     FROM outbox WHERE created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`);
  const failures = await client.query(
    `SELECT id, kind, attempts, last_error FROM outbox
     WHERE sent_at IS NULL AND attempts > 0 ORDER BY attempts DESC LIMIT 5`);
  if (!rows.length) return '<p class="dim">לא נשלחו הודעות יזומות בשבוע האחרון.</p>';
  return `<div class="stats">${rows.map((r) =>
      `<div class="stat"><div class="num">${r.n}</div><div class="lbl">${OUTBOX_STATE[r.state] || esc(r.state)}</div></div>`).join('')}</div>
    ${failures.rows.length ? `<div class="banner bad">⚠ הודעות שנכשלו בשליחה</div><table>
      <tr><th>סוג</th><th>נסיונות</th><th>שגיאה</th></tr>
      ${failures.rows.map((f) => `<tr class="bad"><td>${esc(f.kind)}</td><td>${f.attempts}</td>
        <td class="dim small">${esc((f.last_error || '').slice(0, 80))}</td></tr>`).join('')}</table>` : ''}`;
}

async function renderWaitlist(client) {
  const { rows } = await client.query(`SELECT * FROM waitlist ORDER BY created_at DESC LIMIT 50`);
  if (!rows.length) return '<p class="dim">ריק.</p>';
  return `<table><tr><th>טלפון</th><th>הצטרף</th><th>עודכן על פתיחה</th></tr>
    ${rows.map((w) => `<tr><td>${esc(w.phone)}</td><td>${esc(String(w.created_at).slice(0, 16))}</td>
      <td>${w.notified_at ? '✓' : '—'}</td></tr>`).join('')}</table>`;
}

// Per-user drill-down: their tasks (projects with subtasks indented),
// reminders, and what Olma has learned — the "is it actually working?" view.
// The last few turns as the person actually saw them — the fastest way to
// answer "did that land?" without SSH. Voice notes show the transcript, which
// is the thing most worth eyeballing: a garbled transcript looks exactly like
// "Olma ignored me" from the user's side.
function renderConversation(u) {
  if (!u.agent_id) return '';
  let msgs = [];
  let error = null;
  try { msgs = sessionIndex.readRecentMessages(u.agent_id, 10); } catch (e) { error = e.message; }
  const body = error
    ? `<p class="dim">לא הצלחתי לקרוא את השיחה: ${esc(error)}</p>`
    : !msgs.length
      ? '<p class="dim">אין עדיין שיחה.</p>'
      : `<div class="chat">${msgs.map((m) => `
          <div class="msg ${m.role === 'user' ? 'them' : 'olma'}">
            <div class="who">${m.role === 'user' ? esc([u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone) : 'אולמה'}
              ${m.isVoice ? '<span class="pill">🎤 תמלול</span>' : ''}
              <span class="dim small">${m.at ? String(m.at).slice(11, 16) : ''}</span></div>
            <div class="txt">${esc(m.text).replace(/\n/g, '<br>')}</div>
          </div>`).join('')}</div>`;
  return `<section><h3>10 ההודעות האחרונות</h3>
    <p class="hint">נקרא ישירות מהשיחה החיה — לא עותק. הודעות קוליות מסומנות 🎤 ומוצג התמלול שאולמה קיבלה בפועל.</p>
    ${body}</section>`;
}

// Deleting an account is irreversible and cascades widely, so it is two steps:
// the first click only reveals exactly what would be destroyed, and the second
// button carries the phone number so a stale tab can never delete the wrong
// person after the row order shifts.
async function renderDeletePanel(client, u, confirming, csrf) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone;
  if (!confirming) {
    return `<section><h3>מחיקת משתמש</h3>
      <p class="hint">מוחק את החשבון לגמרי: משימות, קשרים, זיכרון והסוכן האישי.
         אחרי המחיקה, אם ${esc(name)} ישלח הודעה לאולמה הוא יתחיל תהליך הרשמה מאפס.</p>
      <a class="btn-danger" href="/user?id=${u.id}&confirm=delete">מחק את ${esc(name)}…</a>
    </section>`;
  }
  const preview = await previewDeletion(client, u.phone);
  const c = preview.ok ? preview.data.counts : {};
  return `<section class="danger"><h3>למחוק את ${esc(name)}?</h3>
    <p class="hint">הפעולה לא הפיכה. יימחקו:</p>
    <ul class="dim">
      <li>${c.tasks ?? 0} משימות</li>
      <li>${c.connections ?? 0} חברויות (ומה שתלוי בהן אצל הצד השני)</li>
      <li>${c.shares ?? 0} שיתופי משימות · ${c.meetings ?? 0} השתתפויות בפגישות</li>
      <li>${c.outbox ?? 0} הודעות בתור, והזיכרון שאולמה צברה עליו</li>
    </ul>
    <form method="POST" action="/users/delete" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="phone" value="${esc(u.phone)}">
      <button class="danger">כן, מחק לצמיתות</button>
    </form>
    <a class="btn-quiet" href="/user?id=${u.id}">ביטול</a>
  </section>`;
}

async function renderUserPage(client, userId, { confirmDelete = false, csrf = '' } = {}) {
  const { rows: users } = await client.query(
    `SELECT u.*, e.plan FROM users u LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.id = $1`, [userId]);
  const u = users[0];
  if (!u) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone;

  const { rows: tasks } = await client.query(
    `SELECT t.*, (SELECT count(*)::int FROM task_reminders r
                  WHERE r.task_id = t.id AND r.sent_at IS NULL AND r.cancelled_at IS NULL) AS pending_reminders
     FROM tasks t WHERE t.owner_id = $1 AND t.archived_at IS NULL
     ORDER BY t.status = 'done', coalesce(t.parent_id, t.id), t.parent_id NULLS FIRST, t.id`, [userId]);
  const { rows: prefs } = await client.query(
    `SELECT key, value, learned_at FROM user_preferences WHERE user_id = $1 ORDER BY key`, [userId]);

  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done').slice(0, 15);
  const taskRow = (t) => `<tr>
    <td>${t.parent_id ? '<span class="dim">↳</span> ' : ''}${esc(t.title)}
        ${t.category ? `<span class="pill">${esc(t.category)}</span>` : ''}</td>
    <td class="dim small nowrap">${t.due_at ? new Date(t.due_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td>
    <td class="dim small">${t.pending_reminders > 0 ? `⏰ ${t.pending_reminders}` : ''}</td>
    <td class="dim small nowrap">${ago(t.created_at)}</td></tr>`;

  return `
    <section><h3>← <a href="/">חזרה</a></h3></section>
    <section>
      <h3>${esc(name)}</h3>
      <p class="hint">${esc(u.phone)} · ${PLAN_LABEL[u.plan] || '—'} · הצטרף ${ago(u.created_at)}</p>
      <div class="stats">
        <div class="stat"><div class="num">${open.length}</div><div class="lbl">משימות פתוחות</div></div>
        <div class="stat"><div class="num">${tasks.filter((t) => t.status === 'done').length}</div><div class="lbl">הושלמו</div></div>
        <div class="stat"><div class="num">${prefs.length}</div><div class="lbl">דברים שאולמה למדה</div></div>
      </div>
    </section>
    ${renderConversation(u)}
    <section><h3>משימות פתוחות</h3><p class="hint">כולל פרויקטים ותתי-משימות (↳), תזכורות ממתינות מסומנות ⏰.</p>
      ${open.length ? `<table><tr><th>משימה</th><th>יעד</th><th>תזכורות</th><th>נוצרה</th></tr>${open.map(taskRow).join('')}</table>` : '<p class="dim">אין משימות פתוחות.</p>'}
    </section>
    <section><h3>הושלמו לאחרונה</h3>
      ${done.length ? `<table><tr><th>משימה</th><th></th><th></th><th>נוצרה</th></tr>${done.map(taskRow).join('')}</table>` : '<p class="dim">עדיין לא הושלמו משימות.</p>'}
    </section>
    <section><h3>מה אולמה למדה עליו</h3><p class="hint">העדפות ועובדות שנשמרו מהשיחות — לא כולל את תוכן השיחות עצמן.</p>
      ${prefs.length ? `<table><tr><th>נושא</th><th>מה נשמר</th><th>מתי</th></tr>
        ${prefs.map((p) => `<tr><td class="mono small">${esc(p.key)}</td><td>${esc(p.value)}</td><td class="dim small nowrap">${ago(p.learned_at)}</td></tr>`).join('')}</table>`
      : '<p class="dim">עדיין כלום — זה מתמלא ככל שהם מתכתבים.</p>'}
    </section>
    ${await renderDeletePanel(client, u, confirmDelete, csrf)}`;
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

// ---- page + server ----------------------------------------------------------

const STYLE = `<style>
  :root{
    --bg:#12151a; --surface:#1a1f27; --surface-2:#212832; --border:#2c3441;
    --text:#e6eaf0; --muted:#8b95a5; --accent:#4ade9f; --accent-dim:#1d3d31;
    --warn:#f0a860; --warn-dim:#3a2c17; --bad:#f2766b; --bad-dim:#3a2220;
  }
  @media (prefers-color-scheme: light){
    :root{
      --bg:#f5f6f8; --surface:#fff; --surface-2:#eef0f4; --border:#dce0e7;
      --text:#1a1f27; --muted:#69717f; --accent:#1f9464; --accent-dim:#dcf2e8;
      --warn:#a86a1a; --warn-dim:#faeed9; --bad:#c0392b; --bad-dim:#fbe6e3;
    }
  }
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;direction:rtl;margin:0;
       background:var(--bg);color:var(--text);font-size:14px;line-height:1.55;
       -webkit-font-smoothing:antialiased}
  header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--bg) 92%,transparent);
         backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:14px 28px}
  .brand{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .brand h1{font-size:17px;margin:0;font-weight:600;letter-spacing:-.01em}
  .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);
              box-shadow:0 0 0 3px var(--accent-dim)}
  .brand .dot.bad{background:var(--bad);box-shadow:0 0 0 3px var(--bad-dim)}
  nav{display:flex;gap:2px;margin-top:10px;flex-wrap:wrap}
  nav a{color:var(--muted);font-size:12.5px;text-decoration:none;padding:5px 10px;border-radius:6px}
  nav a:hover{color:var(--text);background:var(--surface-2)}
  main{max-width:1080px;margin:0 auto;padding:20px 28px 80px}
  section{background:var(--surface);border:1px solid var(--border);border-radius:10px;
          padding:18px 20px;margin:16px 0}
  section h3{margin:0;font-size:15px;font-weight:600}
  section .hint{color:var(--muted);font-size:12.5px;margin:3px 0 14px}
  h4{margin:14px 0 6px;font-size:12.5px;color:var(--muted);font-weight:600}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  th{color:var(--muted);font-weight:500;font-size:11.5px;text-transform:none;white-space:nowrap}
  tbody tr:hover,table tr:hover{background:var(--surface-2)}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  .dim{color:var(--muted)} .small{font-size:12px} .mono{font-family:ui-monospace,SFMono-Regular,monospace}
  .nowrap{white-space:nowrap}
  tr.bad td{background:var(--bad-dim)}
  .banner{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:14px}
  .banner.ok{background:var(--accent-dim);color:var(--accent)}
  .banner.bad{background:var(--bad-dim);color:var(--bad)}
  .pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11.5px;
        background:var(--surface-2);color:var(--muted)}
  .pill.ok{background:var(--accent-dim);color:var(--accent)}
  .pill.warn{background:var(--warn-dim);color:var(--warn)}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  .stat{flex:1;min-width:120px;background:var(--surface-2);border-radius:8px;padding:12px 14px}
  .stat .num{font-size:22px;font-weight:600;letter-spacing:-.02em}
  .stat .lbl{color:var(--muted);font-size:12px;margin-top:2px}
  .cols{display:flex;gap:24px;flex-wrap:wrap} .cols>div{flex:1;min-width:240px}
  table.settings td:first-child{max-width:520px}
  form.inline{display:inline-flex;gap:6px;align-items:center}
  input,select{font-size:13px;padding:5px 8px;background:var(--bg);color:var(--text);
               border:1px solid var(--border);border-radius:6px;font-family:inherit}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
  button{cursor:pointer;font-size:12.5px;padding:5px 12px;background:var(--accent);
         color:var(--bg);border:0;border-radius:6px;font-weight:600;font-family:inherit}
  button:hover{filter:brightness(1.1)}
  button.danger{background:var(--bad);color:#fff}
  section.danger{border-color:var(--bad)}
  section.danger ul{margin:6px 0 14px;padding-inline-start:20px;font-size:13px}
  .btn-danger,.btn-quiet{display:inline-block;font-size:12.5px;padding:6px 12px;
    border-radius:6px;text-decoration:none;font-weight:600}
  .btn-danger{color:var(--bad);border:1px solid var(--bad)}
  .btn-danger:hover{background:var(--bad-dim)}
  .btn-quiet{color:var(--muted);margin-inline-start:8px}
  .btn-quiet:hover{color:var(--text)}
  .chat{display:flex;flex-direction:column;gap:8px}
  .msg{max-width:78%;padding:8px 11px;border-radius:10px;font-size:13.5px;line-height:1.5}
  .msg .who{font-size:11px;color:var(--muted);margin-bottom:3px;display:flex;gap:6px;align-items:center}
  .msg.them{align-self:flex-start;background:var(--surface-2)}
  .msg.olma{align-self:flex-end;background:var(--accent-dim)}
  .msg .txt{white-space:pre-wrap;overflow-wrap:anywhere}
  .help{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;
        border-radius:50%;background:var(--surface-2);color:var(--muted);font-size:10px;cursor:help}
  @media(max-width:640px){main,header{padding-inline:16px} .cols{gap:12px}}
</style>`;

// configPath is injectable so tests can exercise deletion against a temp
// openclaw.json instead of the live gateway's.
function createDashboard({ pool, adminUser, adminPass, configPath }) {
  const server = http.createServer(async (req, res) => {
    try {
      // Unauthenticated liveness/readiness probe — no data, just whether the
      // process is up and the DB answers. Safe to expose to a monitor.
      if (req.url === '/health') {
        try {
          await pool.query('SELECT 1');
          const { rows } = await pool.query(`SELECT job_name, last_run_at, note FROM job_heartbeats`);
          const verdict = assessJobs(rows);
          res.writeHead(verdict.ok ? 200 : 503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(verdict));
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'db unavailable' }));
        }
      }
      if (!checkBasicAuth(req, adminUser, adminPass)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="olma2"' });
        return res.end('auth required');
      }
      const url = new URL(req.url, 'http://x');

      if (req.method === 'POST') {
        const body = await readBody(req);
        const cookieCsrf = getCookie(req, 'csrf');
        if (!cookieCsrf || body.csrf !== cookieCsrf) {
          res.writeHead(403); return res.end('csrf');
        }
        await withTx(pool, async (client) => {
          if (url.pathname === '/flags' && EDITABLE_FLAGS.includes(body.key)) {
            // Coerce by declared type — a stray character must never turn a
            // number into a string and silently change live behaviour.
            const spec = FLAG_SPECS.find((f) => f.key === body.key);
            let val;
            if (spec.type === 'bool') val = body.value === 'true';
            else {
              val = Number(body.value);
              if (!Number.isFinite(val) || val < 0) val = null;
            }
            if (val !== null) await flagsDomain.setFlag(client, body.key, val);
          } else if (url.pathname === '/issues/status') {
            await issuesDomain.setStatus(client, Number(body.id), body.status);
          } else if (url.pathname === '/users/quota') {
            const override = body.override === '' ? null : parseInt(body.override, 10);
            await client.query(`UPDATE users SET quota_override_daily = $2 WHERE id = $1`, [Number(body.id), override]);
          } else if (url.pathname === '/users/delete') {
            // Keyed by phone, not row id: the confirmation page the operator
            // read was about a specific person, and the phone is what the
            // gateway config and workspace are keyed on anyway.
            if (/^\+\d{7,15}$/.test(body.phone || '')) {
              await deprovisionUser(client, body.phone, { configPath });
            }
          }
        });
        res.writeHead(303, { Location: '/' });
        return res.end();
      }

      // GET / — render everything; (re)issue the CSRF cookie
      const csrf = getCookie(req, 'csrf') || crypto.randomBytes(16).toString('hex');
      const client = await pool.connect();
      let sectionsHtml = '';
      let healthy = true;
      try {
        const hb = await client.query(`SELECT job_name, last_run_at, note FROM job_heartbeats`);
        healthy = assessJobs(hb.rows).ok;
        if (url.pathname === '/user') {
          const page = await renderUserPage(client, parseInt(url.searchParams.get('id'), 10) || 0, {
            confirmDelete: url.searchParams.get('confirm') === 'delete', csrf,
          });
          sectionsHtml = page || '<section><h3>משתמש לא נמצא</h3><p class="hint"><a href="/">חזרה</a></p></section>';
        } else {
          for (const s of SECTIONS) {
            sectionsHtml += `<section id="${s.id}"><h3>${s.title}</h3>` +
              `<p class="hint">${s.hint}</p>${await s.render(client, csrf)}</section>`;
          }
        }
      } finally { client.release(); }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // every number on this page is live state; a cached copy is always a lie
        // (and a stale copy after a deploy reads as "the change didn't ship")
        'Cache-Control': 'no-store, must-revalidate',
        'Set-Cookie': `csrf=${csrf}; SameSite=Strict; Path=/; HttpOnly`,
      });
      res.end(`<!doctype html><html lang="he"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta name="color-scheme" content="dark light">
        <title>אולמה — לוח בקרה</title>${STYLE}</head>
        <body><header>
          <div class="brand"><span class="dot ${healthy ? '' : 'bad'}"></span>
            <h1>אולמה — לוח בקרה</h1>
            <span class="dim small">${healthy ? 'כל המערכות תקינות' : 'יש תקלה — ראה מצב המערכת'}</span>
          </div>
          <nav>${SECTIONS.map((s) => `<a href="${url.pathname === '/' ? '' : '/'}#${s.id}">${s.title}</a>`).join('')}</nav>
        </header>
        <main>${sectionsHtml}</main></body></html>`);
    } catch (e) {
      console.error('[dashboard]', e);
      res.writeHead(500); res.end('error');
    }
  });
  return server;
}

module.exports = { createDashboard, checkBasicAuth, SECTIONS, EDITABLE_FLAGS };
