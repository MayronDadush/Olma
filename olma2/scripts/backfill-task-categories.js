#!/usr/bin/env node
// Give every existing task the closed-set category it should always have had.
//
// tasks.category was documented as a closed set and enforced as free text, so
// production accumulated thirteen vocabularies across 62 rows and the page —
// which only knows six keys — drew every one of them as uncategorised. The
// write paths now decide the value in code (src/domain/task-category.js);
// this is the one-off that catches up the rows written before they did.
//
// Three passes, cheapest first, and a row is only touched if one of them
// produces a key:
//   1. the value already there, folded onto a key   (`בריאות` → health)
//   2. the title                                    (`תור רופא` → health)
//   3. the parent project's category                (`ירקות` under `סופר`)
//
// A row a person has categorised themselves (category_auto = false AND already
// on a key) is never touched, and neither is a row nothing can place — `נוח`
// or `Lunch with Maor` stay uncategorised, which is the honest answer. Rerunning
// is safe: pass 1 is idempotent and passes 2 and 3 only ever fill a blank.
//
// Usage: node scripts/backfill-task-categories.js [--apply]
'use strict';
const { createPool } = require('../src/db/pool');
const { CATEGORIES, normaliseCategory, classifyText } = require('../src/domain/task-category');

const APPLY = process.argv.includes('--apply');
const KEYS = new Set(CATEGORIES);

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, owner_id, title, category, category_auto, parent_id
       FROM tasks ORDER BY parent_id NULLS FIRST, id`);

  // Parents are visited first (NULLS FIRST above), so by the time a subtask is
  // judged its project already holds whatever this run decided for it.
  const decided = new Map();
  const plan = [];
  let kept = 0, unplaced = 0;

  for (const t of rows) {
    const current = t.category && KEYS.has(t.category) ? t.category : null;
    if (current && !t.category_auto) { decided.set(t.id, current); kept++; continue; }

    const parentCat = t.parent_id ? decided.get(t.parent_id) || null : null;
    const next = normaliseCategory(t.category) || classifyText(t.title) || parentCat;

    if (!next) { unplaced++; continue; }
    decided.set(t.id, next);
    if (next === current) { kept++; continue; }
    plan.push({ id: t.id, ownerId: t.owner_id, title: t.title, from: t.category, to: next });
  }

  for (const p of plan) {
    console.log(`#${p.id} u${p.ownerId} ${String(p.from || '—').padEnd(10)} → ${p.to.padEnd(8)} ${p.title.slice(0, 60)}`);
  }
  console.log(`\n${plan.length} to change, ${kept} already right, ${unplaced} nothing to say (of ${rows.length}).`);

  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to write.');
    await pool.end();
    return;
  }
  for (const p of plan) {
    await pool.query(
      `UPDATE tasks SET category = $2, category_auto = true WHERE id = $1`, [p.id, p.to]);
  }
  console.log(`Wrote ${plan.length}.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
