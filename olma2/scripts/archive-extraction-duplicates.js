#!/usr/bin/env node
// One-off cleanup for the duplicates jobs/fact-extraction.js wrote before
// domain/task-similarity.js existed to stop it (#405/#406, 2026-09-18).
// Measured on the box that evening: 51 tasks with source='extracted', 35 of
// them duplicates of something the person already had, 16 genuinely unique.
// This is the 35 — the ones still OPEN and still on somebody's list are the
// "fake" ones the owner asked about, and this archives exactly those.
//
// Why ARCHIVE and not DELETE: every reader in this codebase (findTwin, the
// digest counts, list_my_tasks, the personal dashboard) already filters
// `archived_at IS NULL`, so archiving removes a row from every place a
// person sees it just as completely as deleting the row would — and it does
// it through `tasks.archiveTask`, the same function a person's own "בטלי את
// זה" goes through, not a hand-rolled UPDATE. Nothing here ever runs DELETE.
// `tasks.unarchiveTask` is the undo, and every archive is also written as an
// `audit_log` row, so a week from now "why did this task disappear" has an
// answer on the box.
//
// The comparison is exactly `task-similarity.findTwin` — the function
// production itself would have called — run in TASK CREATION ORDER per
// owner, so a chain of three near-identical extracted tasks keeps the
// earliest and archives the later two, and a duplicate of something the
// person typed themselves is left for a human decision if it is NOT
// source='extracted' or NOT currently open (a task somebody already
// completed is never touched — completing it is what they decided, not a
// state this script gets an opinion on).
//
// Scoped deliberately narrow: only source = 'extracted', only status =
// 'open', only parent_id IS NULL (a checklist item is never compared, same
// as everywhere else this module is used). It does not touch the live
// add_task path's save-and-ask duplicates — those already got a sentence in
// front of the person at the time, which is a different thing than this.
//
// This talks to PERSONAL, sometimes MEDICAL task titles belonging to real
// users (`disagrees()` exists because of exactly one such pair). That is why
// this is a script a person runs over their own ssh and reads before
// --apply, and not an `olma2 ops` arm — ops.sh's own rule since 2026-09-18:
// "a measurement that has to show somebody's actual words is not an op and
// never becomes one."
//
// Usage:
//   OLMA_DB_URL=postgres://... node scripts/archive-extraction-duplicates.js
//   OLMA_DB_URL=postgres://... node scripts/archive-extraction-duplicates.js --apply
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const similarity = require('../src/domain/task-similarity');
const tasks = require('../src/domain/tasks');
const audit = require('../src/domain/audit');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT id, owner_id, title, source, status, created_at
       FROM tasks
      WHERE archived_at IS NULL AND parent_id IS NULL
      ORDER BY owner_id, created_at ASC, id ASC`);

  const byOwner = new Map();
  for (const r of rows) {
    if (!byOwner.has(r.owner_id)) byOwner.set(r.owner_id, []);
    byOwner.get(r.owner_id).push(r);
  }

  const plan = []; // { id, ownerId, title, twinId, twinTitle, reason }
  let scanned = 0;

  for (const [ownerId, list] of byOwner) {
    // Kept in creation order, so a duplicate always points at whatever came
    // BEFORE it — this is what stops two extracted twins of each other from
    // both being archived (the earlier one is a survivor by the time the
    // later one is judged) and what stops a real task from ever being
    // compared against something written after it.
    const survivors = [];
    for (const t of list) {
      scanned += 1;
      let best = null;
      for (const s of survivors) {
        const verdict = similarity.compare(t.title, s.title);
        if (!verdict.same) continue;
        if (!best || verdict.text > best.verdict.text) best = { survivor: s, verdict };
      }
      const isCandidate = t.source === 'extracted' && t.status === 'open';
      if (best && isCandidate) {
        plan.push({
          id: t.id, ownerId, title: t.title,
          twinId: best.survivor.id, twinTitle: best.survivor.title,
          reason: best.verdict.reason, text: best.verdict.text,
        });
        // Not added to survivors: it is about to be archived, so nothing
        // later in this owner's list should be compared against it.
        continue;
      }
      survivors.push(t);
    }
  }

  for (const p of plan) {
    console.log(`u${p.ownerId}  #${p.id} → keeps #${p.twinId} (${p.reason}, ${p.text.toFixed(2)})`);
    console.log(`   archiving: ${p.title.slice(0, 70)}`);
    console.log(`   kept as:   ${p.twinTitle.slice(0, 70)}`);
  }
  console.log(`\n${plan.length} open extracted task(s) to archive, out of ${scanned} top-level rows scanned.`);

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply once this list has been read.');
    await pool.end();
    return;
  }

  let archived = 0, raced = 0;
  for (const p of plan) {
    await withTx(pool, async (client) => {
      // archiveTask already writes its own `task.archived` audit row; this
      // one carries WHY — the twin it was judged a duplicate of — which is
      // what makes the audit trail answer "why did this disappear" on its
      // own, without a re-run of this script to reconstruct it.
      const res = await tasks.archiveTask(client, p.ownerId, p.id);
      if (!res.ok) { raced += 1; return; } // gone already — the person acted on it first
      archived += 1;
      await audit.record(client, p.ownerId, 'admin.duplicate_archived', {
        taskId: p.id, title: p.title, twinId: p.twinId, twinTitle: p.twinTitle,
        reason: p.reason, textScore: p.text, source: 'extracted',
      });
    });
  }
  console.log(`Archived ${archived}${raced ? `, ${raced} already gone by the time this ran` : ''}.`
    + ' Undo any one with tasks.unarchiveTask(client, ownerId, taskId).');
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
