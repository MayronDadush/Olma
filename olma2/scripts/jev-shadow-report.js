#!/usr/bin/env node
// What Jev said beside the code about new tasks (jobs/twin-shadow.js), read
// back for the owner. Read-only: every statement is a SELECT, and it prints
// no user id — titles only, because a disagreement cannot be judged without
// them, and they are the owner's to read on the box.
//
//   node scripts/jev-shadow-report.js              # the last 7 days
//   node scripts/jev-shadow-report.js --days 14
//   node scripts/jev-shadow-report.js --floor 0.6  # Jev picks below this count as "none"
//
// The floor is the one number a rung-2 PR would set. Run #91 found 0.6 on the
// owner's labelled pairs; this is where that number meets real tasks.
'use strict';
const { createPool } = require('../src/db/pool');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const DAYS = Number(arg('days', 7)) || 7;
const FLOOR = Number(arg('floor', 0.6));

const q = (p, pct) => {
  if (!p.length) return 0;
  const s = [...p].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(pct * s.length))];
};

(async () => {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT s.*, t.title AS title, ct.title AS code_title, bt.title AS best_title, jt.title AS jev_title
         FROM task_twin_shadow s
         JOIN tasks t ON t.id = s.task_id
         LEFT JOIN tasks ct ON ct.id = s.code_twin_id
         LEFT JOIN tasks bt ON bt.id = s.code_best_id
         LEFT JOIN tasks jt ON jt.id = s.jev_pick_id
        WHERE s.created_at > now() - ($1::int * interval '1 day')
        ORDER BY s.created_at`, [DAYS]);
    const { rows: cost } = await pool.query(
      `SELECT coalesce(sum(cost_usd), 0) AS usd, coalesce(sum(input_tokens), 0) AS tokens
         FROM usage_system_ledger WHERE agent_id = 'jev-shadow' AND date > current_date - $1::int`, [DAYS]);
    const { rows: flag } = await pool.query(`SELECT value FROM feature_flags WHERE key = 'jev_shadow_twins'`);

    const asked = rows.filter((r) => r.list_size > 0 && !r.jev_error);
    const jevSays = (r) => (r.jev_pick_id != null && Number(r.jev_confidence ?? 0) >= FLOOR ? String(r.jev_pick_id) : null);
    const codeSays = (r) => (r.code_twin_id != null ? String(r.code_twin_id) : null);
    const buckets = { bothNone: [], bothSame: [], codeOnly: [], jevOnly: [], differentRow: [] };
    for (const r of asked) {
      const c = codeSays(r); const j = jevSays(r);
      if (!c && !j) buckets.bothNone.push(r);
      else if (c && j && c === j) buckets.bothSame.push(r);
      else if (c && !j) buckets.codeOnly.push(r);
      else if (!c && j) buckets.jevOnly.push(r);
      else buckets.differentRow.push(r);
    }
    const ms = asked.map((r) => r.latency_ms).filter((x) => x != null);

    console.log(`Jev shadow — last ${DAYS} days · flag ${flag[0] ? JSON.stringify(flag[0].value) : 'unset (off)'} · floor ${FLOOR}`);
    console.log(`${rows.length} new tasks read · ${rows.length - asked.length - rows.filter((r) => r.jev_error).length} had nothing open before them · ${rows.filter((r) => r.jev_error).length} errors`);
    console.log(`${asked.length} asked · $${Number(cost[0].usd).toFixed(5)} · ${cost[0].tokens} input tokens · latency median ${q(ms, 0.5)}ms p95 ${q(ms, 0.95)}ms`);
    console.log('');
    console.log(`both: no twin ................ ${buckets.bothNone.length}`);
    console.log(`both: the same twin .......... ${buckets.bothSame.length}`);
    console.log(`code found a twin, Jev none .. ${buckets.codeOnly.length}`);
    console.log(`Jev found a twin, code none .. ${buckets.jevOnly.length}   ← the rows a rung 2 would be for`);
    console.log(`they picked different rows ... ${buckets.differentRow.length}`);

    const show = (title, list, line) => {
      if (!list.length) return;
      console.log(`\n${title}`);
      for (const r of list) console.log(`  ${line(r)}`);
    };
    const conf = (r) => (r.jev_confidence == null ? '  —' : `${String(Math.round(Number(r.jev_confidence) * 100)).padStart(3)}%`);
    show('Jev found a twin the code did not — is the new task really the same as the one Jev picked?', buckets.jevOnly,
      (r) => `${conf(r)}  ${r.title}  ⇄  ${r.jev_title ?? '(since deleted)'}   [code's closest: ${Number(r.code_best_score ?? 0).toFixed(2)}]`);
    show('The code found a twin and Jev did not:', buckets.codeOnly,
      (r) => `${r.code_reason}  ${r.title}  ⇄  ${r.code_title ?? '(since deleted)'}   [Jev: ${r.jev_title ? `${conf(r)} ${r.jev_title}` : 'none'}]`);
    show('They picked different rows:', buckets.differentRow,
      (r) => `${r.title}  → code: ${r.code_title}  · Jev ${conf(r)}: ${r.jev_title}`);
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
