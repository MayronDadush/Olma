'use strict';
// experiments — the A/B tests (domain/experiments.js), one table each, and the
// owner's button to end one. The page never ends one by itself.
const experiments = require('../../../../domain/experiments');
const { esc } = require('../../html');

const pct = (x, n) => (n ? `${Math.round((100 * x) / n)}%` : '—');

function verdictLine(r) {
  const v = r.verdict;
  if (v.call === 'early') {
    return `<p class="small dim">עוד מוקדם — צריך לפחות ${experiments.MIN_DONE} אנשים שחלון המדידה שלהם נסגר בכל קבוצה. עד אז כל הבדל כאן יכול להיות מקרי.</p>`;
  }
  if (v.call === 'no_difference') {
    return `<p class="small">אין הבדל ברור בין הגרסאות (p=${v.p === null ? '—' : v.p.toFixed(2)}). סביר לקבע את הפשוטה מביניהן.</p>`;
  }
  return `<p class="small"><b>גרסה ${v.call.toUpperCase()} עובדת טוב יותר</b> (p=${v.p.toFixed(3)}). ההחלטה אם לקבע אותה — שלך.</p>`;
}

function lockForm(r, csrf) {
  const hidden = `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="back" value="/#experiments">
    <input type="hidden" name="key" value="${esc(r.key)}">`;
  if (r.locked) {
    return `<form method="post" action="/experiments/lock" class="inline">${hidden}
      <input type="hidden" name="variant" value="">
      <span class="small">נקבעה גרסה <b>${esc(r.locked.toUpperCase())}</b> — כולם מקבלים אותה והניסוי לא נמדד.</span>
      <button type="submit">להחזיר לניסוי</button></form>`;
  }
  return ['a', 'b'].map((v) => `<form method="post" action="/experiments/lock" class="inline">${hidden}
      <input type="hidden" name="variant" value="${v}"><button type="submit">לקבע את ${v.toUpperCase()}</button></form>`).join(' ');
}

async function renderExperiments(client, csrf) {
  const out = [];
  for (const key of Object.keys(experiments.EXPERIMENTS)) {
    const r = await experiments.results(client, key);
    out.push(`<h4>${esc(r.title)}</h4>
      <p class="hint">נחשפו = ${esc(r.exposure)}. הצליח = ${esc(r.outcome)}. נספרים רק מי שחלון ה־${r.windowDays} ימים שלהם כבר נסגר.</p>
      <table><tr><th>גרסה</th><th>מה שונה</th><th>נחשפו</th><th>חלון נסגר</th><th>הצליח</th><th>אחוז</th></tr>
      ${r.arms.map((a) => `<tr><td>${a.variant.toUpperCase()}</td><td>${esc(a.label)}</td><td>${a.exposed}</td>
        <td>${a.done}</td><td>${a.converted}</td><td>${pct(a.converted, a.done)}</td></tr>`).join('')}
      </table>
      ${verdictLine(r)}
      <div>${lockForm(r, csrf)}</div>`);
  }
  return out.join('') || '<p class="dim">אין ניסויים פעילים.</p>';
}

module.exports = { renderExperiments, verdictLine };
