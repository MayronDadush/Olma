'use strict';
// onboarding — one section of the admin page (see ../index.js).
//
// What a new person's first three hours actually looked like, checked by code
// (domain/onboarding-review.js) three hours after their first message. This is
// the page that review was built for: a report nobody reads is not a review.
const { ago } = require('../html');
const { esc } = require('../../html');

const WORST_LABEL = {
  bad: 'תקלה מול המשתמש', warn: 'שווה בדיקה', note: 'לתשומת לב', clean: 'תקין',
};

// Written out rather than derived from the check id, so the page stays
// readable to somebody who has never opened the checks file.
const FINDING_LABEL = {
  promised_time_not_armed: 'נאמרה שעה שלא נקבעה לה תזכורת',
  dropped_turn: 'הודעה שלו לא קיבלה שום תשובה',
  tools_failed: 'כלים נכשלו בזמן השיחה הראשונה',
  deployed_during_onboarding: 'עלתה גרסה באמצע ההצטרפות',
  nothing_learned: 'שיחה שלמה ולא נשמרה אף עובדה',
  tasks_nobody_confirmed: 'משימות שנוצרו מזיהוי אוטומטי, בלי אישור',
  calendar_opening_missed: 'היו כמה דברים עם תאריך, והיומן לא הוצע',
  timezone_unconfirmed: 'אזור הזמן עדיין ניחוש לפי קידומת',
  said_what_the_mark_said: 'משפט אישור מתחת לסימון שכבר אמר את זה',
  check_failed: 'בדיקה נכשלה',
};

function detailLine(f) {
  const d = f.detail || {};
  if (f.id === 'promised_time_not_armed') {
    return `נאמר ${esc((d.said || []).join(', '))} · נקבע ${esc((d.armed || []).join(', ') || '—')}`;
  }
  if (f.id === 'dropped_turn') return `${(d.messages || []).length} הודעות · תוקנו ${d.repaired || 0}`;
  if (f.id === 'tools_failed') return `${d.count} כשלים`;
  if (f.id === 'tasks_nobody_confirmed') return (d.tasks || []).map((t) => t.title).join(' · ');
  if (f.id === 'calendar_opening_missed') return `${d.datedTasks} פריטים עם תאריך`;
  if (f.id === 'said_what_the_mark_said') return esc(d.line || '');
  if (f.id === 'check_failed') return esc(d.error || '');
  return '';
}

async function renderOnboardingReviews(client) {
  const { rows } = await client.query(
    `SELECT r.id, r.user_id, r.reviewed_at, r.worst, r.findings, r.acknowledged_at,
            u.first_name, u.phone
       FROM onboarding_reviews r JOIN users u ON u.id = r.user_id
      ORDER BY r.reviewed_at DESC LIMIT 15`
  );
  if (!rows.length) {
    return '<p class="dim">עוד לא נבדקה הצטרפות. הבדיקה רצה שלוש שעות אחרי ההודעה הראשונה של כל משתמש חדש.</p>';
  }
  return `<table>
    <tr><th>מי</th><th>הכי חמור</th><th>מה נמצא</th><th>מתי נבדק</th></tr>
    ${rows.map((r) => {
    const findings = Array.isArray(r.findings) ? r.findings : [];
    return `<tr>
      <td><a href="/user?id=${r.user_id}">${esc(r.first_name || r.phone)}</a></td>
      <td><span class="pill ${r.worst === 'bad' ? 'warn' : ''}">${WORST_LABEL[r.worst] || esc(r.worst)}</span></td>
      <td>${findings.length === 0 ? '<span class="dim">כלום ✓</span>' : findings.map((f) => `
        <div>${esc(FINDING_LABEL[f.id] || f.id)}<span class="dim small"> ${detailLine(f)}</span></div>`).join('')}</td>
      <td class="dim small nowrap">${ago(r.reviewed_at)}</td></tr>`;
  }).join('')}</table>`;
}

module.exports = { renderOnboardingReviews, WORST_LABEL, FINDING_LABEL };
