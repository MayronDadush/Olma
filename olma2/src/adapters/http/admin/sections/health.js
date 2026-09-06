'use strict';
// health — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { OPENCLAW_CONFIG_PATH } = require('../env');
const { fmt, ago } = require('../html');
const { prepaidLow } = require('./cost');
const flagsDomain = require('../../../../domain/flags');
const occ = require('../../../../intake/openclaw-config');
const boostDomain = require('../../../../domain/boost');
const boostJob = require('../../../../jobs/boost');
const { assessJobs, isStale } = require('../../../../jobs/expectations');
const evalsJob = require('../../../../jobs/evals');
const infraCost = require('../../../infra-cost');
const { readReleaseMarker } = require('../../../release-marker');
const { checkGateway } = require('../../../gateway-health');
// ---- helpers ----------------------------------------------------------------
const { esc } = require('../../html');

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
  liveness_watch: 'שומר חיים: שער התקשורת ומשלוח ההודעות (מפעיל מחדש שער שנפל)',
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
// The doctrine (AGENTS.md) against the gateway's injection ceiling. Over the
// line nothing is announced: the gateway keeps a head and a tail and deletes
// the middle of some section, on every turn, for every user — and the file
// has sat one character under the line since 2026-09-04. tests/intake.test.js
// stops a change that crosses it; this row is what lets a person SEE the
// margin instead of learning it from a red test. Rendered from the template
// with a token-shaped placeholder, exactly as efficiency_watch measures it.
// The ceiling is the GATEWAY'S setting (agents.defaults.bootstrapMaxChars in
// openclaw.json; the box sets 40,000, the gateway's own default is 20,000).
// A config that cannot be read gives an UNKNOWN ceiling, never the default:
// judging 39k chars against 20k would show a red row for a doctrine that
// fits — "a thing that could not be READ is never a thing in trouble".
// null when the doctrine itself cannot be measured — a meter that cannot
// read must not show a number.
function doctrineMeter(configPath) {
  try {
    const { renderAgentsMd } = require('../../../../intake/provision');
    const guard = require('../../../../jobs/config-guard');
    const chars = renderAgentsMd('olma_tok_' + '0'.repeat(32)).length;
    let limit = null;
    try { limit = guard.bootstrapBudget(occ.loadConfig(configPath)); } catch { limit = null; }
    if (limit === null) return { chars, limit: null, headroom: null, over: false, near: false };
    const headroom = limit - chars;
    return {
      chars, limit, headroom,
      over: headroom < 0,
      near: headroom >= 0 && headroom < guard.BOOTSTRAP_WARN_MARGIN,
    };
  } catch {
    return null;
  }
}

function doctrineRow(m) {
  if (!m) return '';
  const note = m.limit === null ? 'התקרה לא נקראה מהגדרות השער — אין שיפוט'
    : m.over ? 'מעל התקרה — השער מוחק מהאמצע בשקט, בכל תור'
      : m.near ? `נשארו ${fmt(m.headroom)} תווים — כל תוספת תיחתך בשקט`
        : `נשארו ${fmt(m.headroom)} תווים`;
  const warn = m.over || m.near;
  return `<tr class="${m.over ? 'bad' : ''}">
      <td>${m.over ? '⚠' : '–'} הדוקטרינה (AGENTS.md)</td>
      <td class="${warn ? 'warn' : 'dim'} mono">${fmt(m.chars)} / ${m.limit === null ? '?' : fmt(m.limit)}</td>
      <td class="${warn ? 'warn' : 'dim'}">${esc(note)}</td></tr>`;
}

// `ctx.configPath` is the router's injected gateway config (createDashboard's
// option), so the meter reads the same file the rest of the dashboard does;
// the module-level path is the fallback for a direct call without one.
// ---- the alerts strip -------------------------------------------------------
// The one thing to read before anything else: every signal the page already
// computes for its sections, lifted into a row of pills at the top of the
// open group. Zero new network calls and ONE new query (four scalar
// subqueries); the gateway state and the heartbeat rows arrive from the
// router, the prepaid balances come from infra-cost's 10-minute cache. A pill
// links to the section that explains it.
//
// Classes are alert-bad/alert-warn, never the bare `bad`/`warn` the tests
// slice sections by (tests/dashboard.test.js sectionOf/rowFor).
async function collectAlerts(client, { hbRows, gateway }) {
  const out = [];
  const bad = (text, href) => out.push({ level: 'bad', text, href });
  const warn = (text, href) => out.push({ level: 'warn', text, href });
  if (gateway && gateway.status === 'down') bad('שער התקשורת לא מגיב', '#health');
  const verdict = assessJobs(hbRows);
  for (const j of verdict.failing) bad(`${JOB_LABELS[j] || j}: נכשל`, '#health');
  for (const j of verdict.stale) bad(`${JOB_LABELS[j] || j}: תקוע`, '#health');
  const drift = driftLine(hbRows);
  if (drift.warn) warn(drift.text, '#health');
  try {
    const { rows } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM issues WHERE status IN ('new','triaged')) AS open_issues,
         (SELECT count(*)::int FROM outbox WHERE sent_at IS NULL AND attempts > 0) AS outbox_failing,
         (SELECT count(*)::int FROM task_reminders
            WHERE sent_at IS NULL AND cancelled_at IS NULL AND remind_at < now() AND attempts = 0) AS overdue_reminders,
         (SELECT reds + errors FROM eval_runs
            WHERE finished_at IS NOT NULL AND trigger <> $1 ORDER BY id DESC LIMIT 1) AS eval_bad`,
      [evalsJob.PILOT_TRIGGER]);
    const r = rows[0] || {};
    if (r.outbox_failing > 0) bad(`${r.outbox_failing} הודעות נכשלות בשליחה`, '#planned');
    if (r.overdue_reminders > 0) warn(`${r.overdue_reminders} תזכורות שעברו ולא יצאו`, '#planned');
    if (r.open_issues > 0) warn(`${r.open_issues} תקלות פתוחות`, '#issues');
    if (r.eval_bad > 0) warn(`${r.eval_bad} בדיקות התנהגות אדומות אמש`, '#evals');
  } catch (e) {
    // A query that failed is not a clean board — say so, in the strip itself.
    warn('לא ניתן לקרוא את מצב ההודעות והתקלות', '#health');
  }
  try {
    const c = await infraCost.getInfraCosts();
    const labels = { openrouter: 'OpenRouter', twilio: 'Twilio', deepgram: 'Deepgram' };
    for (const [k, label] of Object.entries(labels)) if (c[k] && prepaidLow(c[k])) bad(`יתרה נמוכה: ${label}`, '#cost');
  } catch { /* the cost section reports a billing API it cannot read; the strip stays silent about it */ }
  try {
    const state = await flagsDomain.getFlag(client, boostJob.STATE_FLAG);
    if (boostDomain.isEngaged(state) && !boostDomain.expired(state, new Date())) warn('מצב בוסט דלוק — עולה כסף לדקה', '#flags');
  } catch { /* a malformed flag is the flags section's problem */ }
  return out;
}

function renderAlerts(list) {
  if (!list.length) return '<div class="alerts"><span class="alert alert-ok">✓ אין התראות</span></div>';
  return `<div class="alerts">${list.map((a) =>
    `<a class="alert alert-${a.level}" href="${a.href}">${a.level === 'bad' ? '⚠' : '•'} ${esc(a.text)}</a>`).join('')}</div>`;
}

async function renderHeartbeats(client, _csrf, probe, ctx = {}) {
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

  // Like the release row: a fact about the deployment, not a process, so it
  // is never counted in the banner — unless it is OVER the line, which is a
  // live fault in every user's prompt and is counted as one.
  const doctrine = doctrineMeter(ctx.configPath || OPENCLAW_CONFIG_PATH);
  const docRow = doctrineRow(doctrine);
  const docBad = Boolean(doctrine && doctrine.over);

  const totalProblems = problems.length + (gwBad ? 1 : 0) + (docBad ? 1 : 0);
  const banner = totalProblems === 0
    ? `<div class="banner ok">✓ הכל תקין — ${rows.length + gwCounted} תהליכים רצים כסדרם</div>`
    : `<div class="banner bad">⚠ ${totalProblems} תהליכים דורשים תשומת לב</div>`;

  const jobRows = rows.map((r) => {
    const bad = isStale(r.job_name, r.last_run_at, now) || (r.note && String(r.note).startsWith('ERR'));
    const err = r.note && String(r.note).startsWith('ERR');
    return `<tr class="${bad ? 'bad' : ''}">
      <td>${bad ? '⚠' : '✓'} ${esc(JOB_LABELS[r.job_name] || r.job_name)}</td>
      <td class="dim">${r.last_run_at ? ago(r.last_run_at) : 'טרם רץ'}</td>
      <td class="dim mono">${err ? esc(String(r.note).slice(0, 90)) : ''}</td></tr>`;
  }).join('');
  const table = (body) => `<table><tr><th>תהליך</th><th>רץ לאחרונה</th><th>שגיאה</th></tr>${body}</table>`;
  // With nothing wrong, the twenty green job rows are a fold below the three
  // that carry news (gateway, release, doctrine); the banner already said all
  // of them are fine. With anything wrong, the whole table stays open — a
  // problem row must never sit behind a click.
  if (totalProblems === 0) {
    return banner + table(gwRow + relRow + docRow)
      + `<details class="sub"><summary class="dim small">כל ${rows.length} התהליכים — הצג</summary>${table(jobRows)}</details>`;
  }
  return banner + table(gwRow + relRow + docRow + jobRows);
}

module.exports = { JOB_LABELS, publicGateway, driftLine, doctrineMeter, doctrineRow, collectAlerts, renderAlerts, renderHeartbeats };
