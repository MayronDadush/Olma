#!/usr/bin/env node
// Close the issues the eval user filed before report_issue was sealed.
//
// The nightly suite replays real past incidents, and several of them end in a
// correct refusal whose doctrine says to log a feature_request — so the same
// rows were filed again every night. On 2026-09-03 seven of the eight open
// issues were the test account talking to itself, and the one real issue (a
// leaked identity token) was one row in eight.
//
// domain/issues.js stops new ones. This retires the backlog.
//
// wontfix, never DELETE: the rows are honest history of what the suite did,
// and an operator list that silently loses rows is worse than one carrying a
// few closed ones. They stop showing because the dashboard lists open issues.
//
// Usage: node scripts/retire-eval-issues.js [--apply]
'use strict';
const { createPool } = require('../src/db/pool');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  try {
    // Keyed on is_eval, never on the issue text: a real person hitting the
    // same gap files a real request, and matching on "essay" would retire it.
    const { rows } = await pool.query(
      `SELECT i.id, i.category, i.title, i.created_at::date AS day
         FROM issues i JOIN users u ON u.id = i.reporter_id
        WHERE u.is_eval = true AND i.status IN ('new', 'triaged')
        ORDER BY i.id`);

    if (!rows.length) { console.log('nothing to retire'); return; }
    for (const r of rows) console.log(`  ${APPLY ? '→' : '·'} #${r.id} ${r.day} ${r.title.slice(0, 70)}`);

    if (!APPLY) { console.log(`\n${rows.length} to retire — dry run, pass --apply`); return; }
    const { rowCount } = await pool.query(
      `UPDATE issues SET status = 'wontfix', updated_at = now()
        WHERE id = ANY($1::bigint[]) AND status IN ('new', 'triaged')`,
      [rows.map((r) => r.id)]);
    // An admin.* row so the trail says an operator closed these, not the agent.
    await pool.query(
      `INSERT INTO audit_log (actor_id, event, detail) VALUES (NULL, 'admin.eval_issues_retired', $1::jsonb)`,
      [JSON.stringify({ ids: rows.map((r) => Number(r.id)), reason: 'filed by the eval user before report_issue was sealed' })]);
    console.log(`\n${rowCount} retired`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
