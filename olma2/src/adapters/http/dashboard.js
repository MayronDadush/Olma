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
const occ = require('../../intake/openclaw-config');
const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG || occ.DEFAULT_PATH;
const boostDomain = require('../../domain/boost');
const boostJob = require('../../jobs/boost');
const issuesDomain = require('../../domain/issues');
const prefsDomain = require('../../domain/preferences');
const factsDomain = require('../../domain/facts');
const auditDomain = require('../../domain/audit');
const { enqueue } = require('../../outbox/enqueue');
const { refreshUserCard } = require('../../intake/user-card');
const { withTx } = require('../../db/pool');
const { assessJobs, isStale } = require('../../jobs/expectations');
const { correctionSql } = require('../../jobs/metrics');
const { deprovisionUser, previewDeletion } = require('../../intake/deprovision');
const pauseDomain = require('../../domain/pause');
const sessionIndex = require('../../channels/sessions');
const evalsJob = require('../../jobs/evals');
const picker = require('./picker');
const userDashboard = require('./user-dashboard');
const publicPages = require('./public-pages');
// /ready's whole test. brokerd beats immediately on boot and then every 60s,
// so three intervals is generous enough that an ordinary slow tick under load
// never fails a deploy, and tight enough that a daemon which died on boot
// cannot coast on the previous process's beat.
const BROKERD_BEAT_MAX_AGE_S = 180;
const infraCost = require('../infra-cost');
const { checkGateway } = require('../gateway-health');
const { readReleaseMarker } = require('../release-marker');

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
  { id: 'health', title: 'מצב המערכת', hint: 'שער התקשורת (הדרך היחידה שהודעות נכנסות ויוצאות מוואטסאפ) וכל התהליכים הפנימיים. אדום = משהו תקוע וצריך טיפול. "לא נבדק" בשער = לא הצלחנו לקרוא את ההגדרות, לא בהכרח תקלה.', render: renderHeartbeats },
  { id: 'boost', title: 'מצב בוסט', hint: 'מתג להדגמות: מעביר את כל המשתמשים למודל המהיר והחזק ביותר, ומכבה את עצמו אחרי שעתיים. עולה יותר לדקה — לכן הוא לא נשאר דלוק בטעות.', render: renderBoost },
  { id: 'users', title: 'משתמשים', hint: 'כל מי שרשום. אפשר לקבוע לכל אחד מכסת הודעות יומית משלו.', render: renderUsers },
  { id: 'issues', title: 'תקלות ובקשות', hint: 'דברים שאולמה או המשתמשים דיווחו עליהם ומחכים לטיפול.', render: renderIssues },
  { id: 'evals', title: 'בדיקות התנהגות', hint: 'כל לילה אולמה עוברת תרחישים שנבנו מתקלות אמת — שיחה מדומה מול משתמש בדיקה, בדיקת כלים ומסד בקוד, ובדיקת ניסוח על ידי מודל שופט. אדום = כלל נשבר; צהוב = השופט הסתייג מהניסוח.', render: renderEvals },
  { id: 'cost', title: 'עלות', hint: 'כל שירות חיצוני שהפרויקט משלם עליו — מופרד ליתרות מראש (שנגמרות) ולחיוב שוטף (שנצבר) — וכמה עולה השימוש במודל לפי יום ולפי משתמש, כולל עמודה נפרדת ליצירת תמונות ווידאו. הערכה, לא חשבונית.', render: renderCost },
  { id: 'outcomes', title: 'האם זה עובד', hint: 'המדדים שנבחרו כדי לענות על השאלה הזו: ענו לנו? נסגרו משימות? נאלצו לתקן אותנו? נוצר הרגל? כל מספר עם המכנה שלו.', render: renderOutcomes },
  { id: 'metrics', title: 'שימוש במוצר', hint: 'מה באמת קורה במוצר: כמה אנשים פעילים, כמה נוצר, מה הצליח.', render: renderMetrics },
  { id: 'planned', title: 'מה מתוכנן להישלח', hint: 'כל מה שאולמה מתכננת לשלוח, ומתי — בשעון המקומי של כל משתמש. התוכן עצמו נכתב ברגע השליחה, לא מראש, ולכן כאן מופיע הנושא ולא הנוסח.', render: renderPlanned },
  { id: 'brain', title: 'מה אולמה יודעת ועל מה היא מחכה', hint: 'שני צדדים של אותו דבר: מה המערכת למדה על האנשים, ומה תקוע אצלה כי אדם עדיין לא ענה.', render: renderBrain },
  { id: 'outbox', title: 'הודעות יוצאות', hint: 'סיכום מספרי של ההודעות היזומות בשבוע האחרון.', render: renderOutbox },
  { id: 'flags', title: 'הגדרות מערכת', hint: 'שינוי כאן חל מיד, בלי עדכון גרסה. כל הגדרה מוסברת בשורה שלה.', render: renderFlags },
  { id: 'contacts', title: 'ספר הכתובות', hint: 'כל אנשי הקשר שהמשתמשים ייבאו או שמרו, מקובצים לפי מספר טלפון — כל השמות שניתנו לאותו מספר, ומי מהם כבר משתמש אצלנו.', render: renderContactsSection },
  { id: 'waitlist', title: 'רשימת המתנה', hint: 'אנשים שפנו כשההרשמה הייתה סגורה. יקבלו הודעה כשתיפתח.', render: renderWaitlist },
  { id: 'audit', title: 'יומן פעילות', hint: 'הפעולות האחרונות במערכת, לפי סדר.', render: renderAudit },
];

// Plain-Hebrew name for every internal job — nobody should need to know
// what "reopen_sweep" is to read this page.
const JOB_LABELS = {
  brokerd: 'מנוע ראשי',
  outbox_worker: 'שליחת הודעות',
  minute_sweeps: 'תזכורות, סיכומים, שחרור ממכסה ווידאו בהכנה',
  intake_sweep: 'קליטת משתמשים חדשים',
  reopen_sweep: 'עדכון רשימת המתנה',
  intake_template_sync: 'עדכון הודעת קליטה',
  config_guard: 'שומר אבטחה',
  checkin_ladder: 'פנייה יזומה למשתמשים',
  unanswered_sweep: 'תיקון הודעות שלא נענו',
  lane_watchdog: 'שחרור שיחות תקועות',
  memory_consolidation: 'סיכום זיכרון שבועי',
  fact_extraction: 'קריאת שיחות ולמידה על משתמשים',
  live_updates: 'עדכונים חיים למנויים (מודלים, מזג אוויר)',
  balance_watch: 'מעקב יתרות בשירותים בתשלום',
  usage_sweep: 'חישוב עלויות',
  metrics_sweep: 'חישוב סטטיסטיקות',
  retention_sweep: 'ניקוי נתונים ישנים',
  eval_sweep: 'בדיקות התנהגות ליליות',
  deploy_drift: 'השוואת הגרסה שרצה מול main',
  backup_offbox: 'גיבוי יומי של מסד הנתונים מחוץ לשרת',
};

// /health sits AHEAD of Basic Auth and Caddy publishes it, so what goes in it
// is public. The status and the reason are the point; the port is an internal
// detail (loopback-bound, but there is no reason to hand it out) and the
// dashboard's own section shows it to an operator who is already logged in.
function publicGateway(gw) {
  return { status: gw.status, detail: gw.detail };
}

// The `deploy_drift` heartbeat's verdict, turned into the half-sentence that
// goes beside the running release. Read out of the rows already fetched — no
// second query, and no network call on a page render (the job did that on its
// own clock; this only reports what it found).
//
// Four outcomes and they must stay four. "Could not check" is not "in sync"
// (jobs/deploy-drift.js says the same thing at the other end): collapsing
// them is exactly the absence-of-evidence mistake this repo keeps making, and
// here it would mean an unreachable GitHub reads as a healthy deploy for as
// long as the outage lasts.
function driftLine(rows) {
  const row = rows.find((r) => r.job_name === 'deploy_drift');
  if (!row || !row.note) return { text: '', warn: false };
  if (String(row.note).startsWith('ERR')) return { text: 'ההשוואה מול main נכשלה', warn: false };
  let d;
  try { d = JSON.parse(row.note); } catch { return { text: '', warn: false }; }
  if (d.state === 'in_sync') return { text: 'מעודכן מול main', warn: false };
  if (d.state === 'behind') {
    const since = d.since ? ` · ${ago(d.since)}` : '';
    // Commits, not merges: main carries merge commits and direct pushes as
    // well as squashed PRs (23 of the last 40 are not a `(#N)` squash), so
    // `ahead_by` and "how many PRs" are different numbers. Plural-aware
    // because "ב־1 קומיטים" is the kind of wrongness that makes a reader stop
    // trusting the rest of the row.
    const n = d.by === 1 ? 'קומיט אחד' : `${d.by} קומיטים`;
    return { text: `מאחורי main ב־${n}${since}`, warn: true };
  }
  if (d.state === 'unchecked') {
    // Never silently presented as current: the row says how old the last real
    // answer is, or that there has never been one.
    const last = d.lastKnown === 'in_sync' ? 'קודם היה מעודכן'
      : d.lastKnown === 'behind' ? 'קודם היה מאחור' : 'אין תשובה קודמת';
    const when = d.lastCheckedAt ? ` ${ago(d.lastCheckedAt)}` : '';
    return { text: `לא ניתן לבדוק מול main · ${last}${when}`, warn: false };
  }
  return { text: '', warn: false };
}

// `probe` is injectable for the same reason /health's is: this suite runs on
// the production box and on CI runners, and neither one's real gateway proves
// anything about the branch under test.
async function renderHeartbeats(client, _csrf, probe) {
  const { rows } = await client.query(`SELECT * FROM job_heartbeats ORDER BY job_name`);
  const now = Date.now();
  const problems = rows.filter((r) => isStale(r.job_name, r.last_run_at, now) || (r.note && String(r.note).startsWith('ERR')));

  // The gateway is not a job_heartbeats row — nothing writes one for it, which
  // is precisely how it stayed off this page while every sweep beside it was
  // watched. It is asked directly, and it leads the table because a dead
  // gateway makes every green row below it beside the point.
  let gw;
  try { gw = await (probe || checkGateway)({ configPath: OPENCLAW_CONFIG_PATH }); }
  catch (e) { gw = { status: 'unknown', detail: `probe failed: ${e.message}`, port: null }; }
  const gwBad = gw.status === 'down';
  const gwLabel = { live: 'פעיל', down: 'לא מגיב', unknown: 'לא נבדק' }[gw.status] || gw.status;
  const gwRow = `<tr class="${gwBad ? 'bad' : ''}">
      <td>${gwBad ? '⚠' : gw.status === 'live' ? '✓' : '–'} שער התקשורת (WhatsApp)</td>
      <td class="dim">${esc(gwLabel)}</td>
      <td class="dim mono">${gwBad ? esc(String(gw.detail || '').slice(0, 90)) : ''}</td></tr>`;

  // The gateway is a PROCESS in this table, so it is counted in the sentence
  // above it — a banner saying 22 over a table that lists 23 running things
  // invites the operator to work out which one is not being counted, on the
  // one page whose whole job is to be believed. It counts only when it was
  // actually OBSERVED: `unknown` is neither a healthy process nor a problem,
  // and claiming it as either is the overstatement the three-state rule
  // exists to avoid. (The release row below is deliberately NOT counted — it
  // is a fact about the deployment, not a process that runs.)
  const gwCounted = gw.status !== 'unknown' ? 1 : 0;

  // Which release is actually serving. deploy.sh has written the RELEASE
  // marker since #126 and rollback.sh reads it, but nothing ever showed it to
  // a person — so when a merge's `test` job wedged on 2026-09-03 and `deploy`
  // was silently skipped, "is production running what I just merged?" could
  // only be answered by grepping deployed source for a string from the diff.
  //
  // Shown, never alarmed on: this box cannot know main's HEAD without reaching
  // GitHub, and a quiet week with no merges is not a fault. The value is that
  // the question becomes a glance.
  //
  // Since #146 the row also carries how far behind `main` that release is,
  // which is the question the marker alone could not answer from inside the
  // box. It is deliberately a note on this row and NOT a `bad` row: being
  // three commits behind means production is running the PREVIOUS release,
  // and the previous release worked. It never enters `totalProblems` either —
  // the banner counts processes in trouble, and this is not one.
  const rel = readReleaseMarker();
  const drift = driftLine(rows);
  const relRow = `<tr>
      <td>– הגרסה שרצה עכשיו</td>
      <td class="dim mono">${rel.known ? esc(rel.short) : 'לא ידוע'}</td>
      <td class="${drift.warn ? 'warn' : 'dim'}">${rel.known
        ? esc([rel.at ? ago(rel.at) : null, drift.text, rel.subject].filter(Boolean).join(' · ').slice(0, 140))
        : 'אין סימון גרסה — פריסה שקדמה למעקב'}</td></tr>`;

  const totalProblems = problems.length + (gwBad ? 1 : 0);
  const banner = totalProblems === 0
    ? `<div class="banner ok">✓ הכל תקין — ${rows.length + gwCounted} תהליכים רצים כסדרם</div>`
    : `<div class="banner bad">⚠ ${totalProblems} תהליכים דורשים תשומת לב</div>`;

  const tr = gwRow + relRow + rows.map((r) => {
    const bad = isStale(r.job_name, r.last_run_at, now) || (r.note && String(r.note).startsWith('ERR'));
    const err = r.note && String(r.note).startsWith('ERR');
    return `<tr class="${bad ? 'bad' : ''}">
      <td>${bad ? '⚠' : '✓'} ${esc(JOB_LABELS[r.job_name] || r.job_name)}</td>
      <td class="dim">${r.last_run_at ? ago(r.last_run_at) : 'טרם רץ'}</td>
      <td class="dim mono">${err ? esc(String(r.note).slice(0, 90)) : ''}</td></tr>`;
  }).join('');
  return banner + `<table><tr><th>תהליך</th><th>רץ לאחרונה</th><th>שגיאה</th></tr>${tr}</table>`;
}

// One line of "here is what was actually in the record when it failed".
function summariseSnapshot(snap) {
  const bits = [];
  const tasks = snap.tasks || [];
  bits.push(tasks.length
    ? `משימות: ${tasks.map((t) => `"${t.title}"${t.local ? ` @${t.local}` : ' (ללא מועד)'}`).join(', ')}`
    : 'לא נשמרה אף משימה');
  if ((snap.facts || []).length) bits.push(`עובדות: ${snap.facts.map((f) => f.fact).join(' | ')}`);
  if ((snap.contacts || []).length) bits.push(`אנשי קשר: ${snap.contacts.map((c) => c.name).join(', ')}`);
  if (snap.paused) bits.push('המשתמש מושהה');
  return bits.join(' · ').slice(0, 400);
}

// The behavioral eval board: the latest run's verdict per scenario, plus a
// short run history. Reads only — running happens in jobs/evals.js and
// scripts/run-evals.js.
async function renderEvals(client) {
  const { rows: runs } = await client.query(
    `SELECT * FROM eval_runs ORDER BY id DESC LIMIT 8`);
  if (!runs.length) {
    return `<p class="dim">עוד לא רצה אף בדיקה. ההרצה הלילית נדרכת אחרי scripts/setup-eval-user.js --apply בשרת.</p>`;
  }
  // The headline is the newest run that drove the LIVE model. A pilot run
  // deliberately drives a candidate, so letting one head this section would
  // page the operator about a model nobody is using — the same shape as an
  // "overdue" flag on a healthy reminder. Pilots stay visible in the history
  // line below, labelled with the model they measured.
  const latest = runs.find((r) => r.trigger !== evalsJob.PILOT_TRIGGER) || runs[0];
  const { rows: results } = await client.query(
    `SELECT * FROM eval_results WHERE run_id = $1 ORDER BY scenario`, [latest.id]);

  const bad = Number(latest.reds) + Number(latest.errors);
  const banner = !latest.finished_at
    ? `<div class="banner">⏳ ריצה ${latest.id} עדיין באמצע…</div>`
    : bad > 0
      ? `<div class="banner bad">⚠ ריצה אחרונה: ${latest.reds} אדומים, ${latest.errors} שגיאות</div>`
      : Number(latest.yellows) > 0
        ? `<div class="banner">🟡 ריצה אחרונה: ${latest.yellows} הסתייגויות ניסוח, אפס כללים שבורים</div>`
        : `<div class="banner ok">✓ ריצה אחרונה: כל ${latest.greens} התרחישים ירוקים</div>`;

  const ICONS = { green: '🟢', yellow: '🟡', red: '🔴', error: '⚠️' };
  const tr = results.map((r) => {
    const hard = (r.hard_failures || []).map((f) => f.name).join('; ');
    const judge = r.judge && r.judge.problems && r.judge.problems.length
      ? r.judge.problems.map((p) => p.rule).join('; ')
      : (r.judge && r.judge.error ? `שופט: ${r.judge.error}` : '');
    // The state that produced a red, captured before the next scenario's
    // reset wiped it — without this a morning-after red says only "failed".
    const snap = r.snapshot ? summariseSnapshot(r.snapshot) : '';
    return `<tr class="${r.status === 'red' || r.status === 'error' ? 'bad' : ''}">
      <td>${ICONS[r.status] || ''} ${esc(r.scenario)}</td>
      <td class="dim">${esc(hard || judge || '')}${snap ? `<br><span class="mono">${esc(snap)}</span>` : ''}</td>
      <td class="dim">${r.duration_ms ? Math.round(r.duration_ms / 1000) + 's' : ''}</td></tr>`;
  }).join('');

  const history = runs.map((r) => {
    const when = ago(r.started_at);
    // A pilot is only readable next to the model it measured — without that
    // its reds look like production regressions in the history line.
    const tag = r.trigger === evalsJob.PILOT_TRIGGER
      ? `pilot: ${esc(String(r.agent_model || 'מודל לא ידוע').replace(/^openrouter\//, ''))}`
      : esc(r.trigger);
    return `<span class="dim">#${r.id} (${tag}, ${when}): 🟢${r.greens} 🟡${r.yellows} 🔴${r.reds} ⚠️${r.errors}</span>`;
  }).join(' · ');

  return banner
    + `<table><tr><th>תרחיש</th><th>מה נמצא</th><th>משך</th></tr>${tr}</table>`
    + `<p>${history}</p>`
    + (latest.agent_model ? `<p class="dim">מודל שנבדק: ${esc(latest.agent_model)}</p>` : '');
}

// Every dollar figure on the cost page renders in shekels by default, USD
// alongside as the secondary number — the owner's ask, and the natural
// reading for an Israeli-run project where every other figure on the page
// (quiet hours, digest times) is already local. `money()` is built once per
// render from a single fetched rate and closed over by every formatter below,
// so a fetch failure degrades the WHOLE page to USD-only rather than mixing
// currencies row by row depending on which call happened to succeed.
function makeMoney(fx) {
  const rate = fx && fx.configured && !fx.error ? fx.rate : null;
  return (usd, decimals = 2) => {
    const n = Number(usd) || 0;
    const usdStr = `$${n.toFixed(decimals)}`;
    if (!rate) return usdStr;
    // Shekel amounts stay at the same precision as their dollar figure — a
    // $0.003 media generation would round to ₪0 at whole shekels and read as
    // free, which it is not.
    return `₪${(n * rate).toFixed(decimals)} <span class="dim small">(${usdStr})</span>`;
  };
}

// One line per recurring service, or a dim explanatory note when it can't be
// read. colspan spans the purpose column plus both amount columns — a service
// we cannot price still has to occupy its row, so it stays visible as a thing
// being paid for rather than vanishing off the page.
function renderInfraRow(label, state, fmtRow) {
  const note = (text) => `<tr><td>${esc(label)}</td><td class="dim" colspan="3">${esc(text)}</td></tr>`;
  if (!state.configured) return note('לא מוגדר בסביבה');
  if (state.error === 'missing_permission') return note('למפתח אין הרשאה לקרוא נתוני חיוב');
  if (state.error) return note(`שגיאה בשליפת נתונים (${state.error})`);
  return fmtRow(state);
}

// A prepaid balance is "low" when it is close to running out in TIME, not in
// dollars: $2 left is fine on a service nobody uses and an outage tomorrow on
// the one every model call goes through. Where the provider reports its own
// burn rate we use days; where it does not, a flat dollar floor is the honest
// fallback and is labelled as the guess it is.
const LOW_DAYS = 14;
const LOW_USD = 5;

function prepaidLow(s) {
  if (!s.configured || s.error || s.remaining === null || s.remaining === undefined) return false;
  if (s.daysLeft !== null && s.daysLeft !== undefined) return s.daysLeft < LOW_DAYS;
  return s.remaining < LOW_USD;
}

// label · what it is FOR in Olma · how much is left. The purpose column is not
// decoration: a service name alone does not tell the owner whether a line can
// be cancelled, and this page exists to be acted on.
function prepaidRow(label, purpose, s, money) {
  const cell = (inner) => `<tr><td>${esc(label)}</td><td class="dim small">${esc(purpose)}</td>${inner}</tr>`;
  if (!s.configured) return cell('<td class="dim" colspan="2">לא מוגדר בסביבה</td>');
  if (s.error) return cell(`<td class="dim" colspan="2">שגיאה בשליפה (${esc(s.error)})</td>`);
  if (s.remaining === null || s.remaining === undefined) {
    return cell('<td class="dim" colspan="2">לא ניתן לקרוא יתרה</td>');
  }
  const low = prepaidLow(s);
  const left = low
    ? `<td class="warn">⚠ ${money(s.remaining)}</td>`
    : `<td>${money(s.remaining)}</td>`;
  const rate = s.daysLeft !== null && s.daysLeft !== undefined
    ? `<td class="${low ? 'warn' : 'dim'}">≈${Math.floor(s.daysLeft)} ימים בקצב הנוכחי (${money(s.dailyTotal)}/יום)</td>`
    : '<td class="dim">אין קצב שריפה מדווח</td>';
  return cell(left + rate);
}

async function renderInfraCosts(client, money) {
  const c = await infraCost.getInfraCosts();
  const { anthropic, digitalocean, elevenlabs, openrouter, twilio, deepgram, cartesia } = c;

  // Recomputed here rather than inside getInfraCosts: the overrides live in a
  // flag, getInfraCosts has no DB client and a 10-minute cache, and a rate the
  // operator just corrected must show on the very next page load.
  let subscription = c.subscription;
  try {
    const overrides = (await flagsDomain.getFlag(client, 'claude_subscription_overrides')) || {};
    subscription = infraCost.subscriptionCost(new Date(), overrides);
  } catch { /* a bad flag value must not cost the whole cost page */ }

  const okAmount = (s, field) => (s.configured && !s.error ? Number(s[field] || 0) : 0);
  // OpenRouter joins both totals: since the cutover it is the real model bill,
  // and leaving it out of the headline made the project look ~3x cheaper to
  // run than it is.
  const sinceTotal = okAmount(anthropic, 'sinceTotal') + okAmount(digitalocean, 'paid')
    + okAmount(elevenlabs, 'sinceTotal') + okAmount(subscription, 'sinceTotal')
    + okAmount(openrouter, 'sinceTotal');
  const monthTotal = okAmount(anthropic, 'monthTotal') + okAmount(digitalocean, 'accrued')
    + okAmount(elevenlabs, 'monthTotal') + okAmount(subscription, 'monthTotal')
    + okAmount(openrouter, 'monthTotal');

  const prepaid = [
    ['OpenRouter', 'כל קריאות המודל: סיכומים, תכנון, זיהוי עובדות, יצירת תמונות ווידאו, שופט הבדיקות', openrouter],
    ['Twilio', 'מספר הטלפון שאולמה מתקשרת ממנו', twilio],
    ['Deepgram', 'זיהוי דיבור בשיחות טלפון חיות', deepgram],
  ];
  const anyLow = prepaid.some(([, , s]) => prepaidLow(s));
  const prepaidRows = prepaid.map(([l, p, s]) => prepaidRow(l, p, s, money)).join('');

  const recurring = [
    renderInfraRow('DigitalOcean', digitalocean, (s) => {
      const creditNote = s.credit ? `<div class="dim small">זיכוי פעיל: -${money(Math.abs(s.credit))} (${esc(s.creditNote || '')})</div>` : '';
      return `<tr><td>DigitalOcean</td><td class="dim small">השרת שהכל רץ עליו</td><td>${money(s.paid)}</td><td>${money(s.accrued)}${creditNote}</td></tr>`;
    }),
    renderInfraRow('ElevenLabs', elevenlabs, (s) =>
      `<tr><td>ElevenLabs</td><td class="dim small">תמלול הודעות קוליות בוואטסאפ</td><td>${money(s.sinceTotal)}</td><td>${money(s.monthTotal)} (${esc(s.tier || '—')})</td></tr>`),
    renderInfraRow('Anthropic', anthropic, (s) =>
      `<tr><td>Anthropic</td><td class="dim small">מפתח הבוט — כמעט לא בשימוש מאז המעבר ל-OpenRouter</td><td>${money(s.sinceTotal)}</td><td>${money(s.monthTotal)}</td></tr>`),
    renderInfraRow('מנוי Claude (אישי)', subscription, (s) =>
      `<tr><td>מנוי Claude (אישי)</td><td class="dim small">${money(s.rate, 0)} לחודש, מחויב ב-27 · מכסה גם את Claude Code${s.overridden ? ' · <b>תעריף מיוחד לחודש הזה</b>' : ''}</td><td>${money(s.sinceTotal)} (${s.count} חיובים)</td><td>${money(s.monthTotal)}</td></tr>`),
  ].join('');

  const cartesiaRow = cartesia.configured
    ? `<tr><td>Cartesia</td><td class="dim small">הקול שאולמה מדברת בו בשיחות טלפון</td>
       <td class="dim" colspan="2">אין API חיוב — צריך לבדוק ידנית ב-play.cartesia.ai</td></tr>`
    : '';

  const warnBanner = anyLow
    ? `<p class="warn">⚠ יתרה נמוכה באחד השירותים המסומנים למטה. כשהיא נגמרת — אין תשובות, אין תזכורות, אין דיג׳סטים.</p>`
    : '';

  return `<h4>עלויות תשתית — כל מה שהפרויקט משלם עליו</h4>
    <div class="stats">
      <div class="stat"><div class="num">${money(sinceTotal)}</div><div class="lbl">סה״כ מתחילת הפרויקט (27/06/2026)</div></div>
      <div class="stat"><div class="num">${money(monthTotal)}</div><div class="lbl">החודש</div></div>
    </div>
    ${warnBanner}
    <h4>יתרה מראש — נגמרת, ואז הכל נעצר</h4>
    <table><tr><th>שירות</th><th>בשביל מה</th><th>נשאר</th><th>לכמה זמן</th></tr>${prepaidRows}${cartesiaRow}</table>
    <h4>חיוב שוטף — נצבר, אין מה שייגמר</h4>
    <table><tr><th>שירות</th><th>בשביל מה</th><th>מתחילת הפרויקט</th><th>החודש</th></tr>${recurring}</table>
    <p class="dim small">הסכומים למעלה כוללים את מה שנצבר בפועל בחיוב השוטף ואת מה שנשרף מהיתרות מראש — לא את מה שהוטען אליהן ועוד לא נוצל.
    שימוש Claude Code שלך מעבר לבוט מכוסה במנוי האישי ואינו חיוב נפרד, כדי לא לספור פעמיים.</p>`;
}

async function renderCost(client) {
  // Days and month totals span BOTH ledgers: usage_ledger is per user, and
  // usage_system_ledger holds the agents nobody owns (main, intake) — real
  // spend that the old sweep dropped on the floor, which is part of why the
  // attributed figure read low for a month.
  const days = await client.query(
    `SELECT date, sum(cost) AS cost, bool_or(est) AS estimated FROM (
       SELECT date, cost_usd AS cost, estimated AS est FROM usage_ledger
       UNION ALL
       SELECT date, cost_usd AS cost, estimated AS est FROM usage_system_ledger
     ) x GROUP BY date ORDER BY date DESC LIMIT 14`);
  const top = await client.query(
    `SELECT u.first_name, u.phone, sum(l.total_tokens) AS tokens, sum(l.cost_usd) AS cost
     FROM usage_ledger l JOIN users u ON u.id = l.user_id
     WHERE l.date >= date_trunc('month', CURRENT_DATE)
     GROUP BY u.id ORDER BY cost DESC LIMIT 10`);
  const system = await client.query(
    `SELECT agent_id, sum(cost_usd) AS cost FROM usage_system_ledger
     WHERE date >= date_trunc('month', CURRENT_DATE)
     GROUP BY agent_id ORDER BY cost DESC`);
  // Image+video generation spend — its own ledger and its own block, exactly
  // as asked: this money is billed by OpenRouter per generation (their own
  // usage.cost figure, not token arithmetic), so folding it into the model
  // table would corrupt the Anthropic reconciliation line below.
  const media = await client.query(
    `SELECT u.first_name, u.phone, sum(m.images) AS images, sum(m.videos) AS videos,
            sum(m.cost_usd) AS cost,
            sum(m.cost_usd) FILTER (WHERE m.date = CURRENT_DATE) AS cost_today
     FROM media_usage_ledger m JOIN users u ON u.id = m.user_id
     WHERE m.date >= date_trunc('month', CURRENT_DATE)
     GROUP BY u.id ORDER BY cost DESC`);

  // Fetched once and closed over by every formatter on the page — a fetch
  // failure degrades the WHOLE page to USD-only, never a mix of currencies
  // depending on which call happened to land first.
  const fx = await infraCost.usdIlsRate().catch(() => ({ configured: false }));
  const money = makeMoney(fx);

  const infraHtml = await renderInfraCosts(client, money);

  // Rendered even when empty this month — a cost line that only appears once
  // money was already spent is a cost line nobody was watching.
  const mediaMonth = media.rows.reduce((s, r) => s + Number(r.cost), 0);
  const mediaToday = media.rows.reduce((s, r) => s + Number(r.cost_today || 0), 0);
  const mediaHtml = `<h4>יצירת תמונות ווידאו (OpenRouter)</h4>
    <div class="stats">
      <div class="stat"><div class="num">${money(mediaMonth)}</div><div class="lbl">סה״כ החודש</div></div>
      <div class="stat"><div class="num">${money(mediaToday)}</div><div class="lbl">היום</div></div>
    </div>
    ${media.rows.length
      ? `<table><tr><th>מי</th><th>תמונות</th><th>סרטונים</th><th>עלות</th></tr>
         ${media.rows.map((r) => `<tr><td>${esc(r.first_name || r.phone)}</td><td>${Number(r.images)}</td><td>${Number(r.videos)}</td><td>${money(Number(r.cost), 3)}</td></tr>`).join('')}</table>`
      : '<p class="dim small">לא נוצרו תמונות או סרטונים החודש.</p>'}
    <p class="dim small">חיוב לפי הדיווח של OpenRouter על כל יצירה — נפרד מעלות המודל של השיחות, ולא נכלל בשורת ההתאמה מול Anthropic.</p>`;

  // Voice calls — per-call rows from jobs/voice-usage.js. Twilio's figure is
  // the provider's own (authoritative once settled; a null price is "not
  // settled yet" and is summed as 0 with the count shown). STT/TTS/LLM have
  // no per-call billing API, so their share is an estimate at a fixed rate
  // per MINUTE, labelled as such: Deepgram measured from a real balance drop
  // ($0.100 over 25.5 min of calls, 2026-08-31), Cartesia and the LLM from
  // list prices. Estimates multiply measured minutes — never guessed usage.
  const EST_STT_PER_MIN = 0.0039, EST_TTS_PER_MIN = 0.027, EST_LLM_PER_MIN = 0.006;
  const voice = await client.query(
    `SELECT count(*) AS calls, count(*) FILTER (WHERE twilio_usd IS NULL) AS unsettled,
            COALESCE(sum(duration_sec), 0) AS seconds, COALESCE(sum(twilio_usd), 0) AS twilio
     FROM voice_usage_ledger
     WHERE started_at >= date_trunc('month', CURRENT_DATE) AND duration_sec > 0`);
  const v = voice.rows[0];
  const vMinutes = Number(v.seconds) / 60;
  const vEst = vMinutes * (EST_STT_PER_MIN + EST_TTS_PER_MIN + EST_LLM_PER_MIN);
  const voiceHtml = `<h4>שיחות קול</h4>
    <div class="stats">
      <div class="stat"><div class="num">${Number(v.calls)}</div><div class="lbl">שיחות החודש</div></div>
      <div class="stat"><div class="num">${vMinutes.toFixed(1)}</div><div class="lbl">דקות</div></div>
      <div class="stat"><div class="num">${money(Number(v.twilio), 3)}</div><div class="lbl">Twilio (מדוד)</div></div>
      <div class="stat"><div class="num">≈${money(vEst, 3)}</div><div class="lbl">STT+TTS+מודל (הערכה)</div></div>
    </div>
    <p class="dim small">Twilio לפי המחיר שהוא עצמו מדווח לכל שיחה${Number(v.unsettled) ? ` (${Number(v.unsettled)} שיחות עוד לא תומחרו אצלו — יתעדכן)` : ''};
    ל-Deepgram/Cartesia/מודל אין חיוב פר-שיחה, לכן הערכה לפי דקה מדודה: ‎$${EST_STT_PER_MIN}+$${EST_TTS_PER_MIN}+$${EST_LLM_PER_MIN} לדקה.</p>`;

  if (!days.rows.length) return infraHtml + mediaHtml + voiceHtml + '<p class="dim">עדיין אין נתוני עלות למשתמשים — החישוב רץ כל שעה.</p>';
  const usersTotal = top.rows.reduce((s, r) => s + Number(r.cost), 0);
  const systemTotal = system.rows.reduce((s, r) => s + Number(r.cost), 0);
  const monthTotal = usersTotal + systemTotal;
  const todayRow = days.rows[0];

  // The reconciliation line. Anthropic's own usage_report is the billing
  // truth; this table is our attribution of it. They should track closely, and
  // when they do not that is the signal — a silent gap between the two is
  // exactly how a gauge-read-as-a-counter went unnoticed for a month, with the
  // ledger reporting cents against a real $17.77. Shown always, not only when
  // it breaks, because a check nobody sees passing is a check nobody trusts.
  let reconcile = '';
  try {
    const { anthropic } = await infraCost.getInfraCosts();
    if (anthropic && anthropic.configured && !anthropic.error) {
      const billed = Number(anthropic.monthTotal || 0);
      const diff = billed > 0 ? Math.abs(billed - monthTotal) / billed : 0;
      const ok = diff <= 0.15;
      reconcile = `<p class="${ok ? 'dim' : 'warn'} small">${ok ? '✓' : '⚠'} התאמה מול Anthropic:
        שויך כאן ${money(monthTotal)} · חויב בפועל ${money(billed)}
        (פער ${(diff * 100).toFixed(0)}%)${ok ? '' : ' — מישהו צריך להסתכל על זה'}</p>`;
    }
  } catch { /* the reconciliation is a nicety; never let it break the page */ }

  const anyEstimated = days.rows.some((r) => r.estimated);
  return infraHtml + mediaHtml + voiceHtml + `<h4>עלות מודל לפי משתמש</h4><div class="stats">
      <div class="stat"><div class="num">${money(monthTotal)}</div><div class="lbl">סה״כ החודש</div></div>
      <div class="stat"><div class="num">${money(Number(todayRow.cost))}</div><div class="lbl">היום</div></div>
      <div class="stat"><div class="num">${top.rows.length}</div><div class="lbl">משתמשים פעילים החודש</div></div>
    </div>
    ${reconcile}
    <div class="cols"><div><h4>לפי יום</h4><table><tr><th>תאריך</th><th>עלות</th></tr>
    ${days.rows.map((r) => `<tr><td class="nowrap">${esc(String(r.date).slice(0, 10))}</td><td>${money(Number(r.cost), 3)}${r.estimated ? ' <span class="dim">≈</span>' : ''}</td></tr>`).join('')}</table></div>
    <div><h4>לפי משתמש (החודש)</h4><table><tr><th>מי</th><th>עלות</th></tr>
    ${top.rows.map((r) => `<tr><td>${esc(r.first_name || r.phone)}</td><td>${money(Number(r.cost), 3)}</td></tr>`).join('')}
    ${system.rows.map((r) => `<tr><td class="dim">${esc(r.agent_id)} (מערכת)</td><td class="dim">${money(Number(r.cost), 3)}</td></tr>`).join('')}</table></div></div>
    <p class="dim small">מחושב מהתמלילים עצמם — סכימת הטוקנים בפועל לפי התעריף של כל מודל.
    ${anyEstimated ? 'שורות עם ≈ כוללות מודל בלי תעריף ידוע, שתומחר בתעריף ממוצע. ' : ''}החיוב האמיתי מגיע מ-Anthropic. שער דולר-שקל: ${fx.configured && fx.rate ? `₪${fx.rate.toFixed(3)} ל-$1` : 'לא זמין כרגע'}.</p>`;
}

const METRIC_LABELS = {
  active_users: 'משתמשים פעילים', messages_counted: 'הודעות',
  tasks_created: 'משימות שנוצרו', reminders_created: 'תזכורות',
  meetings_started: 'פגישות שהתחילו', meetings_confirmed: 'פגישות שסוכמו',
  meetings_no_match: 'פגישות שלא הסתדרו', shares_offered: 'שיתופים שהוצעו',
  shares_accepted: 'שיתופים שהתקבלו', connections_requested: 'בקשות חברות',
  connections_approved: 'חברויות שאושרו', issues_reported: 'תקלות שדווחו',
  users_provisioned: 'משתמשים חדשים',
  facts_remembered: 'עובדות שנשמרו', facts_corrected: 'עובדות שתוקנו',
  preferences_remembered: 'העדפות שנשמרו', preferences_corrected: 'העדפות שתוקנו',
  admin_corrections: 'תיקוני מנהל',
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
  { key: 'credit_alerts_muted', label: 'השתקת התראות קרדיט/יתרה', type: 'bool',
    help: 'כשפתוח (מושתק) — התראת "נגמר הקרדיט" והתראת היתרה היורדת לא נשלחות לאדמין בוואטסאפ. תקלות config_guard קריטיות והתראת בדיקות ההתנהגות הלילית לא מושפעות.' },
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
  { key: 'live_subscriptions_per_user', label: 'מקסימום מנויי עדכונים חיים למשתמש', type: 'int',
    help: 'כמה מנויי "עדכן אותי על..." פעילים מותר למשתמש אחד (מודלים חדשים, מזג אוויר וכו\u05f3).' },
  { key: 'claude_subscription_overrides', label: 'מנוי Claude — חודשים בתעריף אחר', type: 'json',
    // Keys are billing months, values are dollars. Anything else is a typo and
    // must not reach a page that prices money with it.
    validate: (v) => v && typeof v === 'object' && !Array.isArray(v)
      && Object.entries(v).every(([k, amt]) =>
        /^\d{4}-(0[1-9]|1[0-2])$/.test(k) && Number.isFinite(Number(amt)) && Number(amt) >= 0),
    help: 'JSON של חודשים שחויבו אחרת מ-$20, למשל {"2026-08": 100} לחודש Max. אין שום API שחושף חיוב מנוי, אז זה המקום היחיד שבו הדף יכול לדעת. חודש שלא מופיע כאן מחושב ב-$20.' },
  { key: 'email_access_phones', label: 'חיבור תיבת מייל — מי מורשה', type: 'text',
    help: 'ריק = סגור לכולם חוץ מאדמין; "all" = פתוח לכולם; או מספרי טלפון ב-E.164 מופרדים בפסיק. חוסם רק חיבור חדש — מי שכבר חיבר ממשיך לעבוד. להשאיר סגור עד שהרשאת ה-Gmail מאושרת בקונסולה של גוגל.' },
  { key: 'media_gen_phones', label: 'יצירת תמונות ווידאו — מספרים מורשים', type: 'text',
    help: 'מספרי טלפון (E.164, מופרדים בפסיק) שמותר להם לייצר תמונות ווידאו. אדמין מורשה תמיד, בלי קשר לרשימה.' },
  { key: 'media_image_model', label: 'מודל יצירת תמונות', type: 'text',
    help: 'מזהה מודל ב-OpenRouter. ריק = ברירת המחדל (meta/muse-image, ~$0.01 לתמונה).' },
  { key: 'media_video_model', label: 'מודל יצירת וידאו', type: 'text',
    help: 'מזהה מודל ב-OpenRouter. ריק = ברירת המחדל (bytedance/seedance-2.0-mini, ~$0.05 ל-4 שניות 480p).' },
  { key: 'digest_card_min_items', label: 'מתי הסיכום היומי נשלח כתמונה', type: 'int',
    help: 'מכמה פריטים פתוחים הסיכום של הבוקר נשלח כתמונה מצוירת במקום כטקסט. מתחת למספר הזה — משפט קצר, שתמונה במקומו רק מפריעה. 0 = בלי תמונות בכלל.' },
  { key: 'reminder_escalation_max', label: 'כמה פעמים תזכורת חוזרת', type: 'int',
    help: 'תזכורת שלא נענתה חוזרת עד למספר הזה של פעמים (כולל הראשונה). 1 = כמו פעם, פעם אחת בלבד. חוזרת רק אחרי שהקודמת באמת נמסרה, ורק לתזכורות חד-פעמיות — לתזכורת חוזרת יש כבר קצב משלה.' },
  { key: 'reminder_escalation_gap_hours', label: 'שעות בין תזכורת לחזרה עליה', type: 'num',
    help: 'הפער מרגע המסירה של תזכורת ועד החזרה עליה. החזרה האחרונה תמיד ביום למחרת, באותה שעה שנבחרה במקור.' },
  { key: 'implicit_turn_start', label: 'השלמת פתיחת טרן בצד השרת', type: 'text',
    help: 'כשהסוכן מדלג על turn_start (קורה בבקשת הפסקת שירות), השרת סופר את ההודעה ומעדכן שהמשתמש ער בעצמו. ריק = כבוי; "all" = כל המשתמשים; או רשימת מספרים ב-E.164 מופרדים בפסיק, להרצה מדורגת.' },
  { key: 'public_base_url', label: 'כתובת ציבורית לקישורים', type: 'text',
    help: 'הבסיס לקישורים שנשלחים למשתמשים (למשל דף סימון הזמינות). בלי / בסוף.' },
  { key: 'search_link_base', label: 'מנוע החיפוש לקישורים', type: 'text',
    help: 'הבסיס לקישור החיפוש שאולמה שולחת כשהיא לא יכולה לחפש בעצמה. ריק = גוגל. חייב להתחיל ב-https ולהסתיים בפרמטר השאילתה, למשל https://duckduckgo.com/?q= — ערך לא תקין נופל חזרה לגוגל ולא שובר קישור.' },
];
const EDITABLE_FLAGS = FLAG_SPECS.map((f) => f.key);

// The demo switch. Deliberately its own section at the top rather than a row
// in "הגדרות מערכת": it is the only setting that costs real money per minute
// and turns itself off, so it needs to show a countdown, and a flag table has
// nowhere to put one.
async function renderBoost(client, csrf) {
  const state = await flagsDomain.getFlag(client, boostJob.STATE_FLAG);
  const model = await flagsDomain.getFlag(client, boostJob.MODEL_FLAG);
  const now = new Date();
  const on = boostDomain.isEngaged(state) && !boostDomain.expired(state, now);
  const left = boostDomain.minutesLeft(state, now);

  const button = on
    ? `<form method="post" action="/boost" class="inline">
         <input type="hidden" name="csrf" value="${csrf}">
         <input type="hidden" name="action" value="off">
         <button>כבה עכשיו</button>
       </form>`
    : `<form method="post" action="/boost" class="inline">
         <input type="hidden" name="csrf" value="${csrf}">
         <input type="hidden" name="action" value="on">
         <button>הדלק מצב בוסט</button>
       </form>`;

  const status = on
    ? `<div><b>פעיל</b> — נשארו <b>${left}</b> דקות. המודל: <span dir="ltr">${esc(String(state.model || model || ''))}</span>.
         <div class="dim small">כשהזמן ייגמר המערכת תחזור לבד ל-<span dir="ltr">${esc(String((state.restore && state.restore.model) || ''))}</span>. אין צורך לזכור לכבות.</div></div>`
    : `<div>כבוי. כל המשתמשים על מודל ברירת המחדל.
         <div class="dim small">הדלקה מעבירה את <b>כל</b> המשתמשים ל-<span dir="ltr">${esc(String(model || ''))}</span> למשך שעתיים, ואז חוזרת לבד. השינוי חל תוך דקה ובלי הפעלה מחדש — שיחה באמצע לא נקטעת.</div></div>`;

  return `<div class="boost ${on ? 'on' : 'off'}">${status}<div style="margin-top:8px">${button}</div></div>`;
}

async function renderFlags(client, csrf) {
  const rows = [];
  for (const spec of FLAG_SPECS) {
    const val = await flagsDomain.getFlag(client, spec.key);
    const field = spec.type === 'bool'
      ? `<select name="value">
           <option value="true" ${val === true ? 'selected' : ''}>פתוח</option>
           <option value="false" ${val === false ? 'selected' : ''}>סגור</option>
         </select>`
      : spec.type === 'json'
      ? `<input name="value" value="${esc(JSON.stringify(val ?? {}))}" size="34">`
      : spec.type === 'text'
        ? `<input name="value" value="${esc(val == null ? '' : String(val))}" size="28" dir="ltr">`
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

async function renderPlanned(client) {
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

// ---- the address book ------------------------------------------------------
// Every contact every user saved or imported, keyed by the phone number rather
// than by the row — the same number usually carries several names, one per
// person who saved it ("אמא" to one user, "רותי כהן" to another), and the
// question worth answering here is "who is this number, to everyone who knows
// them, and are they already with us".
//
// OPERATOR-ONLY, deliberately. A user's address book is private to them: no
// agent can read another user's contacts, and domain/contacts.js#namesForPhone
// (the same cross-user lookup) is kept out of the MCP registry for exactly
// that reason. This page exists because the person running Olma needs to see
// their own data, and it sits behind the dashboard's Basic Auth like the rest.
const CONTACTS_PAGE_SIZE = 100;

// One row per distinct phone, with every name given to it and whether that
// number belongs to a user of ours. Returns { rows, total }.
async function readContactBook(client, { q = '', onlyOlma = false, page = 0 } = {}) {
  const like = q.trim() ? `%${q.trim()}%` : null;
  const where = `WHERE ($1::text IS NULL OR uc.display_name ILIKE $1 OR uc.phone ILIKE $1)
                   ${onlyOlma ? 'AND u.id IS NOT NULL' : ''}`;
  const { rows: totals } = await client.query(
    `SELECT count(DISTINCT uc.phone)::int AS n
     FROM user_contacts uc LEFT JOIN users u ON u.phone = uc.phone ${where}`, [like]);
  const { rows } = await client.query(
    `SELECT uc.phone,
            array_agg(DISTINCT uc.display_name) AS names,
            array_agg(DISTINCT uc.user_id)      AS owner_ids,
            max(uc.updated_at)                  AS last_seen,
            u.id AS olma_id, u.first_name, u.last_name, u.status
     FROM user_contacts uc LEFT JOIN users u ON u.phone = uc.phone
     ${where}
     GROUP BY uc.phone, u.id, u.first_name, u.last_name, u.status
     ORDER BY (u.id IS NOT NULL) DESC, count(DISTINCT uc.user_id) DESC, max(uc.updated_at) DESC
     LIMIT $2 OFFSET $3`,
    [like, CONTACTS_PAGE_SIZE, page * CONTACTS_PAGE_SIZE]);
  return { rows, total: totals[0].n };
}

// Owner ids → display names, from one small query: there are a handful of
// users, so this is cheaper and simpler than joining the owner table back into
// the grouped query above.
async function ownerNames(client) {
  const { rows } = await client.query(`SELECT id, first_name, last_name, phone FROM users`);
  const map = new Map();
  for (const u of rows) {
    map.set(Number(u.id), [u.first_name, u.last_name].filter(Boolean).join(' ') || u.phone);
  }
  return map;
}

function contactSearchForm(q, onlyOlma) {
  return `<form method="get" action="/contacts" class="inline" style="margin-bottom:12px">
    <input name="q" value="${esc(q)}" placeholder="שם או מספר" size="22">
    <label class="dim small"><input type="checkbox" name="only" value="olma" ${onlyOlma ? 'checked' : ''}>
      רק מי שכבר אצלנו</label>
    <button>חיפוש</button></form>`;
}

// The main page gets the shape of the thing, not 3000 rows: counts, the few
// numbers more than one person saved, and the way in.
async function renderContactsSection(client) {
  const { rows: sum } = await client.query(
    `SELECT count(*)::int AS saved,
            count(DISTINCT phone)::int AS people,
            count(DISTINCT user_id)::int AS owners
     FROM user_contacts`);
  const { rows: known } = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT uc.phone FROM user_contacts uc JOIN users u ON u.phone = uc.phone GROUP BY uc.phone
     ) t`);
  const { rows: shared } = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT phone FROM user_contacts GROUP BY phone HAVING count(DISTINCT user_id) > 1
     ) t`);
  const s = sum[0];
  if (!s.saved) return '<p class="dim">אף אחד עוד לא שמר או ייבא אנשי קשר.</p>';
  return `<div class="stats">
      <div class="stat"><div class="num">${s.people}</div><div class="lbl">אנשים (מספרים שונים)</div></div>
      <div class="stat"><div class="num">${s.saved}</div><div class="lbl">שמירות סה״כ</div></div>
      <div class="stat"><div class="num">${known[0].n}</div><div class="lbl">מתוכם כבר משתמשים אצלנו</div></div>
      <div class="stat"><div class="num">${shared[0].n}</div><div class="lbl">מוכרים ליותר ממשתמש אחד</div></div>
      <div class="stat"><div class="num">${s.owners}</div><div class="lbl">משתמשים ששמרו</div></div>
    </div>
    ${contactSearchForm('', false)}
    <p class="hint"><a href="/contacts">פתיחת ספר הכתובות המלא ←</a></p>`;
}

async function renderContactsPage(client, { q = '', onlyOlma = false, page = 0 } = {}) {
  const { rows, total } = await readContactBook(client, { q, onlyOlma, page });
  const owners = await ownerNames(client);
  const pages = Math.ceil(total / CONTACTS_PAGE_SIZE);
  const link = (p) => `/contacts?q=${encodeURIComponent(q)}${onlyOlma ? '&only=olma' : ''}&page=${p}`;

  const body = rows.length ? `<table>
    <tr><th>טלפון</th><th>שמות שניתנו לו</th><th>מי שמר</th><th>אצלנו?</th><th>עודכן</th></tr>
    ${rows.map((r) => `<tr>
      <td class="mono">${esc(r.phone)}</td>
      <td>${r.names.map((n) => esc(n)).join('<span class="dim"> · </span>')}</td>
      <td class="dim small">${r.owner_ids.map((id) => esc(owners.get(Number(id)) || `#${id}`)).join(', ')}</td>
      <td>${r.olma_id
        ? `<a href="/user?id=${r.olma_id}"><span class="pill ok">${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || 'משתמש')}</span></a>`
        : '<span class="dim">—</span>'}</td>
      <td class="dim small nowrap">${ago(r.last_seen)}</td></tr>`).join('')}</table>`
    : '<p class="dim">אין תוצאות לחיפוש הזה.</p>';

  const nav = pages > 1 ? `<p class="hint">
      ${page > 0 ? `<a href="${link(page - 1)}">← הקודם</a>` : ''}
      עמוד ${page + 1} מתוך ${pages}
      ${page + 1 < pages ? `<a href="${link(page + 1)}">הבא →</a>` : ''}</p>` : '';

  return `
    <section><h3>← <a href="/">חזרה</a></h3></section>
    <section>
      <h3>ספר הכתובות</h3>
      <p class="hint">${total} אנשים${q ? ` שתואמים "${esc(q)}"` : ''}${onlyOlma ? ', מסונן למי שכבר משתמש אצלנו' : ''}.
        מקובץ לפי מספר טלפון — כל השמות שניתנו לאותו מספר מופיעים יחד.</p>
      ${contactSearchForm(q, onlyOlma)}
      ${body}
      ${nav}
    </section>`;
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
  const { CHAPTER_GAP_MS } = require('../../jobs/fact-extraction');
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

// Only ever back to a user page this dashboard itself renders. `back` arrives
// inside a form body, so without this check any admin action could be turned
// into an open redirect by anyone who can get the operator to submit a form.
function safeBack(value) {
  return /^\/user\?id=\d+$/.test(value || '') ? value : '/';
}

const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const localDt = (v) => (LOCAL_DT.test(v || '') ? v : null);

// Every per-user admin edit lives here. Returns the id of the user whose
// USER.md now needs rewriting, or null when the edit cannot have changed it.
//
// Writes go through the domain functions wherever one exists rather than
// straight SQL, so an operator's change is validated exactly like the agent's
// and lands in the same audit trail. The extra admin.* row on top records who
// the change came from, which the domain call alone would not show.
async function handleUserEdit(client, pathname, body) {
  const id = Number(body.id) || 0;

  if (pathname === '/outbox/cancel') {
    // Never DELETE. The row carries the idempotency_key that stops the sweep
    // which produced it from producing it again; removing the row would simply
    // bring the message back on the next tick. Marking it handled is what
    // actually cancels it.
    const { rows } = await client.query(
      `UPDATE outbox SET sent_at = now(), hold_reason = $2
        WHERE id = $1 AND sent_at IS NULL RETURNING user_id, kind`,
      [id, CANCELLED_BY_ADMIN]);
    if (rows[0]) {
      await auditDomain.record(client, rows[0].user_id, 'admin.outbox.cancelled',
        { outboxId: id, kind: rows[0].kind });
    }
    return null;
  }

  if (pathname === '/outbox/reschedule') {
    const release = localDt(body.release_after);
    const expires = localDt(body.expires_at);
    // The operator typed a wall-clock time in the PERSON's timezone. Postgres
    // does the conversion in both directions, so there is no offset arithmetic
    // here to get wrong when the clocks change.
    const { rows } = await client.query(
      `UPDATE outbox o SET
          release_after = ($2::timestamp AT TIME ZONE COALESCE(u.timezone, 'UTC')),
          expires_at    = ($3::timestamp AT TIME ZONE COALESCE(u.timezone, 'UTC')),
          -- clearing the hold puts it back in front of the gate: a row held for
          -- budget is skipped forever otherwise, so rescheduling it would look
          -- like it worked and change nothing.
          hold_reason = NULL
        FROM users u
        WHERE o.id = $1 AND o.user_id = u.id AND o.sent_at IS NULL
        RETURNING o.user_id`,
      [id, release, expires]);
    if (rows[0]) {
      await auditDomain.record(client, rows[0].user_id, 'admin.outbox.rescheduled',
        { outboxId: id, releaseAfter: release, expiresAt: expires });
    }
    return null;
  }

  if (pathname === '/outbox/new') {
    const userId = Number(body.user_id) || 0;
    const instruction = String(body.instruction || '').trim().slice(0, 500);
    if (!userId || !instruction) return null;
    const release = localDt(body.release_after);
    const { rows: tz } = await client.query(
      `SELECT COALESCE(timezone, 'UTC') AS tz FROM users WHERE id = $1`, [userId]);
    if (!tz[0]) return null;
    const { rows: when } = await client.query(
      `SELECT ($1::timestamp AT TIME ZONE $2) AS at`, [release, tz[0].tz]);
    // No idempotencyKey: this is a one-off an operator wrote, not a sweep's
    // output, so there is nothing for a key to deduplicate against — and a
    // fixed one would silently swallow the second message they meant to send.
    await enqueue(client, {
      userId, kind: 'checkin',
      payload: { checkinInstruction: instruction, rung: 'admin' },
      urgency: body.urgency === 'urgent' ? 'urgent' : 'normal',
      releaseAfter: when[0].at,
    });
    await auditDomain.record(client, userId, 'admin.outbox.queued',
      { urgency: body.urgency === 'urgent' ? 'urgent' : 'normal', releaseAfter: release });
    return null;
  }

  const userId = Number(body.user_id) || 0;
  if (!userId) return null;

  if (pathname === '/users/resume') {
    // Deliberately one-way from here: an operator can bring someone BACK (they
    // asked, through some channel that is not their own agent), but cannot
    // pause them. Pausing is the person's own decision, made in their own
    // conversation; an admin button for it would be a way to silence a user
    // without their say.
    const res = await pauseDomain.resumeUser(client, userId);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.user_resumed', {
      remindersRearmed: res.data.rearmed.length,
    });
    return userId;
  }

  if (pathname === '/prefs/set') {
    const res = await prefsDomain.remember(client, userId, String(body.key || '').trim(), body.value);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.preference.set', { key: res.data.key });
    return userId;
  }

  if (pathname === '/prefs/delete') {
    const res = await prefsDomain.forget(client, userId, String(body.key || '').trim());
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.preference.deleted', { key: res.data.key });
    return userId;
  }

  if (pathname === '/facts/add') {
    const res = await factsDomain.rememberFact(client, userId, {
      category: body.category,
      fact: body.fact,
      importance: Number(body.importance) || 1,
      expiresAt: DATE_ONLY.test(body.expires_at || '') ? `${body.expires_at}T00:00:00Z` : null,
      // Not 'user_stated': the person did not say this, an operator decided it.
      source: 'admin',
    });
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.fact.added',
      { factId: Number(res.data.fact.id), category: res.data.fact.category });
    return userId;
  }

  if (pathname === '/facts/delete') {
    // Soft delete through the domain, so a correction stays on the record.
    const res = await factsDomain.forgetFact(client, userId, id);
    if (!res.ok) return null;
    await auditDomain.record(client, userId, 'admin.fact.deleted', { factId: id });
    return userId;
  }

  return null;
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
  p.warn{color:var(--warn)}
  td.warn{color:var(--warn);font-weight:600}
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

// The page Google sends the user's browser back to. Deliberately plain: they
// are standing in a browser they only opened to approve something, and the
// real conversation continues in WhatsApp.
function oauthResultPage(title, body) {
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>אולמה</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#12151a;color:#e6eaf0;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
.card{background:#1a1f27;padding:28px 32px;border-radius:12px;max-width:420px}
h1{font-size:18px;margin:0 0 8px;font-weight:600}p{color:#8b95a5;font-size:14px;margin:0;line-height:1.6}</style>
</head><body><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p></div></body></html>`;
}

// configPath is injectable so tests can exercise deletion against a temp
// openclaw.json instead of the live gateway's. calendarDomain/googleOpts are
// injectable so the OAuth flow can be tested without network access — and are
// required lazily, so a box with no /opt/olma still starts a dashboard.
function createDashboard({ pool, adminUser, adminPass, configPath, calendarDomain, googleContactsDomain, mailDomain, googleConnectDomain, googleOpts, gatewayCheck, gatewayCacheMs, publicHosts }) {
  const calendar = () => calendarDomain || require('../../domain/calendar');
  const googleContacts = () => googleContactsDomain || require('../../domain/google-contacts');
  const mail = () => mailDomain || require('../../domain/mail');
  const googleConnect = () => googleConnectDomain || require('../../domain/google-connect');

  // Which hostnames get the PUBLIC home page at `/` instead of the admin
  // dashboard. Injectable so the suite can prove both halves without owning
  // DNS; the default is the real public domain and its www form.
  const PUBLIC_HOSTS = new Set(publicHosts || ['allma.world', 'www.allma.world']);
  // Host arrives as "name" or "name:port", and a client controls it. Only ever
  // used to decide public-page-or-dashboard, and it can only ever REMOVE
  // access (an unrecognised host falls through to Basic Auth), so a forged
  // value cannot reach anything the password protects.
  const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();

  // Injectable so a test states the gateway's condition instead of inheriting
  // whatever is running on the machine — the suite runs ON the production box
  // (deploy.sh), where the real probe would be green for real, and on CI
  // runners with no gateway at all, where it would be `unknown`. Neither
  // proves the branch under test.
  const probeGateway = gatewayCheck
    || (() => checkGateway({ configPath: configPath || OPENCLAW_CONFIG_PATH }));

  // /health is unauthenticated, and the gateway probe it now runs is an
  // outbound request. Without this a flood of /health hits would be amplified
  // one-for-one into the gateway — the process the check exists to protect.
  // Five seconds is far shorter than any monitor's interval, so a real
  // operator or uptime check still sees the current state.
  let gatewayCache = { at: 0, value: null };
  const cacheMs = Number.isFinite(gatewayCacheMs) ? gatewayCacheMs : 5000;
  async function cachedGateway() {
    const now = Date.now();
    if (gatewayCache.value && now - gatewayCache.at < cacheMs) return gatewayCache.value;
    // A probe that THREW must not take the whole endpoint down with it: the
    // page's job is to report, and "the check itself broke" is `unknown`, not
    // an outage.
    let value;
    try { value = await probeGateway(); }
    catch (e) { value = { status: 'unknown', detail: `probe failed: ${e.message}`, port: null }; }
    gatewayCache = { at: now, value };
    return value;
  }

  const server = http.createServer(async (req, res) => {
    try {
      // ---- public routes, ahead of Basic Auth ----------------------------
      // Google redirects the USER's browser here, so this cannot sit behind
      // the admin password. It is safe to expose because it grants nothing on
      // its own: it acts only on a `state` we minted — random, single-use,
      // 15-minute TTL, bound to one user and one access level — and that state
      // is redeemed BEFORE any call to Google, so an invalid one costs a
      // static 400 and no outbound request.
      //
      // Exact pathname compare, never a prefix: req.url is attacker-supplied.
      // (/health above compares the raw string only because it never carries a
      // query; this route always does.)
      const parsed = new URL(req.url, 'http://x');
      if (req.method === 'GET' && parsed.pathname === '/oauth/google/callback') {
        const q = parsed.searchParams;
        const state = q.get('state');
        // A plain read, before either domain redeems anything: which provider
        // this state was minted for decides which module's completeOAuth gets
        // to burn it. Redemption itself stays atomic and provider-filtered
        // inside each completeOAuth, so a missing/unknown state just falls
        // through to calendar's existing bad_state answer — this peek only
        // ever narrows which module is asked, never grants anything.
        let provider = 'google_calendar';
        if (state) {
          try {
            const { rows } = await pool.query(`SELECT provider FROM oauth_states WHERE state = $1`, [state]);
            if (rows[0]) provider = rows[0].provider;
          } catch { /* fall through to calendar's own bad_state answer */ }
        }
        // A map rather than a ternary: this is the third Google product to
        // land on one callback, and a nested ternary is how a route like this
        // stops being readable. Anything unrecognised still falls through to
        // calendar's own bad_state answer, exactly as before.
        const flowFor = { google_contacts: googleContacts, gmail: mail, google_connect: googleConnect };
        const flow = flowFor[provider] || calendar;
        const isContacts = provider === 'google_contacts';
        const isMail = provider === 'gmail';
        const isConnect = provider === 'google_connect';
        let result;
        try {
          result = await withTx(pool, (client) => flow().completeOAuth(client, {
            state, code: q.get('code'), error: q.get('error'),
          }, googleOpts || {}));
        } catch (e) {
          console.error('[oauth] callback failed:', e);
          result = { ok: false, error: { code: 'internal' } };
        }
        const page = (code, title, body) => {
          res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(oauthResultPage(title, body));
        };
        if (result.ok) {
          if (isConnect) {
            // Same card rule as calendar/mail below — connecting calendar or
            // mail here happens over HTTP, outside any tool call, so
            // brokerd's per-tool card refresh never sees it.
            if (result.data.connected.calendar || result.data.connected.mail) {
              const { refreshUserCard } = require('../../intake/user-card');
              await refreshUserCard(pool, result.data.userId);
            }
            const got = result.data.connectedLabel || [];
            const missingHe = { calendar: 'יומן', contacts: 'אנשי קשר', mail: 'מייל' };
            const missed = (result.data.missing || []).map((k) => missingHe[k] || k);
            const gotLine = got.length ? `חובר: ${got.join(', ')}.` : '';
            const missLine = missed.length
              ? ` לא סומן בגוגל ולכן לא חובר: ${missed.join(', ')} — אפשר לבקש קישור חדש ולסמן גם את זה.`
              : '';
            return page(200, 'החיבור לגוגל הושלם ✅', `${gotLine}${missLine} אפשר לחזור לוואטסאפ.`.trim());
          }
          if (isMail) {
            // The card carries mail state (the agent reads it every turn),
            // and connecting happens HERE — an HTTP route, not a tool — so
            // brokerd's per-tool card refresh never sees it. After the
            // commit, same rule as every card write.
            const { refreshUserCard } = require('../../intake/user-card');
            await refreshUserCard(pool, result.data.userId);
            return page(200, 'תיבת המייל חוברה ✅', 'אולמה יכולה לחפש במיילים שלך כשתבקש — היא לא עוברת עליהם מיוזמתה, ולא יכולה לשלוח, להשיב או למחוק כלום. אפשר לחזור לוואטסאפ.');
          }
          if (isContacts) {
            // Unlike calendar, connecting contacts changes nothing on the
            // card by itself — the address-book COUNT only moves once the
            // import tool actually runs (see contacts_connected below), so
            // there is no refreshUserCard call here.
            return page(200, 'אנשי הקשר חוברו ✅', 'אולמה תייבא אותם עכשיו ותעדכן אותך בוואטסאפ כמה נשמרו. אפשר לחזור לשם.');
          }
          // The card carries calendar state, and connecting happens HERE — an
          // HTTP route, not a tool — so brokerd's per-tool refresh never sees
          // it. After the commit, same rule as every card write.
          const { refreshUserCard } = require('../../intake/user-card');
          await refreshUserCard(pool, result.data.userId);
          return page(200, 'היומן חובר ✅', result.data.accessLevel === 'read_write'
            ? 'אולמה יכולה לראות את היומן שלך וגם להוסיף ולערוך אירועים. אפשר לחזור לוואטסאפ.'
            : 'אולמה יכולה לראות את היומן שלך בלבד — היא לא תוכל לשנות בו דבר. אפשר לחזור לוואטסאפ.');
        }
        const reason = result.error && result.error.reason;
        if (reason === 'declined') return page(200, 'לא חובר', 'ביטלת את החיבור. אפשר לנסות שוב מתי שתרצה.');
        if (reason === 'no_calendar_scope') return page(200, 'חסרה הרשאת יומן', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה ליומן, אז גוגל לא נתנה גישה ליומן. אולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של היומן לפני שלוחצים המשך.');
        if (reason === 'no_mail_scope') return page(200, 'חסרה הרשאת מייל', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה למייל, אז גוגל לא נתנה גישה לתיבה. אולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של המייל לפני שלוחצים המשך.');
        if (reason === 'no_contacts_scope') return page(200, 'חסרה הרשאת אנשי קשר', 'במסך של גוגל לא סומנה תיבת הסימון ליד ההרשאה לאנשי קשר, אז גוגל לא נתנה גישה. אולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבה של אנשי הקשר לפני שלוחצים המשך.');
        if (reason === 'no_scope_granted') return page(200, 'לא חובר כלום', 'במסך של גוגל לא סומנה אף תיבה, אז שום דבר לא חובר. אולמה תשלח לך קישור חדש בוואטסאפ — הפעם סמני את התיבות שרוצים לפני שלוחצים המשך.');
        if (reason === 'bad_state') return page(400, 'הקישור פג', 'קישורי חיבור תקפים ל-15 דקות ולשימוש אחד. בקשי מאולמה קישור חדש.');
        return page(400, 'משהו השתבש', 'החיבור לא הושלם. בקשי מאולמה קישור חדש.');
      }

      // The availability picker — public like the OAuth callback and for the
      // same reason: the person taps it from WhatsApp on their phone, so it
      // cannot sit behind the admin password. The token in the path is the
      // whole credential (random, user-bound, time-limited; picker.js).
      const pick = parsed.pathname.match(picker.TOKEN_RE);
      if (pick) {
        return picker.handle(req, res, pool, pick[1], { calendarDomain });
      }

      // The PERSONAL dashboard — the page a user opens about themselves, as
      // opposed to everything below this line, which is the operator's page
      // about everybody. Ahead of Basic Auth for the same reason as the two
      // routes above it: the person taps it from WhatsApp on their phone and
      // has no admin password. It carries its own identity model (a one-time
      // link exchanged for a session cookie; domain/dashboard-auth.js), and
      // every route inside it refuses without one.
      if (userDashboard.matches(parsed.pathname)) {
        return userDashboard.handle(req, res, pool, parsed.pathname);
      }

      // Unauthenticated READINESS probe, for the deploy gate specifically —
      // "did the release we just restarted come up", nothing more.
      //
      // This exists because /health below cannot answer that question. /health
      // is 503 whenever any sweep is late, and a sweep's lateness is a property
      // of the PREVIOUS process: five seconds after a restart no job has had
      // its first tick, so the heartbeat table still describes the old one.
      // Gating a deploy on it meant that once any slow job fell behind, every
      // deploy failed its check, rolled back, failed the check again (a
      // rollback cannot make a sweep on time either) and reported the rollback
      // itself as broken. Observed 2026-08-22: two consecutive merges to main
      // rolled back this way, and the change that would have fixed the
      // underlying staleness was one of the two things it refused to deploy.
      //
      // brokerd's own heartbeat is the right signal: it is written once
      // immediately at startup and then every 60s, so a fresh, correctly armed
      // daemon has one within seconds, and a daemon that crashed on boot or
      // never reached its timers does not.
      if (req.url === '/ready') {
        try {
          await pool.query('SELECT 1');
          const { rows } = await pool.query(
            `SELECT extract(epoch from now() - last_run_at) AS age
             FROM job_heartbeats WHERE job_name = 'brokerd'`);
          const age = rows[0] ? Number(rows[0].age) : null;
          const ok = age !== null && age < BROKERD_BEAT_MAX_AGE_S;
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok, brokerdBeatAgeSeconds: age }));
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'db unavailable' }));
        }
      }

      // Unauthenticated liveness probe for MONITORING — the process, the DB,
      // whether every sweep is running on its declared cadence, and since
      // 2026-09-03 the GATEWAY. Deploys use /ready above; this one is allowed
      // to go red for reasons a redeploy would not fix, which is the whole
      // point of it — and the gateway is exactly such a reason, which is why
      // it can be added here and could not be added there.
      if (req.url === '/health') {
        // Probed outside the try: a dead DB and a dead gateway are two
        // separate facts, and the endpoint that exists to say which thing
        // broke must not collapse them into one line.
        const gateway = await cachedGateway();
        try {
          await pool.query('SELECT 1');
          const { rows } = await pool.query(`SELECT job_name, last_run_at, note FROM job_heartbeats`);
          const verdict = assessJobs(rows);
          // `unknown` is deliberately not red — see gateway-health.js.
          const ok = verdict.ok && gateway.status !== 'down';
          res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...verdict, ok, gateway: publicGateway(gateway) }));
        } catch (e) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'db unavailable', gateway: publicGateway(gateway) }));
        }
      }
      // ---- the two pages a stranger on allma.world is allowed to read ----
      //
      // Google's OAuth verification requires a working home page describing
      // what the app does and a reachable privacy policy on the same domain,
      // or the "hasn't verified this app" screen never goes away. Both sit
      // AHEAD of Basic Auth for the same reason /pick/ and the OAuth callback
      // do: the people who need them are not admins.
      //
      // `/` is the load-bearing subtlety. On olmachat.duckdns.org it is the
      // ADMIN DASHBOARD and must stay behind the password, so the public home
      // page is served for the PUBLIC hostnames only and every other host
      // falls straight through to the dashboard exactly as before. Caddy
      // already refuses to route `/` from allma.world to this process at all
      // until its allowlist says so — this check is the second lock, so that
      // a Caddyfile edit alone can never expose the admin root.
      if (req.method === 'GET' && parsed.pathname === '/privacy') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(publicPages.privacyPage());
      }
      if (req.method === 'GET' && parsed.pathname === '/' && PUBLIC_HOSTS.has(hostOf(req))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(publicPages.homePage());
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
        let cardUserId = null;
        await withTx(pool, async (client) => {
          if (url.pathname === '/boost') {
            // The dashboard writes the FLAG and never the gateway config —
            // jobs/boost.js is the only writer, so a click cannot leave the
            // config half-changed and a crash here self-heals on the next tick.
            const model = await flagsDomain.getFlag(client, boostJob.MODEL_FLAG);
            if (body.action === 'on') {
              let live = null;
              try { live = boostDomain.currentModel(occ.loadConfig(OPENCLAW_CONFIG_PATH)); } catch { live = null; }
              const r = boostDomain.engageState(live, model, new Date());
              // A refusal changes nothing at all — same rule as a malformed
              // flag value. Better an unchanged switch than a boost with no
              // way back.
              if (r.ok) {
                await flagsDomain.setFlag(client, boostJob.STATE_FLAG, r.state);
                await auditDomain.record(client, null, 'admin.boost_on',
                  { model, restoreTo: r.state.restore.model, until: r.state.until });
              } else {
                await auditDomain.record(client, null, 'admin.boost_refused', { reason: r.error });
              }
            } else if (body.action === 'off') {
              // Off is a flag write too: the reconciler sees an expired state
              // next tick and restores the captured default properly. Clearing
              // the state here without putting the config back would strand
              // everyone on the demo model.
              const cur = await flagsDomain.getFlag(client, boostJob.STATE_FLAG);
              if (boostDomain.isEngaged(cur)) {
                await flagsDomain.setFlag(client, boostJob.STATE_FLAG,
                  { ...cur, until: new Date(Date.now() - 1000).toISOString() });
                await auditDomain.record(client, null, 'admin.boost_off', { model: cur.model });
              }
            }
          } else if (url.pathname === '/flags' && EDITABLE_FLAGS.includes(body.key)) {
            // Coerce by declared type — a stray character must never turn a
            // number into a string and silently change live behaviour.
            const spec = FLAG_SPECS.find((f) => f.key === body.key);
            let val;
            if (spec.type === 'bool') val = body.value === 'true';
            else if (spec.type === 'text') {
              // Free text (model ids, phone lists) — trimmed and bounded, and
              // never coerced: an empty value falls back to the code default.
              val = String(body.value || '').trim().slice(0, 300) || null;
            } else if (spec.type === 'json') {
              // Parsed AND shape-checked before it can land. A flag the page
              // later reads as an object must never be able to hold a string:
              // unparseable or wrong-shaped input changes nothing at all,
              // exactly like the numeric typo rule below.
              try {
                const parsed = JSON.parse(String(body.value || '').trim() || '{}');
                val = (!spec.validate || spec.validate(parsed)) ? parsed : null;
              } catch { val = null; }
            } else {
              val = Number(body.value);
              if (!Number.isFinite(val) || val < 0) val = null;
            }
            if (val !== null) await flagsDomain.setFlag(client, body.key, val);
          } else if (url.pathname === '/issues/status') {
            await issuesDomain.setStatus(client, Number(body.id), body.status);
          } else if (url.pathname === '/users/quota') {
            // A non-numeric override would reach Postgres as NaN and abort the
            // whole transaction with a 500 — an operator typo must simply not
            // change anything.
            const parsed = parseInt(body.override, 10);
            const override = body.override === '' ? null : parsed;
            if (override === null || Number.isFinite(override)) {
              await client.query(`UPDATE users SET quota_override_daily = $2 WHERE id = $1`, [Number(body.id), override]);
            }
          } else if (url.pathname === '/users/delete') {
            // Keyed by phone, not row id: the confirmation page the operator
            // read was about a specific person, and the phone is what the
            // gateway config and workspace are keyed on anyway.
            if (/^\+\d{7,15}$/.test(body.phone || '')) {
              await deprovisionUser(client, body.phone, { configPath });
            }
          } else if (url.pathname === '/users/resume'
                     || url.pathname.startsWith('/outbox/') || url.pathname.startsWith('/prefs/')
                     || url.pathname.startsWith('/facts/')) {
            cardUserId = await handleUserEdit(client, url.pathname, body);
          }
        });
        // The card is rewritten only after the transaction committed — the same
        // rule brokerd follows. A file write inside the transaction would leave
        // USER.md describing a state the database rolled back.
        if (cardUserId) await refreshUserCard(pool, cardUserId);
        res.writeHead(303, { Location: safeBack(body.back) });
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
        } else if (url.pathname === '/contacts') {
          // Its own page, not a section: an address book runs to thousands of
          // rows, which is the one thing the single-page layout cannot hold.
          sectionsHtml = await renderContactsPage(client, {
            q: url.searchParams.get('q') || '',
            onlyOlma: url.searchParams.get('only') === 'olma',
            page: Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0),
          });
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
