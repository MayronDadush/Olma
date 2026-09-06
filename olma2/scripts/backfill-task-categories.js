#!/usr/bin/env node
'use strict';
// One-off repair for the rows that were written before `tasks.category` became
// a closed set (the validator landed 2026-09-05, c75c2e9). Production held
// thirteen private vocabularies in that column — `מוצר`, `ניהול & בירור`,
// `השקעות`, `personal`, `משותף` — and the page draws every one of them as
// "ללא קטגוריה", because not one is a key it knows.
//
// Nothing new is decided here. Each stranded row is put through the SAME
// classifier a task added today goes through, and takes whatever that says:
//   - a real key  → written, with category_auto = true (we guessed, not them)
//   - nothing     → the column is emptied, so the closed set is actually closed
// A row already holding a valid key is never touched, whoever chose it.
//
//   node scripts/backfill-task-categories.js            # says what it would do
//   node scripts/backfill-task-categories.js --apply    # does it
const { createPool, withTx } = require('../src/db/pool');
const taskCategory = require('../src/domain/task-category');

const KNOWN = taskCategory.CATEGORIES;
const apply = process.argv.includes('--apply');

async function main() {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT id, owner_id, category, title FROM tasks
        WHERE category IS NULL OR NOT (category = ANY($1::text[]))
        ORDER BY id`, [KNOWN]);

    const plan = rows.map((r) => ({ ...r, next: taskCategory.classifyText(r.title) }))
      // A NULL that stays NULL is not a change; an off-vocabulary string that
      // becomes NULL is.
      .filter((r) => r.next !== null || r.category !== null);

    const named = plan.filter((r) => r.next);
    const emptied = plan.filter((r) => !r.next);

    for (const r of plan) {
      const from = r.category === null ? '(none)' : r.category;
      console.log(`${String(r.id).padStart(5)}  ${from} → ${r.next || '(none)'}  ${r.title.replace(/\s+/g, ' ').slice(0, 56)}`);
    }
    console.log(`\n${rows.length} rows outside the set; ${named.length} get a category, `
      + `${emptied.length} lose a word that was never one, `
      + `${rows.length - plan.length} stay as they are.`);

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write it.');
      return;
    }
    await withTx(pool, async (client) => {
      for (const r of plan) {
        await client.query(
          `UPDATE tasks SET category = $2, category_auto = $3 WHERE id = $1`,
          [r.id, r.next, r.next !== null]);
      }
    });
    console.log(`\nWritten: ${plan.length} rows.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
