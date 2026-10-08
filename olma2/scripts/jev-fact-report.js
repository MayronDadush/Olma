#!/usr/bin/env node
// What Jev said beside the code about new facts (jobs/fact-shadow.js), read back
// for the owner. Read-only: every statement is a SELECT, no user id is printed,
// and the words of a fact are, because a disagreement cannot be judged without
// them — they are the owner's to read on the box.
//
//   node scripts/jev-fact-report.js              # the last 7 days
//   node scripts/jev-fact-report.js --days 14
//   node scripts/jev-fact-report.js --floor 0.6  # answers below this count as "unsure"
//
// The two buckets that matter:
//   Jev says EVENT on a fact with NO end  — what the write gate cannot see
//   Jev found a twin the code did not     — "the same fact in other words"
'use strict';
const { createPool } = require('../src/db/pool');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const DAYS = Number(arg('days', 7)) || 7;
const FLOOR = Number(arg('floor', 0.6));
const pct = (x) => (x == null ? '  —' : `${String(Math.round(Number(x) * 100)).padStart(3)}%`);

(async () => {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT s.*, f.fact, f.category, f.importance, f.active,
              ct.fact AS code_text, jt.fact AS jev_text
         FROM fact_shadow s
         JOIN user_facts f ON f.id = s.fact_id
         LEFT JOIN user_facts ct ON ct.id = s.code_twin_id
         LEFT JOIN user_facts jt ON jt.id = s.jev_twin_id
        WHERE s.created_at > now() - ($1::int * interval '1 day')
        ORDER BY s.created_at`, [DAYS]);
    const { rows: cost } = await pool.query(
      `SELECT coalesce(sum(cost_usd), 0) AS usd, coalesce(sum(input_tokens), 0) AS tokens
         FROM usage_system_ledger WHERE agent_id = 'jev-shadow' AND date > current_date - $1::int`, [DAYS]);
    const { rows: flag } = await pool.query(`SELECT value FROM feature_flags WHERE key = 'jev_shadow_facts'`);

    const asked = rows.filter((r) => !r.jev_error);
    const sure = (r) => r.jev_life && Number(r.jev_life_conf ?? 0) >= FLOOR;
    const eventNoEnd = asked.filter((r) => sure(r) && r.jev_life === 'event' && !r.code_dated);
    const eventDated = asked.filter((r) => sure(r) && r.jev_life === 'event' && r.code_dated);
    const lasting = asked.filter((r) => sure(r) && r.jev_life === 'lasting');
    const other = asked.filter((r) => sure(r) && r.jev_life === 'other');
    const unsure = asked.filter((r) => !sure(r));
    const jevTwin = (r) => (r.jev_twin_id != null && Number(r.jev_twin_conf ?? 0) >= FLOOR ? String(r.jev_twin_id) : null);
    const codeTwin = (r) => (r.code_twin_id != null ? String(r.code_twin_id) : null);
    const jevOnly = asked.filter((r) => !codeTwin(r) && jevTwin(r));
    const codeOnly = asked.filter((r) => codeTwin(r) && !jevTwin(r));
    const both = asked.filter((r) => codeTwin(r) && codeTwin(r) === jevTwin(r));

    console.log(`Jev fact shadow — last ${DAYS} days · flag ${flag[0] ? JSON.stringify(flag[0].value) : 'unset (off)'} · floor ${FLOOR}`);
    console.log(`${rows.length} new facts read · ${asked.length} asked · ${rows.length - asked.length} errors · $${Number(cost[0].usd).toFixed(5)} · ${cost[0].tokens} input tokens`);
    console.log('');
    console.log(`lifespan   event, NO end ... ${eventNoEnd.length}   ← what the write gate cannot see`);
    console.log(`           event, has end .. ${eventDated.length}`);
    console.log(`           lasting ......... ${lasting.length}`);
    console.log(`           other ........... ${other.length}   (a request, an instruction — not a fact)`);
    console.log(`           unsure .......... ${unsure.length}`);
    console.log(`twin       Jev only ........ ${jevOnly.length}   ← the same fact in other words`);
    console.log(`           code only ....... ${codeOnly.length}`);
    console.log(`           both, same row .. ${both.length}`);

    const show = (title, list, line) => {
      if (!list.length) return;
      console.log(`\n${title}`);
      for (const r of list) console.log(`  ${line(r)}`);
    };
    show('Jev says an EVENT and it has no end — would it be wrong to give it one?', eventNoEnd,
      (r) => `${pct(r.jev_life_conf)}  [${r.category} ${r.importance}${r.active ? '' : ' forgotten'}]  ${r.fact}`);
    show('Jev says "other" — a request or instruction filed as a fact?', other,
      (r) => `${pct(r.jev_life_conf)}  [${r.category}]  ${r.fact}`);
    show('Jev found a twin the code did not — is it really the same fact?', jevOnly,
      (r) => `${pct(r.jev_twin_conf)}  ${r.fact}  ⇄  ${r.jev_text ?? '(since forgotten)'}   [code's closest: ${Number(r.code_best_score ?? 0).toFixed(2)}]`);
    show('The code found a twin and Jev did not:', codeOnly,
      (r) => `${r.fact}  ⇄  ${r.code_text ?? '(since forgotten)'}`);
    const errs = rows.filter((r) => r.jev_error);
    if (errs.length) {
      const by = {};
      for (const r of errs) by[r.jev_error] = (by[r.jev_error] || 0) + 1;
      console.log(`\nerrors: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    }
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
