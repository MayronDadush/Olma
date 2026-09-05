'use strict';
// outcomes — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { fmt, ago } = require('../html');
const { correctionSql } = require('../../../../jobs/metrics');
const { esc } = require('../../html');

// ---- does it actually work --------------------------------------------------
// The metrics D-005 chose, which nobody had built — "a decision without
// measurement is an opinion". א/ב/ד came first; ג (C-003, the correction rate)
// was added 2026-08-20 after two real incidents proved the need for it.
// Deliberately separate from the usage section below it: that one counts what
// happened, this one asks whether it worked.
//
// Every number here states its denominator. A rate on its own invites reading
// "0%" as failure when the truth is "nothing has been measured yet", and those
// two need to look different at a glance.
const HABIT_DAYS = 7;

const CLOSURE_WINDOW_DAYS = 14;

async function renderOutcomes(client) {
  // A — did people answer what Olma sent them, within a day.
  const { rows: since } = await client.query(
    `SELECT min(created_at) AS started FROM audit_log WHERE event = 'message.received'`);
  const measuringSince = since[0].started;

  const { rows: agg } = await client.query(
    `SELECT coalesce(sum(value) FILTER (WHERE metric = 'proactive_sent'), 0)     AS sent,
            coalesce(sum(value) FILTER (WHERE metric = 'proactive_answered'), 0) AS answered
       FROM product_metrics_daily WHERE date > CURRENT_DATE - $1::int`, [HABIT_DAYS + 1]);

  const { rows: perUserA } = await client.query(
    `SELECT u.id, coalesce(u.first_name, u.phone) AS who,
            count(o.*) AS sent,
            count(o.*) FILTER (WHERE EXISTS (
              SELECT 1 FROM audit_log a
               WHERE a.actor_id = o.user_id AND a.event = 'message.received'
                 AND a.created_at > o.sent_at
                 AND a.created_at <= o.sent_at + interval '24 hours')) AS answered
       FROM users u
       LEFT JOIN outbox o ON o.user_id = u.id AND o.hold_reason IS NULL
            AND o.sent_at IS NOT NULL
            AND o.sent_at > coalesce($1::timestamptz, now())
      WHERE u.status = 'active'
      GROUP BY u.id, who ORDER BY u.id`, [measuringSince]);

  // B — of the tasks old enough to judge, how many were closed in time. A task
  // created yesterday cannot fail a two-week window yet, so it is not in the
  // cohort at all; including it would drag the number down for no reason.
  const { rows: closure } = await client.query(
    `SELECT count(*) AS cohort,
            count(*) FILTER (WHERE completed_at IS NOT NULL
                               AND completed_at <= created_at + ($1::int * interval '1 day')) AS closed
       FROM tasks WHERE archived_at IS NULL AND created_at < now() - ($1::int * interval '1 day')`,
    [CLOSURE_WINDOW_DAYS]);

  // C — corrections (מדד C). How often what Olma remembered had to be fixed.
  // Two real incidents made this a metric: a user correcting a fact that had
  // been saved about them, and a meeting confirmed on the wrong day that the
  // admin repaired by hand. What counts as a correction is defined ONCE, in
  // jobs/metrics.js (correctionSql) — the daily rollup and this live table
  // share the fragments, so they cannot drift apart.
  const { rows: corrAgg } = await client.query(
    `SELECT coalesce(sum(value) FILTER (WHERE metric = 'facts_corrected'), 0)        AS facts_fixed,
            coalesce(sum(value) FILTER (WHERE metric = 'preferences_corrected'), 0)  AS prefs_fixed,
            coalesce(sum(value) FILTER (WHERE metric = 'facts_remembered'), 0)       AS facts_written,
            coalesce(sum(value) FILTER (WHERE metric = 'preferences_remembered'), 0) AS prefs_written,
            coalesce(sum(value) FILTER (WHERE metric = 'admin_corrections'), 0)      AS admin_fixed
       FROM product_metrics_daily WHERE date > CURRENT_DATE - $1::int`, [HABIT_DAYS + 1]);

  const { rows: perUserC } = await client.query(
    `SELECT u.id, coalesce(u.first_name, u.phone) AS who,
            count(*) FILTER (WHERE a.event = 'fact.remembered')       AS facts_written,
            count(*) FILTER (WHERE ${correctionSql.fact('a')})        AS facts_fixed,
            count(*) FILTER (WHERE a.event = 'preference.remembered') AS prefs_written,
            count(*) FILTER (WHERE ${correctionSql.preference('a')})  AS prefs_fixed,
            count(*) FILTER (WHERE ${correctionSql.admin('a')})       AS admin_fixed
       FROM users u
       LEFT JOIN audit_log a ON a.actor_id = u.id
      WHERE u.status = 'active'
      GROUP BY u.id, who ORDER BY u.id`);

  // D — habit. Inbound volume per person from the quota ledger, which has been
  // counting since long before any of this.
  const { rows: habit } = await client.query(
    `SELECT u.id, coalesce(u.first_name, u.phone) AS who, u.last_inbound_at,
            coalesce(sum(q.count), 0) AS msgs,
            count(q.*) FILTER (WHERE q.count > 0) AS active_days
       FROM users u
       LEFT JOIN quota_counters q ON q.user_id = u.id AND q.window_kind = 'day'
            AND q.window_start > now() - ($1::int * interval '1 day')
      WHERE u.status = 'active'
      GROUP BY u.id, who, u.last_inbound_at ORDER BY u.id`, [HABIT_DAYS]);

  const pct = (n, d) => (Number(d) > 0 ? `${Math.round((Number(n) / Number(d)) * 100)}%` : '—');
  const ofTotal = (n, d) => `<span class="dim small">${fmt(n)} מתוך ${fmt(d)}</span>`;

  const aHtml = !measuringSince
    ? `<p class="dim">המדידה טרם התחילה — היא נפתחת ברגע שמישהו כותב לאולמה מעכשיו.</p>`
    : `<div class="stats">
        <div class="stat"><div class="num">${pct(agg[0].answered, agg[0].sent)}</div>
          <div class="lbl">ענו תוך יממה · ${HABIT_DAYS} ימים</div></div>
      </div>
      <table><tr><th>משתמש</th><th>נשלחו</th><th>נענו</th><th>שיעור</th></tr>
      ${perUserA.map((r) => `<tr>
        <td><a href="/user?id=${r.id}">${esc(r.who)}</a></td>
        <td class="num">${fmt(r.sent)}</td>
        <td class="num">${fmt(r.answered)}</td>
        <td class="num">${pct(r.answered, r.sent)}</td></tr>`).join('')}</table>
      <p class="hint">"נענו" = האדם כתב לאולמה בתוך 24 שעות מרגע שההודעה יצאה. נספרות רק
        הודעות שנשלחו מאז ${esc(String(measuringSince).slice(0, 16))} — לפני כן לא נשמר תיעוד
        של הודעות נכנסות, ולספור אותן היה מציג כל אחת מהן כאילו התעלמו ממנה.</p>`;

  const bHtml = Number(closure[0].cohort) === 0
    ? `<p class="dim">אף משימה עדיין לא בת ${CLOSURE_WINDOW_DAYS} יום, אז אין מה למדוד.
        זה לא אפס — זה מוקדם מדי.</p>`
    : `<div class="stats">
        <div class="stat"><div class="num">${pct(closure[0].closed, closure[0].cohort)}</div>
          <div class="lbl">נסגרו תוך ${CLOSURE_WINDOW_DAYS} יום</div></div>
      </div><p class="small">${ofTotal(closure[0].closed, closure[0].cohort)} מהמשימות שכבר
        עברו את החלון.</p>`;

  const cFixed = Number(corrAgg[0].facts_fixed) + Number(corrAgg[0].prefs_fixed);
  const cWritten = Number(corrAgg[0].facts_written) + Number(corrAgg[0].prefs_written);
  const nothingLearnedYet = perUserC.every((r) =>
    Number(r.facts_written) + Number(r.prefs_written) + Number(r.admin_fixed) === 0);

  const cHtml = nothingLearnedYet
    ? `<p class="dim">עדיין לא נשמרו עובדות או העדפות — אין מה לתקן, אז אין מה למדוד.</p>`
    : `<div class="stats">
        <div class="stat"><div class="num">${pct(cFixed, cWritten)}</div>
          <div class="lbl">תוקן מתוך מה שנשמר · ${HABIT_DAYS} ימים</div></div>
        <div class="stat"><div class="num">${fmt(corrAgg[0].admin_fixed)}</div>
          <div class="lbl">תיקוני מנהל · ${HABIT_DAYS} ימים</div></div>
      </div>
      <table><tr><th>משתמש</th><th>עובדות שתוקנו</th><th>העדפות שתוקנו</th><th>תיקוני מנהל</th></tr>
      ${perUserC.map((r) => `<tr>
        <td><a href="/user?id=${r.id}">${esc(r.who)}</a></td>
        <td class="num">${ofTotal(r.facts_fixed, r.facts_written)}</td>
        <td class="num">${ofTotal(r.prefs_fixed, r.prefs_written)}</td>
        <td class="num">${fmt(r.admin_fixed)}</td></tr>`).join('')}</table>
      <p class="hint">תיקון = עובדה שנמחקה תוך שבוע מהרגע שנשמרה, או העדפה שנדרסה בערך אחר
        תוך שבוע — סימן ששמענו לא נכון. גם תיקון של מנהל מהדשבורד (עובדה, מועד פגישה,
        הודעה שבוטלה) נספר — תיקון הוא תיקון. המכנה: כמה בכלל נשמרו. המספרים למעלה
        מסוכמים פעם בשעה; הטבלה מחושבת ברגע הצפייה, על כל התקופה.</p>`;

  const dHtml = `<table>
      <tr><th>משתמש</th><th>הודעות · ${HABIT_DAYS} ימים</th><th>ימים פעילים</th><th>כתב לאחרונה</th></tr>
      ${habit.map((r) => `<tr${!r.last_inbound_at || Date.now() - new Date(r.last_inbound_at).getTime() > 7 * 86400_000 ? ' class="bad"' : ''}>
        <td><a href="/user?id=${r.id}">${esc(r.who)}</a></td>
        <td class="num">${fmt(r.msgs)}</td>
        <td class="num">${r.active_days} / ${HABIT_DAYS}</td>
        <td class="dim small nowrap">${r.last_inbound_at ? ago(r.last_inbound_at) : 'מעולם'}</td>
      </tr>`).join('')}</table>
      <p class="hint">מתוך מונה המכסה, שסופר הודעות נכנסות מזמן. שורה אדומה = שבוע בלי מילה.
        אי אפשר עדיין להפריד "פנה מיוזמתו" מ"ענה להודעה שנשלחה אליו".</p>`;

  return `<h4>א · ענו להודעות שאולמה שלחה</h4>${aHtml}
    <h4>ב · משימות שנסגרו בזמן</h4>${bHtml}
    <h4>ג · תיקונים</h4>${cHtml}
    <h4>ד · הרגל</h4>${dHtml}`;
}

module.exports = { HABIT_DAYS, CLOSURE_WINDOW_DAYS, renderOutcomes };
