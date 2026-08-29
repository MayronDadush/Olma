#!/usr/bin/env node
// Restart the standing chores that one "סיימתי" switched off.
//
// completeTask marked a task done AND cancelled every pending reminder on it.
// For a one-off that is right. For a repeating one it was fatal: the sweep
// writes the NEXT occurrence as a pending row the moment the current one
// fires, so completing the task cancelled the future of the recurrence.
// Nothing errored, nothing was logged as unusual — the reminders simply
// stopped, which from the outside looks exactly like a quiet week.
//
// Confirmed live: user 3's task 17 ("לנקות את הכלים", weekly:MO,TH) went
// silent on 2026-08-27 and the person has not been reminded since.
//
// The fingerprint is exact rather than a guess: completeTask sets the task's
// completed_at and the reminder's cancelled_at inside ONE transaction, so both
// carry the identical now(). A reminder the person cancelled themselves, at
// any other moment, never matches.
//
// Usage:
//   node scripts/repair-killed-recurrences.js              # show what would change
//   node scripts/repair-killed-recurrences.js --apply
//   node scripts/repair-killed-recurrences.js --task 17 --apply
//
// Dry run by default. Re-running is a no-op: a revived task is open again, so
// it no longer matches. Nothing is sent to anyone — telling someone we had
// stopped reminding them would cost them more than the silence did.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const reminders = require('../src/domain/reminders');
const audit = require('../src/domain/audit');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const taskArg = args.includes('--task') ? Number(args[args.indexOf('--task') + 1]) : null;
if (taskArg !== null && !Number.isFinite(taskArg)) {
  console.error('--task needs a task id');
  process.exit(1);
}

async function main() {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT r.id AS reminder_id, r.remind_at, r.repeat_rule,
              t.id AS task_id, t.owner_id, t.title, u.timezone, u.phone
         FROM task_reminders r
         JOIN tasks t ON t.id = r.task_id
         JOIN users u ON u.id = t.owner_id
        WHERE r.repeat_rule IS NOT NULL
          AND r.sent_at IS NULL
          AND r.cancelled_at IS NOT NULL
          AND t.status = 'done'
          AND t.archived_at IS NULL
          AND t.completed_at = r.cancelled_at          -- the one-transaction fingerprint
          AND ($1::bigint IS NULL OR t.id = $1)
        ORDER BY t.id`,
      [taskArg]
    );

    if (!rows.length) {
      console.log('nothing to repair.');
      return;
    }

    const now = new Date();
    for (const r of rows) {
      const due = new Date(r.remind_at);
      // A moment that has passed is not resurrected — that would fire a
      // reminder about last Monday. Walk the rule forward instead, in the
      // person's own zone, to the next real occurrence.
      let next = due;
      let moved = false;
      let guard = 0;
      while (next <= now && guard++ < 800) {
        const step = reminders.nextOccurrence(next, r.repeat_rule, r.timezone);
        if (!step) break;
        next = step;
        moved = true;
      }
      const when = next.toLocaleString('en-CA', { timeZone: r.timezone || 'UTC', hour12: false });
      console.log(
        `task ${r.task_id} "${r.title}" (${r.phone}) rule=${r.repeat_rule}\n` +
        `  reminder ${r.reminder_id} cancelled by completion; next ${when}` +
        `${moved ? ' (walked forward — its own moment had passed)' : ''}`
      );
      if (!apply) continue;

      await withTx(pool, async (c) => {
        await c.query(
          `UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = $1`, [r.task_id]);
        if (moved) {
          // The old row keeps its cancellation: that moment really did pass
          // unreminded, and rewriting it would claim otherwise.
          await c.query(
            `INSERT INTO task_reminders (task_id, remind_at, repeat_rule) VALUES ($1, $2, $3)`,
            [r.task_id, next, r.repeat_rule]);
        } else {
          await c.query(
            `UPDATE task_reminders SET cancelled_at = NULL WHERE id = $1`, [r.reminder_id]);
        }
        await audit.record(c, r.owner_id, 'admin.recurrence_repaired', {
          taskId: Number(r.task_id), reminderId: Number(r.reminder_id),
          repeatRule: r.repeat_rule, nextAt: next.toISOString(), walkedForward: moved,
        });
      });
      console.log('  repaired.');
    }
    if (!apply) console.log(`\n${rows.length} recurrence(s) would be restarted. Re-run with --apply.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
