'use strict';
// The per-person drill-down page (/user?id=N).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('./html');
const { PLAN_LABEL } = require('./sections/users');
const { renderPlannedForUser } = require('./sections/planned');
const factsDomain = require('../../../domain/facts');
const { previewDeletion } = require('../../../intake/deprovision');
const sessionIndex = require('../../../channels/sessions');
const { esc } = require('../html');

function renderPrefsForUser(prefs, u, csrf) {
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="back" value="/user?id=${u.id}">
    <input type="hidden" name="user_id" value="${u.id}">`;
  return `<section><h3>העדפות — איך לעבוד איתו</h3>
    <p class="hint">איך אולמה מתנהגת מולו: שעות, אורך תשובות, טון. שמירה על מפתח קיים דורסת אותו.</p>
    ${prefs.length ? `<table><tr><th>מפתח</th><th>ערך</th><th>נלמד</th><th></th></tr>
      ${prefs.map((p) => `<tr>
        <td class="mono small">${esc(p.key)}</td>
        <td><form method="post" action="/prefs/set" class="inline">${hidden}
          <input type="hidden" name="key" value="${esc(p.key)}">
          <input name="value" value="${esc(p.value)}" size="34"><button>שמור</button></form></td>
        <td class="dim small nowrap">${ago(p.learned_at)}</td>
        <td><form method="post" action="/prefs/delete" class="inline">${hidden}
          <input type="hidden" name="key" value="${esc(p.key)}">
          <button class="danger">מחק</button></form></td>
      </tr>`).join('')}</table>` : '<p class="dim">עדיין לא נלמדו העדפות.</p>'}
    <form method="post" action="/prefs/set" class="inline">${hidden}
      <input name="key" placeholder="מפתח (אנגלית, למשל availability)" size="26">
      <input name="value" placeholder="ערך" size="30">
      <button>הוסף העדפה</button>
    </form></section>`;
}

function renderFactsForUser(facts, u, csrf) {
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="back" value="/user?id=${u.id}">
    <input type="hidden" name="user_id" value="${u.id}">`;
  const IMPORTANCE = { 1: 'רגילה', 2: 'חשובה', 3: 'ליבה' };
  const SOURCE = { conversation: 'מהשיחה', user_stated: 'נאמר במפורש', admin: 'הוזן ידנית' };
  return `<section><h3>עובדות — מה אולמה יודעת עליו</h3>
    <p class="hint">מי הוא ומה קורה בחייו. העשר החשובות ביותר נמצאות מול הסוכן בכל תור.
      מחיקה כאן מפסיקה להשתמש בעובדה — ההיסטוריה נשמרת.<br>
      לא ייקלטו: שם (זה שדה בפרופיל), מספר טלפון (זה איש קשר), מצב של אולמה עצמה
      (יומן מחובר, דייג׳סט מוגדר — כבר על הכרטיס), ועובדה שנוקבת בתאריך או ב״היום/מחר״
      בלי תאריך תפוגה.</p>
    ${facts.length ? `<table><tr><th>קטגוריה</th><th>העובדה</th><th>חשיבות</th><th>מקור</th><th>נלמד</th><th></th></tr>
      ${facts.map((f) => `<tr>
        <td class="mono small">${esc(f.category)}</td>
        <td class="small">${esc(f.fact)}</td>
        <td class="small">${IMPORTANCE[f.importance] || f.importance}</td>
        <td class="dim small">${SOURCE[f.source] || esc(f.source || '')}</td>
        <td class="dim small nowrap">${ago(f.learned_at)}</td>
        <td><form method="post" action="/facts/delete" class="inline">${hidden}
          <input type="hidden" name="id" value="${f.id}">
          <button class="danger">מחק</button></form></td>
      </tr>`).join('')}</table>` : '<p class="dim">עדיין לא נשמרו עובדות.</p>'}
    <form method="post" action="/facts/add">${hidden}
      <p><input name="fact" placeholder="עובדה אחת, במשפט קצר" style="width:60%">
      <select name="category">
        ${factsDomain.KNOWN_FACT_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <select name="importance">
        <option value="1">רגילה</option><option value="2">חשובה</option><option value="3">ליבה</option>
      </select>
      <label class="small">פג תוקף <input type="date" name="expires_at" title="ריק = תמידית"></label>
      <button>הוסף עובדה</button></p>
    </form></section>`;
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
  // Pinned to THEIR phone: silent housekeeping turns (fact extraction, memory
  // consolidation) open sessions of their own on the same agent, and a
  // peer-less read returns whichever session was last active — so this panel
  // would show a job's prompt instead of the conversation it promises.
  try { msgs = sessionIndex.readRecentMessages(u.agent_id, 10, undefined, u.phone); }
  catch (e) { error = e.message; }
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

// Shown only when it applies, and above everything else on the page — every
// number below it (queued messages, reminders, digest) is describing machinery
// that is currently switched off, and reading them without knowing that is how
// an operator concludes the system is broken.
function renderPauseBanner(u, csrf) {
  if (!u.paused_at) return '';
  return `<section><h3>ביקש להפסיק</h3>
    <p class="hint">הפסיק לקבל פניות יזומות ב-${esc(String(u.paused_at).slice(0, 16))}.
      שום דבר לא נמחק — המשימות, העובדות וההיסטוריה שלו במקום. אולמה עדיין עונה לו אם הוא כותב.</p>
    <form method="post" action="/users/resume" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="user_id" value="${u.id}">
      <input type="hidden" name="back" value="/user?id=${u.id}">
      <button>החזר אותו לפעילות</button>
    </form>
    <p class="hint">רק אם הוא ביקש לחזור. התזכורות החוזרות שהושהו יחזרו למועד הבא האמיתי שלהן.</p>
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
  // Through the domain function, so the operator sees exactly what the agent
  // sees: active only, expired filtered out, same ordering.
  const factRows = (await factsDomain.listFacts(client, userId)).data.facts;
  // Operator-only, never shown to any agent or user: whose address books
  // already carry this phone number, and under what name. The reverse of
  // domain/contacts.js#namesForPhone's provisioning use — there it prefills a
  // brand-new user's own name; here it just tells the person reading the
  // dashboard "this number is known to others as X" for context.
  const { rows: knownAs } = await client.query(
    `SELECT uc.display_name, uc.user_id AS owner_id, o.first_name, o.last_name
     FROM user_contacts uc JOIN users o ON o.id = uc.user_id
     WHERE uc.phone = $1 ORDER BY uc.user_id`, [u.phone]);

  const open = tasks.filter((t) => t.status === 'open');
  const done = tasks.filter((t) => t.status === 'done').slice(0, 15);
  const taskRow = (t) => `<tr>
    <td>${t.parent_id ? '<span class="dim">↳</span> ' : ''}${esc(t.title)}
        ${t.category ? `<span class="pill">${esc(t.category)}</span>` : ''}
        ${t.source === 'extracted' ? '<span class="pill">מהשיחה</span>' : ''}</td>
    <td class="dim small nowrap">${t.due_at ? new Date(t.due_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td>
    <td class="dim small">${t.pending_reminders > 0 ? `⏰ ${t.pending_reminders}` : ''}</td>
    <td class="dim small nowrap">${ago(t.created_at)}</td></tr>`;

  return `
    <section><h3>← <a href="/">חזרה</a></h3></section>
    <section>
      <h3>${esc(name)}</h3>
      <p class="hint">${esc(u.phone)} · ${PLAN_LABEL[u.plan] || '—'} · הצטרף ${ago(u.created_at)}</p>
      ${knownAs.length ? `<p class="hint">מוכר/ת אצל אחרים בתור: ${knownAs.map((k) =>
        `${esc(k.display_name)} (<a href="/user?id=${k.owner_id}">${esc([k.first_name, k.last_name].filter(Boolean).join(' ') || `משתמש ${k.owner_id}`)}</a>)`
      ).join(', ')}</p>` : ''}
      <div class="stats">
        <div class="stat"><div class="num">${open.length}</div><div class="lbl">משימות פתוחות</div></div>
        <div class="stat"><div class="num">${tasks.filter((t) => t.status === 'done').length}</div><div class="lbl">הושלמו</div></div>
        <div class="stat"><div class="num">${prefs.length}</div><div class="lbl">העדפות</div></div>
        <div class="stat"><div class="num">${factRows.length}</div><div class="lbl">עובדות</div></div>
      </div>
    </section>
    ${renderPauseBanner(u, csrf)}
    ${await renderPlannedForUser(client, u, csrf)}
    ${renderConversation(u)}
    <section><h3>משימות פתוחות</h3><p class="hint">כולל פרויקטים ותתי-משימות (↳), תזכורות ממתינות מסומנות ⏰.</p>
      ${open.length ? `<table><tr><th>משימה</th><th>יעד</th><th>תזכורות</th><th>נוצרה</th></tr>${open.map(taskRow).join('')}</table>` : '<p class="dim">אין משימות פתוחות.</p>'}
    </section>
    <section><h3>הושלמו לאחרונה</h3>
      ${done.length ? `<table><tr><th>משימה</th><th></th><th></th><th>נוצרה</th></tr>${done.map(taskRow).join('')}</table>` : '<p class="dim">עדיין לא הושלמו משימות.</p>'}
    </section>
    ${renderPrefsForUser(prefs, u, csrf)}
    ${renderFactsForUser(factRows, u, csrf)}
    ${await renderDeletePanel(client, u, confirmDelete, csrf)}`;
}

module.exports = { renderPrefsForUser, renderFactsForUser, renderConversation, renderDeletePanel, renderPauseBanner, renderUserPage };
