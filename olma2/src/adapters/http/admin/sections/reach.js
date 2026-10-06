'use strict';
// reach — two sections of the admin page (see ../index.js) about what reaches
// people outside the chat: how often they open their own page, and who gets a
// morning or evening summary and when (owner, 2026-10-06).
const { esc } = require('../../html');
const { ago } = require('../html');
const opensDomain = require('../../../../domain/dashboard-opens');
const digestStats = require('../../../../domain/digest-stats');

const OWNER_TZ = 'Asia/Jerusalem';

// A moment on a person's own clock. A zone Intl cannot read falls back to the
// owner's rather than taking the page down with it.
function localTime(ts, tz) {
  if (!ts) return '—';
  const opts = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('he-IL', { ...opts, timeZone: tz || OWNER_TZ }).format(new Date(ts));
  } catch (_) {
    return new Intl.DateTimeFormat('he-IL', { ...opts, timeZone: OWNER_TZ }).format(new Date(ts));
  }
}

const zoneNote = (tz) => (tz && tz !== OWNER_TZ ? ` <span class="dim small">(${esc(tz)})</span>` : '');
const nameLink = (id, name) => `<a href="/user?id=${id}">${esc(name || `#${id}`)}</a>`;

// Twenty-four bars of their own hour of day, as text: the page has no JS.
function hourStrip(byHour) {
  const n = new Array(24).fill(0);
  for (const r of byHour) n[r.hour] = r.n;
  const max = Math.max(1, ...n);
  return `<table class="small"><tr>${n.map((_, h) => `<th>${String(h).padStart(2, '0')}</th>`).join('')}</tr>
    <tr>${n.map((v) => `<td title="${v}" style="vertical-align:bottom;height:48px">
      <div style="height:${Math.round((40 * v) / max)}px;background:currentColor;opacity:${v ? 0.55 : 0.08}"></div>
      <span class="dim">${v || ''}</span></td>`).join('')}</tr></table>`;
}

// Where an open came from (migration 113, dashboard-opens.js).
const SOURCE = { app: 'אפליקציה בטלפון', link: 'קישור מוואטסאפ', browser: 'דפדפן בלי קישור', unknown: 'לא ידוע' };
const SOURCE_SHORT = { app: 'אפליקציה', link: 'קישור', browser: 'דפדפן' };

function sourceBlock(s) {
  const by = Object.fromEntries((s.bySource || []).map((r) => [r.source, r]));
  const order = ['app', 'link', 'browser', 'unknown'].filter((k) => by[k]);
  const c = s.codes;
  const codeLine = c ? (c.sent
    ? `קודי כניסה לאפליקציה באייפון נשלחו ${c.sent} פעמים ל־${c.people} אנשים, האחרון ${esc(ago(c.last_at))}.`
    : 'אף אחד עוד לא ביקש קוד כניסה — כלומר אף אחד לא נכנס לאפליקציה באייפון. (באנדרואיד אין צורך בקוד, ולכן אין לזה עקבות לפני שהתחלנו לספור.)') : '';
  return `<h4>מאיפה פתחו</h4>
    ${order.length ? `<table><tr><th></th><th>פתיחות 7 ימים</th><th>אנשים 7 ימים</th><th>פתיחות ${s.days} יום</th><th>אנשים ${s.days} יום</th></tr>
    ${order.map((k) => `<tr><td>${SOURCE[k]}</td><td>${by[k].opens7}</td><td>${by[k].people7}</td><td>${by[k].opens}</td><td>${by[k].people}</td></tr>`).join('')}</table>` : ''}
    <p class="small dim">אפליקציה = נפתח מהאייקון במסך הבית. קישור = לחיצה על קישור שעולמה שלחה. דפדפן = כתובת שמורה או לשונית פתוחה.
    ${s.totals.source_since ? `נספר מאז ${esc(localTime(s.totals.source_since, OWNER_TZ))}. ` : ''}${c && !c.sent ? 'הכניסות מלפני כן נספרו כקישור, כי בלי קוד זו הייתה הדרך היחידה להיכנס.' : ''}
    ${codeLine}</p>`;
}

function sourceCell(p) {
  const parts = ['app', 'link', 'browser'].filter((k) => p[k]).map((k) => `${SOURCE_SHORT[k]} ${p[k]}`);
  return parts.join(' · ') || '<span class="dim">—</span>';
}

function renderOpensView(s) {
  const t = s.totals;
  const head = `<table><tr><th></th><th>פתיחות</th><th>אנשים</th></tr>
    <tr><td>7 ימים</td><td>${t.opens7}</td><td>${t.people7}</td></tr>
    <tr><td>${s.days} יום</td><td>${t.opens}</td><td>${t.people}</td></tr></table>
    <p class="small dim">לא נספרו: ${t.admin_opens} פתיחות שלך מדף המשתמש באדמין${t.test_opens ? `, ${t.test_opens} של חשבונות בדיקה` : ''}.
    ${t.counting_since ? `כל טעינה נספרת מאז ${esc(localTime(t.counting_since, OWNER_TZ))};` : 'עוד לא נספרה אף טעינה;'}
    לפני זה רק כניסות (לינק או קוד) שעוד שמורות, ולכן המספרים הישנים נמוכים מהאמת.</p>`;
  if (!s.people.length) return head + '<p class="dim">אף אחד לא פתח את העמוד שלו בתקופה הזו.</p>' + sourceBlock(s);
  const rows = s.people.map((p) => `<tr>
      <td>${nameLink(p.id, p.first_name)}${zoneNote(p.timezone)}</td>
      <td>${p.opens7}</td><td>${p.opens}${p.backfilled ? ` <span class="dim small" title="מתוכן כניסות משוחזרות, מלפני שנספרה כל טעינה">(${p.backfilled} כניסות)</span>` : ''}</td>
      <td class="small">${sourceCell(p)}</td>
      <td>${esc(localTime(p.first_at, p.timezone))}</td>
      <td>${esc(localTime(p.last_at, p.timezone))} <span class="dim small">${esc(ago(p.last_at))}</span></td>
      <td class="small">${(p.recent || []).map((ts) => esc(localTime(ts, p.timezone))).join(' · ')}</td></tr>`).join('');
  return `${head}${sourceBlock(s)}
    <h4>מי פתח</h4>
    <table><tr><th>מי</th><th>7 ימים</th><th>${s.days} יום</th><th>מאיפה</th><th>ראשונה</th><th>אחרונה</th><th>חמש האחרונות (בשעון שלו)</th></tr>${rows}</table>
    <h4>באיזו שעה ביום שלהם</h4>${hourStrip(s.byHour)}
    <h4>לפי יום</h4>
    <table><tr><th>יום</th><th>פתיחות</th><th>אנשים</th></tr>
    ${s.byDay.slice(0, 14).map((d) => `<tr><td>${esc(String(d.day instanceof Date ? d.day.toLocaleDateString('en-CA') : d.day).slice(0, 10))}</td><td>${d.n}</td><td>${d.people}</td></tr>`).join('')}</table>
    ${s.byDay.length > 14 ? `<p class="small dim">ועוד ${s.byDay.length - 14} ימים קודמים.</p>` : ''}`;
}

async function renderDashboardOpens(client) {
  return renderOpensView(await opensDomain.summary(client, { days: 30 }));
}

const PART = { morning: 'בוקר', noon: 'צהריים', evening: 'ערב' };
const STATE = {
  on: '<span class="pill ok">מקבל</span>',
  paused: '<span class="pill warn">מושהה — לא יקבל</span>',
  not_onboarded: '<span class="pill">לא סיים הצטרפות</span>',
  off: '<span class="pill">כבוי</span>',
};
// Why a written digest never reached them (outbox/gate.js and the worker).
// `quiet` is the big one: somebody who has missed a check-in hears nothing
// Olma decided to say, and the morning summary is exactly that.
const REASON = {
  quiet: 'לא ענה לבדיקה — לא נשלח', duplicate: 'כפול', cancelled_by_admin: 'בוטל מהאדמין',
  expired: 'פג תוקף', superseded: 'הוחלף', meeting_over: 'נגמר',
};

function slotCell(s) {
  const when = s.times.length ? ` <span class="dim small">הגיע ב־${esc([...new Set(s.times)].slice(-5).join(', '))}</span>` : '';
  return `<div><b>${esc(s.slot)}</b> ${PART[s.part] || ''}${s.retired ? ' <span class="dim small">(כבר לא מוגדר)</span>' : ''}
    — ${s.arrived7} השבוע, ${s.arrived} סה״כ${when}</div>`;
}

function renderDigestView(s) {
  const head = `<table><tr><th></th><th>בוקר</th><th>צהריים</th><th>ערב</th></tr>
    <tr><td>מקבלים היום (אנשים)</td><td>${s.parts.morning}</td><td>${s.parts.noon}</td><td>${s.parts.evening}</td></tr>
    <tr><td>הגיעו ב־${s.days} יום (הודעות)</td><td>${s.delivered.morning}</td><td>${s.delivered.noon}</td><td>${s.delivered.evening}</td></tr></table>
    <p class="small dim">${s.live} אנשים יקבלו סיכום בשעה הבאה שלהם. בוקר = לפני 12:00, ערב = מ־17:00, בשעון של כל אחד.
    ${s.delivered.manual ? `${s.delivered.manual} סיכומים נשלחו ידנית ולא בשעה קבועה. ` : ''}${s.missed ? `${s.missed} נכתבו ולא הגיעו — הסיבה בעמודה האחרונה.` : ''}</p>`;
  if (!s.people.length) return head + '<p class="dim">אף אחד לא מוגדר לקבל סיכום.</p>';
  const rows = s.people.map((p) => `<tr${p.state === 'on' ? '' : ' class="dim"'}>
      <td>${nameLink(p.id, p.name)}${zoneNote(p.timezone)}</td>
      <td>${STATE[p.state] || ''}${p.dailyOnce ? ' <span class="pill" title="daily_once_phones: הודעה אחת ביום ב־20:00 במקום השעות שלו">פעם ביום</span>' : ''}</td>
      <td>${p.slots.length ? p.slots.map(slotCell).join('') : '<span class="dim">—</span>'}</td>
      <td>${p.lastLocal ? esc(p.lastLocal) : '—'}</td>
      <td class="small">${p.missed ? Object.entries(p.reasons).map(([k, v]) => `${esc(REASON[k] || k)} ${v}`).join(', ') : ''}</td></tr>`).join('');
  return `${head}
    <table><tr><th>מי</th><th>מצב</th><th>שעה מוגדרת ומה הגיע (בשעון שלו)</th><th>האחרון שהגיע</th><th>לא הגיעו</th></tr>${rows}</table>`;
}

async function renderDigests(client) {
  return renderDigestView(await digestStats.summary(client, { days: 30 }));
}

module.exports = { renderDashboardOpens, renderDigests, renderOpensView, renderDigestView, localTime };
