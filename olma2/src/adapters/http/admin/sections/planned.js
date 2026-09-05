'use strict';
// planned — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('../html');
const { esc } = require('../../html');

const OUTBOX_STATE = {
  sent: 'נשלחו', ready: 'ממתינות לשליחה',
  night: 'ממתינות לשעה מתאימה', blocked: 'ממתינות (המשתמש במכסה)',
  budget: 'יצטרפו לסיכום הבא', expired: 'פג תוקפן',
  settling: 'ממתינות לייצוב המערכת',
  cancelled_by_admin: 'בוטל ע"י מנהל',
};

// Cancelling is a WRITE, never a DELETE. The row carries the idempotency_key
// that stops the sweep which created it from creating it again — delete the
// row and the next tick simply re-queues the same message. So a cancellation
// marks it as already handled (sent_at set, reason recorded) and it stays
// visible as cancelled rather than vanishing.
const CANCELLED_BY_ADMIN = 'cancelled_by_admin';

// Plain-Hebrew name per outbox kind. The dashboard should never make anyone
// learn an internal identifier to understand what Olma is about to say.
const KIND_LABELS = {
  checkin: 'פנייה יזומה',
  reminder: 'תזכורת',
  digest: 'סיכום יומי',
  unblock_summary: 'סיכום אחרי מכסה',
  registration_reopened: 'ההרשמה נפתחה',
  connection_intro: 'הצגה למוזמן',
  connection_request: 'בקשת חברות',
  connection_response: 'תשובה לבקשת חברות',
  share_offer: 'הצעת שיתוף משימה',
  share_response: 'תשובה להצעת שיתוף',
  meeting_invite: 'תיאום פגישה',
  meeting_slot_proposed: 'הצעת מועד לפגישה',
  meeting_confirmed: 'פגישה אושרה',
  meeting_slot_declined: 'מועד נדחה',
  meeting_opt_out: 'יציאה מפגישה',
  meeting_withdrawn: 'ביטול הגעה לפגישה',
  meeting_no_match: 'לא נמצא מועד',
  meeting_cancelled: 'פגישה בוטלה',
  calendar_connected: 'יומן חובר',
  calendar_scope_missing: 'חיבור יומן בלי הרשאה — צריך שוב',
  calendar_needs_reauth: 'צריך לחבר יומן מחדש',
  contacts_connected: 'אנשי קשר חוברו',
  contacts_scope_missing: 'חיבור אנשי קשר בלי הרשאה — צריך שוב',
  contacts_needs_reauth: 'צריך לחבר אנשי קשר מחדש',
  google_connect_incomplete: 'חיבור גוגל משולב — חלק לא אושר',
};

// Why a proactive message was chosen — the checkin ladder's rung.
const RUNG_LABELS = {
  onboarding_15m: 'היכרות · 15 דקות',
  onboarding_2h: 'היכרות · שעתיים',
  onboarding_5h: 'היכרות · 5 שעות',
  stuck_meeting: 'פגישה שממתינה לו',
  deadline_risk: 'דדליין מתקרב',
  overload: 'עומס משימות',
  silence: 'שקט ממושך',
  unanswered_repair: 'תיקון הודעה שלא נענתה',
  admin: 'נכתב ידנית מלוח הבקרה',
};

function userLink(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone;
  return `<a href="/user?id=${u.user_id || u.id}">${esc(name)}</a>`;
}

// What a queued row is ABOUT. The payload holds an instruction for the agent,
// never the finished text (the v1 stale-digest rule), so this is deliberately
// a subject line and not a preview — claiming otherwise would be a lie the
// moment the agent words it differently.
function plannedSubject(row) {
  const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  if (row.kind === 'reminder' && p.title) return esc(p.title);
  // An operator-written message is the one case where the payload IS worth
  // showing: a person typed it minutes ago and wants to check what they typed.
  // Everything else is an instruction the agent will reword, so showing it
  // would promise wording we cannot keep.
  if (p.rung === 'admin' && p.checkinInstruction) return esc(String(p.checkinInstruction).slice(0, 90));
  if (row.kind === 'checkin' && p.rung) return RUNG_LABELS[p.rung] || esc(p.rung);
  if (p.title) return esc(String(p.title).slice(0, 60));
  return '<span class="dim">—</span>';
}

// The 7-day outbox rollup and the failures table used to be their own section
// ("הודעות יוצאות"); they are about the same queue this section shows, so they
// lead it as one block. renderOutbox is unchanged below.
async function renderPlanned(client) {
  return `<h4>הודעות יוצאות — 7 ימים אחרונים</h4>${await renderOutbox(client)}${await renderPlannedQueue(client)}`;
}

async function renderPlannedQueue(client) {
  // 1. Already queued: minutes away, or held by the delivery gate.
  const { rows: queued } = await client.query(
    `SELECT o.id, o.kind, o.urgency, o.hold_reason, o.attempts, o.payload, o.expires_at,
            o.user_id, u.first_name, u.last_name, u.phone,
            to_char(o.release_after AT TIME ZONE COALESCE(u.timezone, 'UTC'), 'DD/MM HH24:MI') AS local_release
     FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.sent_at IS NULL
     ORDER BY COALESCE(o.release_after, o.created_at) LIMIT 40`);

  // 2. Scheduled ahead: the reminders people actually asked for. These have
  //    no outbox row yet — the sweep creates one when they come due, which is
  //    why a queue-only view would look almost empty and mean almost nothing.
  const { rows: reminders } = await client.query(
    `SELECT r.id, r.repeat_rule, r.attempts, t.title, u.id AS user_id, u.first_name, u.last_name, u.phone,
            to_char(r.remind_at AT TIME ZONE COALESCE(u.timezone, 'UTC'), 'DD/MM HH24:MI') AS local_time,
            -- Overdue means "its moment passed and nothing went out". A row
            -- mid-escalation HAS gone out and is waiting on its next rung;
            -- flagging it red would send an operator hunting a working system.
            r.remind_at < now() AND r.attempts = 0 AS overdue
     FROM task_reminders r
     JOIN tasks t ON t.id = r.task_id
     JOIN users u ON u.id = t.owner_id
     WHERE r.sent_at IS NULL AND r.cancelled_at IS NULL
     ORDER BY r.remind_at LIMIT 40`);

  // 3. Standing: the daily digest each person chose, in their own local time.
  const { rows: digests } = await client.query(
    `SELECT id, first_name, last_name, phone, digest_times, digest_scope, timezone
     FROM users
     WHERE status = 'active' AND digest_times IS NOT NULL AND digest_times <> ''
     ORDER BY id`);

  const queuedHtml = queued.length ? `<table>
      <tr><th>למי</th><th>סוג</th><th>בנושא</th><th>מתי</th><th>מצב</th></tr>
      ${queued.map((r) => `<tr${r.attempts > 0 ? ' class="bad"' : ''}>
        <td>${userLink(r)}</td>
        <td>${KIND_LABELS[r.kind] || esc(r.kind)}</td>
        <td class="small">${plannedSubject(r)}</td>
        <td class="nowrap small">${r.local_release ? esc(r.local_release) : '<span class="dim">מיד</span>'}</td>
        <td class="small">${r.hold_reason ? (OUTBOX_STATE[r.hold_reason] || esc(r.hold_reason))
          : (r.attempts > 0 ? `נסיון ${r.attempts}` : '<span class="dim">בדרך</span>')}</td>
      </tr>`).join('')}</table>`
    : '<p class="dim">אין כרגע הודעה בתור.</p>';

  const remindersHtml = reminders.length ? `<table>
      <tr><th>למי</th><th>על מה</th><th>מתי</th><th>חוזר</th></tr>
      ${reminders.map((r) => `<tr>
        <td>${userLink(r)}</td>
        <td class="small">${esc(r.title)}</td>
        <td class="nowrap small">${esc(r.local_time)}${r.overdue ? ' <span class="pill">באיחור</span>' : ''}</td>
        <td class="dim small">${r.repeat_rule ? esc(r.repeat_rule) : '—'}${
          r.attempts > 0 ? ` <span class="dim">· נשלחה ${r.attempts}×</span>` : ''}</td>
      </tr>`).join('')}</table>`
    : '<p class="dim">אין תזכורות מתוזמנות.</p>';

  const digestHtml = digests.length ? `<table>
      <tr><th>למי</th><th>שעות</th><th>היקף</th><th>אזור זמן</th></tr>
      ${digests.map((u) => `<tr>
        <td>${userLink(u)}</td>
        <td class="mono small">${esc(u.digest_times)}</td>
        <td class="small">${esc(u.digest_scope || 'summary')}</td>
        <td class="dim small">${esc(u.timezone || 'UTC')}</td>
      </tr>`).join('')}</table>`
    : '<p class="dim">אף אחד לא הגדיר סיכום יומי.</p>';

  return `<h4>בתור עכשיו — דקות מכאן</h4>${queuedHtml}
    <h4>תזכורות מתוזמנות — נכנסות לתור כשיגיע זמנן</h4>${remindersHtml}
    <h4>סיכום יומי קבוע</h4>${digestHtml}
    <p class="hint">השעות הן בשעון המקומי של כל משתמש. הן עשויות לזוז: הודעה
      שנופלת בשעות השקט שלו תמתין לבוקר, ומי שכבר קיבל מספיק הודעות היום —
      שלו תצטרף לסיכום הבא.</p>`;
}

// The same question narrowed to one person: what is Olma about to say to
// THEM. Same honesty as the global view — subjects, not drafts.
async function renderPlannedForUser(client, u, csrf = '') {
  const back = `/user?id=${u.id}`;
  // Times are read out and written back in the PERSON's timezone, not the
  // operator's: "09:00" on this page has to mean the same 09:00 the message
  // will actually arrive at. The conversion is left to Postgres in both
  // directions (AT TIME ZONE), so there is no hand-rolled offset arithmetic to
  // get wrong around DST.
  const { rows: queued } = await client.query(
    `SELECT o.id, o.kind, o.hold_reason, o.attempts, o.payload,
            to_char(o.release_after AT TIME ZONE COALESCE($2, 'UTC'), 'DD/MM HH24:MI') AS local_release,
            to_char(o.release_after AT TIME ZONE COALESCE($2, 'UTC'), 'YYYY-MM-DD"T"HH24:MI') AS release_input,
            to_char(o.expires_at   AT TIME ZONE COALESCE($2, 'UTC'), 'YYYY-MM-DD"T"HH24:MI') AS expires_input
     FROM outbox o WHERE o.user_id = $1 AND o.sent_at IS NULL
     ORDER BY COALESCE(o.release_after, o.created_at) LIMIT 15`, [u.id, u.timezone]);
  const { rows: cancelled } = await client.query(
    `SELECT id, kind, payload, sent_at FROM outbox
      WHERE user_id = $1 AND hold_reason = $2 ORDER BY id DESC LIMIT 5`, [u.id, CANCELLED_BY_ADMIN]);
  const { rows: reminders } = await client.query(
    `SELECT t.title, r.repeat_rule,
            to_char(r.remind_at AT TIME ZONE COALESCE($2, 'UTC'), 'DD/MM HH24:MI') AS local_time
     FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
     ORDER BY r.remind_at LIMIT 15`, [u.id, u.timezone]);

  const hidden = `<input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="back" value="${back}">`;

  const queuedHtml = queued.length ? `<h4>בתור</h4>
    <table><tr><th>סוג</th><th>בנושא</th><th>מתי (שעון שלו)</th><th>פג תוקף</th><th>מצב</th><th></th></tr>
    ${queued.map((r) => `<tr${r.attempts > 0 ? ' class="bad"' : ''}>
      <td>${KIND_LABELS[r.kind] || esc(r.kind)}</td>
      <td class="small">${plannedSubject(r)}</td>
      <td colspan="2"><form method="post" action="/outbox/reschedule" class="inline">${hidden}
        <input type="hidden" name="id" value="${r.id}">
        <input type="datetime-local" name="release_after" value="${esc(r.release_input || '')}"
               title="ריק = לשלוח בהזדמנות הקרובה">
        <input type="datetime-local" name="expires_at" value="${esc(r.expires_input || '')}"
               title="אחרי המועד הזה ההודעה כבר לא תישלח. ריק = בלי תפוגה.">
        <button>שמור מועד</button></form></td>
      <td class="small">${r.hold_reason ? (OUTBOX_STATE[r.hold_reason] || esc(r.hold_reason)) : '<span class="dim">בדרך</span>'}</td>
      <td><form method="post" action="/outbox/cancel" class="inline">${hidden}
        <input type="hidden" name="id" value="${r.id}">
        <button class="danger">בטל</button></form></td>
    </tr>`).join('')}</table>` : '';

  const cancelledHtml = cancelled.length ? `<h4>בוטלו ע"י מנהל</h4>
    <table><tr><th>סוג</th><th>בנושא</th><th>מתי בוטל</th></tr>
    ${cancelled.map((r) => `<tr><td class="dim">${KIND_LABELS[r.kind] || esc(r.kind)}</td>
      <td class="small dim">${plannedSubject(r)}</td>
      <td class="dim small nowrap">${ago(r.sent_at)}</td></tr>`).join('')}</table>
    <p class="hint">שורה שבוטלה נשארת במקומה בכוונה — היא זו שמונעת מהתהליך שיצר אותה
      ליצור אותה שוב. היא לא נשלחה ואינה נספרת במכסת ההודעות היומית שלו.</p>` : '';

  const composeHtml = `<h4>לכתוב הודעה יזומה</h4>
    <form method="post" action="/outbox/new">${hidden}
      <input type="hidden" name="user_id" value="${u.id}">
      <p><textarea name="instruction" rows="2" style="width:100%"
         placeholder="מה אולמה צריכה לעשות — למשל: שאלי אותו איך הלך הראיון אתמול"></textarea></p>
      <p class="small">
        <label>דחיפות
          <select name="urgency">
            <option value="normal">רגילה — מכבדת את המכסה היומית</option>
            <option value="urgent">דחופה — עוקפת מכסה, לא עוקפת שעות שקט</option>
          </select></label>
        <label>מתי <input type="datetime-local" name="release_after" title="ריק = בהקדם"></label>
        <button>הוסף לתור</button>
      </p>
      <p class="hint">זו הנחיה לאולמה, לא טקסט שיישלח כלשונו — היא תנסח בעצמה, בשפה שלו.
        ההודעה עוברת את אותו שער כיבוד כמו כל הודעה יזומה: אם השעה אצלו שעת שקט
        היא תמתין לבוקר, ואם הוא כבר קיבל מספיק היום היא תצטרף לסיכום הבא.</p>
    </form>`;

  return `<section><h3>מה מתוכנן להישלח אליו</h3>
    <p class="hint">בשעון המקומי שלו (${esc(u.timezone || 'UTC')}). הנוסח נכתב ברגע השליחה — כאן הנושא בלבד.</p>
    ${queued.length ? queuedHtml : '<p class="dim">אין כרגע הודעה בתור.</p>'}
    ${reminders.length ? `<h4>תזכורות מתוזמנות</h4><table><tr><th>על מה</th><th>מתי</th><th>חוזר</th></tr>
      ${reminders.map((r) => `<tr><td class="small">${esc(r.title)}</td>
        <td class="nowrap small">${esc(r.local_time)}</td>
        <td class="dim small">${r.repeat_rule ? esc(r.repeat_rule) : '—'}</td></tr>`).join('')}</table>` : ''}
    ${u.digest_times ? `<h4>סיכום יומי</h4><p class="small">כל יום ב-<span class="mono">${esc(u.digest_times)}</span></p>` : ''}
    ${cancelledHtml}
    ${composeHtml}
  </section>`;
}

// ---- what Olma learned, editable ---------------------------------------------
// Preferences and facts are two different things and are shown as two tables,
// because confusing them is the most likely operator mistake: a preference
// steers how Olma behaves, a fact is something true about the person.

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

module.exports = { OUTBOX_STATE, CANCELLED_BY_ADMIN, KIND_LABELS, RUNG_LABELS, userLink, plannedSubject, renderPlanned, renderPlannedQueue, renderPlannedForUser, renderOutbox };
