'use strict';
// onboarding — one section of the admin page (see ../index.js).
//
// What a new person's first hours actually looked like, checked by code
// (domain/onboarding-review.js) — once three hours in, once again after the
// first full day. This is the page that review was built for: a report nobody
// reads is not a review.
const { ago } = require('../html');
const { esc } = require('../../html');

// Which read this row is. The day row reports only what the three-hour one
// had not already seen, so the two rows for one person are a sequence, not a
// disagreement.
const STAGE_LABEL = { '3h': 'אחרי 3 שעות', '1d': 'אחרי יום' };

const WORST_LABEL = {
  bad: 'תקלה מול המשתמש', warn: 'שווה בדיקה', note: 'לתשומת לב', clean: 'תקין',
};

// Written out rather than derived from the check id, so the page stays
// readable to somebody who has never opened the checks file.
const FINDING_LABEL = {
  promised_time_not_armed: 'נאמרה שעה שלא נקבעה לה תזכורת',
  wrong_day_word: 'נאמר "מחר"/"היום" על יום אחר',
  reminder_chased: 'תזכורת יצאה יותר מפעם אחת ולא נעשה איתה כלום',
  proactive_pile_up: 'שתי הודעות יזומות אחת אחרי השנייה',
  refusal_without_issue: 'נאמר שאי אפשר, ולא נפתחה בקשה',
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
  if (f.id === 'wrong_day_word') return `${esc(d.said || '')} · נאמר על ${esc(d.meant || '')}, בפועל ${esc(d.actually || '')}`;
  if (f.id === 'reminder_chased') return (d.reminders || []).map((r) => `#${r.id} ×${r.attempts}`).join(' · ');
  if (f.id === 'proactive_pile_up') return `${esc((d.first || {}).rung || '')} → ${esc((d.second || {}).rung || '')}`;
  if (f.id === 'refusal_without_issue') return esc(String(d.text || '').slice(0, 90));
  if (f.id === 'check_failed') return esc(d.error || '');
  return '';
}

async function renderOnboardingReviews(client) {
  const { rows } = await client.query(
    `SELECT r.id, r.user_id, r.stage, r.reviewed_at, r.worst, r.findings, r.acknowledged_at,
            u.first_name, u.phone
       FROM onboarding_reviews r JOIN users u ON u.id = r.user_id
      ORDER BY r.reviewed_at DESC LIMIT 15`
  );
  if (!rows.length) {
    return '<p class="dim">עוד לא נבדקה הצטרפות. הבדיקה רצה שלוש שעות אחרי ההודעה הראשונה של כל משתמש חדש, ושוב אחרי היום הראשון.</p>';
  }
  return `<table>
    <tr><th>מי</th><th>איזו בדיקה</th><th>הכי חמור</th><th>מה נמצא</th><th>מתי נבדק</th></tr>
    ${rows.map((r) => {
    const findings = Array.isArray(r.findings) ? r.findings : [];
    return `<tr>
      <td><a href="/user?id=${r.user_id}">${esc(r.first_name || r.phone)}</a></td>
      <td class="dim small nowrap">${esc(STAGE_LABEL[r.stage] || r.stage || '')}</td>
      <td><span class="pill ${r.worst === 'bad' ? 'warn' : ''}">${WORST_LABEL[r.worst] || esc(r.worst)}</span></td>
      <td>${findings.length === 0 ? `<span class="dim">${r.stage === '1d' ? 'כלום חדש ✓' : 'כלום ✓'}</span>` : findings.map((f) => `
        <div>${esc(FINDING_LABEL[f.id] || f.id)}<span class="dim small"> ${detailLine(f)}</span></div>`).join('')}</td>
      <td class="dim small nowrap">${ago(r.reviewed_at)}</td></tr>`;
  }).join('')}</table>`;
}

module.exports = { renderOnboardingReviews, WORST_LABEL, FINDING_LABEL, STAGE_LABEL };
