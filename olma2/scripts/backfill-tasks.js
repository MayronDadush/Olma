#!/usr/bin/env node
// Catch existing tasks up with what the write paths now decide for new ones:
// a closed-set CATEGORY, and a KIND. Both are pure functions of the row, so
// this script is the same two decisions applied to the rows that were written
// before anything made them.
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
// KIND ('event' | 'todo', src/domain/task-kind.js) is the riskier half, and it
// is worth being clear about what applying it does: an open task judged
// 'event' whose moment is already past becomes eligible for the auto-archive
// sweep, which will close it and TELL THE PERSON on its next tick. That is the
// intended behaviour — an appointment from three weeks ago is not a task — but
// it means running this with --apply sends real messages to real people, so
// read the dry run first and look at what is about to move.
//
// Kind is only ever written where it is NULL. A row somebody has already
// judged is never re-judged.
//
// Usage: node scripts/backfill-tasks.js [--apply]
'use strict';
const { createPool } = require('../src/db/pool');
const { CATEGORIES, normaliseCategory, classifyText } = require('../src/domain/task-category');
const { decideKind } = require('../src/domain/task-kind');

const APPLY = process.argv.includes('--apply');
const KEYS = new Set(CATEGORIES);

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, owner_id, title, category, category_auto, parent_id, kind, status,
            due_at, ends_at, archived_at
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

  // ---- kind ----------------------------------------------------------------
  const kinds = [];
  const willSweep = [];
  const cutoff = Date.now() - 3 * 3600_000;
  for (const t of rows) {
    if (t.kind) continue;
    const kind = decideKind({ title: t.title });
    kinds.push({ id: t.id, ownerId: t.owner_id, title: t.title, kind });
    const at = t.ends_at || t.due_at;
    if (kind === 'event' && t.status === 'open' && !t.archived_at
        && at && new Date(at).getTime() < cutoff) {
      willSweep.push({ id: t.id, ownerId: t.owner_id, title: t.title, at });
    }
  }

  for (const p of plan) {
    console.log(`cat  #${p.id} u${p.ownerId} ${String(p.from || '—').padEnd(10)} → ${p.to.padEnd(8)} ${p.title.slice(0, 60)}`);
  }
  console.log(`\ncategories: ${plan.length} to change, ${kept} already right, ${unplaced} nothing to say (of ${rows.length}).`);
  console.log(`kinds:      ${kinds.length} to set (${kinds.filter((k) => k.kind === 'event').length} event, ${kinds.filter((k) => k.kind === 'todo').length} todo).`);

  // The loud part. Everything below leaves somebody's list on the next sweep
  // tick and produces a message saying so.
  if (willSweep.length) {
    console.log(`\n⚠ ${willSweep.length} open task(s) become eligible for auto-archive IMMEDIATELY, and their owners will be told:`);
    for (const w of willSweep) {
      console.log(`   u${w.ownerId} #${w.id} ${new Date(w.at).toISOString().slice(0, 16)}  ${w.title.slice(0, 60)}`);
    }
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write.');
    await pool.end();
    return;
  }
  for (const p of plan) {
    await pool.query(
      `UPDATE tasks SET category = $2, category_auto = true WHERE id = $1`, [p.id, p.to]);
  }
  for (const k of kinds) {
    await pool.query(`UPDATE tasks SET kind = $2 WHERE id = $1 AND kind IS NULL`, [k.id, k.kind]);
  }
  console.log(`Wrote ${plan.length} categories and ${kinds.length} kinds.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
