'use strict';
// brain — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('../html');
const { esc } = require('../../html');

// ---- the brain --------------------------------------------------------------
// Two halves of one question: what has Olma actually learned about these
// people, and what is she stuck waiting on.
//
// The waiting half exists because of a real incident (2026-08-19). A connection
// request sat in the outbox, was never delivered, and nobody answered it — and
// there was no screen anywhere that would have shown a person waiting, because
// the queue view only shows what is queued. Once a message has gone out, the
// system's half is done and the wait becomes invisible. Every row below is a
// place where a human owes an answer.
const WAITING_LABEL = {
  connection_pending: 'בקשת חברות',
  connection_invited: 'הזמנה לאדם שאינו רשום',
  meeting_awaiting: 'תשובה על מועד פגישה',
  share_pending: 'הצעת שיתוף משימה',
};

// Old enough that a person has almost certainly forgotten, rather than being
// mid-thought. Colours the row; does not act on it.
const WAITING_STALE_MS = 24 * 3600_000;

async function renderBrain(client) {
  const { rows: waiting } = await client.query(
    `SELECT 'connection_pending' AS kind, c.id AS ref, c.requester_id AS asker_id,
            coalesce(ru.first_name, ru.phone) AS asker,
            coalesce(tu.first_name, c.target_phone) AS blocked_on,
            c.invited_at AS since, c.invite_reason AS detail
       FROM connections c
       JOIN users ru ON ru.id = c.requester_id
       LEFT JOIN users tu ON tu.id = c.target_id
      WHERE c.status = 'pending_target'
     UNION ALL
     SELECT 'connection_invited', c.id, c.requester_id,
            coalesce(ru.first_name, ru.phone), c.target_phone, c.invited_at, c.invite_reason
       FROM connections c JOIN users ru ON ru.id = c.requester_id
      WHERE c.status = 'invited'
     UNION ALL
     SELECT 'meeting_awaiting', m.id, m.initiator_id,
            coalesce(iu.first_name, iu.phone), coalesce(pu.first_name, pu.phone),
            m.updated_at, m.title
       FROM meeting_participants mp
       JOIN meetings m ON m.id = mp.meeting_id
       JOIN users iu ON iu.id = m.initiator_id
       JOIN users pu ON pu.id = mp.user_id
      WHERE mp.state = 'awaiting' AND m.status = 'negotiating'
     UNION ALL
     SELECT 'share_pending', s.id, s.owner_id,
            coalesce(ou.first_name, ou.phone), coalesce(vu.first_name, vu.phone),
            s.created_at, t.title
       FROM shares s
       JOIN users ou ON ou.id = s.owner_id
       JOIN users vu ON vu.id = s.viewer_id
       JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending_viewer'
      ORDER BY since`);

  const { rows: recent } = await client.query(
    `SELECT f.category, f.fact, f.importance, f.source, f.learned_at,
            f.user_id, coalesce(u.first_name, u.phone) AS who
       FROM user_facts f JOIN users u ON u.id = f.user_id
      WHERE f.active AND (f.expires_at IS NULL OR f.expires_at > now())
      ORDER BY f.learned_at DESC LIMIT 12`);

  const { rows: perUser } = await client.query(
    `SELECT u.id, coalesce(u.first_name, u.phone) AS who,
            u.last_fact_extraction_at, u.last_inbound_at,
            (SELECT count(*)::int FROM user_facts f
              WHERE f.user_id = u.id AND f.active
                AND (f.expires_at IS NULL OR f.expires_at > now())) AS facts,
            (SELECT count(*)::int FROM user_preferences p WHERE p.user_id = u.id) AS prefs
       FROM users u WHERE u.status = 'active' ORDER BY u.id`);

  // Whether someone is due comes from the job's own constant, not a second copy
  // of "30 minutes" living here — two numbers that must agree is one too many.
  const { CHAPTER_GAP_MS } = require('../../../../jobs/fact-extraction');
  const isDue = (u) => {
    if (!u.last_inbound_at) return false;
    const inbound = new Date(u.last_inbound_at).getTime();
    const mark = u.last_fact_extraction_at ? new Date(u.last_fact_extraction_at).getTime() : 0;
    return inbound > mark && Date.now() - inbound > CHAPTER_GAP_MS;
  };

  const IMPORTANCE = { 1: '', 2: '· חשובה', 3: '· ליבה' };
  const SOURCE = { conversation: 'מהשיחה', user_stated: 'נאמר במפורש', admin: 'הוזן ידנית' };

  const waitingHtml = waiting.length ? `<table>
      <tr><th>מה</th><th>מי מחכה</th><th>למי</th><th>על מה</th><th>כמה זמן</th></tr>
      ${waiting.map((r) => {
        const age = Date.now() - new Date(r.since).getTime();
        return `<tr${age > WAITING_STALE_MS ? ' class="bad"' : ''}>
          <td class="small">${WAITING_LABEL[r.kind] || esc(r.kind)}</td>
          <td><a href="/user?id=${r.asker_id}">${esc(r.asker)}</a></td>
          <td class="small">${esc(r.blocked_on || '—')}</td>
          <td class="dim small">${r.detail ? esc(String(r.detail).slice(0, 50)) : '—'}</td>
          <td class="nowrap small">${ago(r.since)}</td></tr>`;
      }).join('')}</table>
      <p class="hint">אלה מצבים שבהם המערכת עשתה את שלה ואדם עדיין לא ענה. הם אינם מופיעים
        ב"מה מתוכנן להישלח" — שם רואים רק מה שעדיין בתור. שורה אדומה = ממתינה יותר מיממה.</p>`
    : '<p class="dim">אף אחד לא ממתין לתשובה. זה המצב הבריא.</p>';

  const recentHtml = recent.length ? `<table>
      <tr><th>מתי</th><th>על מי</th><th>קטגוריה</th><th>מה נלמד</th><th>מקור</th></tr>
      ${recent.map((f) => `<tr>
        <td class="dim small nowrap">${ago(f.learned_at)}</td>
        <td><a href="/user?id=${f.user_id}">${esc(f.who)}</a></td>
        <td class="mono small">${esc(f.category)} <span class="dim">${IMPORTANCE[f.importance] || ''}</span></td>
        <td class="small">${esc(f.fact)}</td>
        <td class="dim small">${SOURCE[f.source] || esc(f.source || '')}</td>
      </tr>`).join('')}</table>`
    : '<p class="dim">עדיין לא נלמדו עובדות. הן נצברות מרגע שאנשים מתכתבים.</p>';

  const perUserHtml = `<table>
      <tr><th>משתמש</th><th>עובדות</th><th>העדפות</th><th>נקרא לאחרונה</th></tr>
      ${perUser.map((u) => `<tr>
        <td><a href="/user?id=${u.id}">${esc(u.who)}</a></td>
        <td class="num">${u.facts}</td>
        <td class="num">${u.prefs}</td>
        <td class="dim small nowrap">${u.last_fact_extraction_at ? ago(u.last_fact_extraction_at) : 'אף פעם'}${
          isDue(u) ? ' <span class="pill">שיחה ממתינה לקריאה</span>' : ''}</td>
      </tr>`).join('')}</table>
      <p class="hint">"נקרא לאחרונה" הוא מתי המערכת קראה את השיחה שלהם וחילצה ממנה עובדות.
        "שיחה ממתינה לקריאה" = הם כתבו משהו שטרם נקרא, והפרק שלהם כבר נסגר.</p>`;

  const totals = perUser.reduce((a, u) => ({ facts: a.facts + u.facts, prefs: a.prefs + u.prefs }), { facts: 0, prefs: 0 });
  return `<div class="stats">
      <div class="stat"><div class="num">${waiting.length}</div><div class="lbl">ממתינים לתשובה</div></div>
      <div class="stat"><div class="num">${totals.facts}</div><div class="lbl">עובדות</div></div>
      <div class="stat"><div class="num">${totals.prefs}</div><div class="lbl">העדפות</div></div>
    </div>
    <h4>ממתין לתשובה של אדם</h4>${waitingHtml}
    <h4>מה נלמד לאחרונה</h4>${recentHtml}
    <h4>הזיכרון לפי משתמש</h4>${perUserHtml}`;
}

// ---- admin edits ------------------------------------------------------------

module.exports = { WAITING_LABEL, WAITING_STALE_MS, renderBrain };
