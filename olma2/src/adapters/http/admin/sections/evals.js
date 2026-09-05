'use strict';
// evals — one section of the admin page (see ../index.js).
// Moved verbatim out of adapters/http/dashboard.js on 2026-09-05; the router
// there is what is left of that file.
const { ago } = require('../html');
const evalsJob = require('../../../../jobs/evals');
const { esc } = require('../../html');

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

module.exports = { summariseSnapshot, renderEvals };
