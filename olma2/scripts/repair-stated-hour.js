#!/usr/bin/env node
'use strict';
// Re-instantiate a task's due_at at the wall clock its own TITLE names.
//
// Four rows on the box said one hour in words and carried another in the
// column (docs/incidents.md, "The hour in the title nobody compared"):
// Maya's three work shifts, written 16:00Z for a title saying 16:00 under a
// correct Asia/Jerusalem, and Sarah's brunch, written under a phone-prefix
// timezone guess that was corrected 38 minutes later. `jobs/promise-watch.js`
// stops the next one; a row already in the database is not reached by a deploy.
//
// **All four are archived, and both domain writers refuse an archived row on
// purpose** — `editTask` and `snoozeTask` both carry `archived_at IS NULL`,
// because an archived task is closed history and the tools must not reopen it.
// So the archive is lifted and restored around the edit, inside ONE
// transaction: no other connection ever observes the row as live, which is
// what keeps a sweep from acting on a past due date that has come back.
// The edit itself still goes through the domain function, so it is validated
// and audited exactly like the agent's own (CLAUDE.md, "Editing the
// dashboard or domain").
//
// It does NOT touch task_reminders. A `remind_at` with `sent_at` on it is a
// record that we messaged somebody at that moment; correcting it would be
// falsifying what happened. A due_at is a statement about when the thing WAS,
// and that statement was wrong.
//
// Rehearses by default; --apply commits.
//
//   node scripts/repair-stated-hour.js --task 38 --at 2026-08-23T16:00:00+03:00
//   node scripts/repair-stated-hour.js --task 38 --at 2026-08-23T16:00:00+03:00 --apply
const { createPool } = require('../src/db/pool');
const tasks = require('../src/domain/tasks');
const audit = require('../src/domain/audit');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const taskId = Number(arg('task'));
  const at = arg('at');
  const apply = process.argv.includes('--apply');
  if (!taskId || !at) {
    console.error('usage: repair-stated-hour.js --task <id> --at <ISO with offset> [--apply]');
    process.exit(2);
  }

  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      `SELECT t.id, t.owner_id, t.title, t.archived_at, t.due_at,
              to_char(t.due_at AT TIME ZONE u.timezone, 'YYYY-MM-DD HH24:MI') AS was_local,
              u.timezone
         FROM tasks t JOIN users u ON u.id = t.owner_id
        WHERE t.id = $1 FOR UPDATE`, [taskId]);
    if (!before[0]) { console.error('no such task'); await client.query('ROLLBACK'); process.exit(1); }
    const row = before[0];

    // Lift, edit through the domain, restore the exact stamp that was there.
    await client.query(`UPDATE tasks SET archived_at = NULL WHERE id = $1`, [taskId]);
    const res = await tasks.editTask(client, row.owner_id, taskId, { dueAt: at });
    await client.query(`UPDATE tasks SET archived_at = $2 WHERE id = $1`, [taskId, row.archived_at]);
    if (!res.ok) {
      console.error('refused:', JSON.stringify(res));
      await client.query('ROLLBACK');
      process.exit(1);
    }

    await audit.record(client, row.owner_id, 'admin.task_due_corrected', {
      taskId,
      from: row.due_at.toISOString(),
      to: new Date(at).toISOString(),
      reason: 'the hour in the title was never the hour in the column; see incidents.md, "The hour in the title nobody compared"',
    });

    const { rows: after } = await client.query(
      `SELECT t.id, t.title, t.archived_at IS NOT NULL AS still_archived, t.status,
              to_char(t.due_at AT TIME ZONE u.timezone, 'YYYY-MM-DD HH24:MI') AS now_local
         FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.id = $1`, [taskId]);
    console.log(`#${taskId} "${row.title}"`);
    console.log(`  was ${row.was_local} → now ${after[0].now_local} (${row.timezone})`);
    console.log(`  archived still set: ${after[0].still_archived} · status ${after[0].status}`);

    if (apply) { await client.query('COMMIT'); console.log('  COMMITTED'); }
    else { await client.query('ROLLBACK'); console.log('  rehearsal only — re-run with --apply to keep this'); }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
