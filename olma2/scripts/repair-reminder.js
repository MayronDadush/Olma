#!/usr/bin/env node
'use strict';
// Move one live reminder to the hour the person was actually told.
//
// Written for reminder 119 (Yahav, 2026-09-05): Olma said "מחר ב-19:00" and
// the row was armed for 18:00. The code fix stops the next one; a row already
// in the database is not reached by a deploy.
//
// It goes through domain/reminders.setReminder rather than an UPDATE, for the
// same reason the dashboard does: the auto row is cancelled and superseded the
// way an explicit reminder always supersedes one, the audit trail says what
// happened, and the result is the same shape as a reminder the person asked
// for by hand.
//
// Rehearses by default — runs the real write inside a transaction and rolls it
// back, printing what it would leave behind. --apply commits.
//
//   node scripts/repair-reminder.js --user 18 --task 414 --at 2026-09-06T19:00:00+03:00
//   node scripts/repair-reminder.js --user 18 --task 414 --at 2026-09-06T19:00:00+03:00 --apply
const { createPool } = require('../src/db/pool');
const reminders = require('../src/domain/reminders');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const userId = Number(arg('user'));
  const taskId = Number(arg('task'));
  const at = arg('at');
  const apply = process.argv.includes('--apply');
  if (!userId || !taskId || !at) {
    console.error('usage: repair-reminder.js --user <id> --task <id> --at <ISO with offset> [--apply]');
    process.exit(2);
  }

  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await reminders.setReminder(client, userId, taskId, at, null);
    if (!res.ok) {
      console.error('refused:', JSON.stringify(res));
      await client.query('ROLLBACK');
      process.exit(1);
    }
    const { rows } = await client.query(
      `SELECT r.id, r.remind_at AT TIME ZONE u.timezone AS their_time, r.auto, r.cancelled_at
         FROM task_reminders r
         JOIN tasks t ON t.id = r.task_id
         JOIN users u ON u.id = t.owner_id
        WHERE t.id = $1 ORDER BY r.id`, [taskId]);
    console.table(rows);
    console.log('supersededAuto:', res.data.supersededAuto);
    if (apply) {
      await client.query('COMMIT');
      console.log('COMMITTED');
    } else {
      await client.query('ROLLBACK');
      console.log('rehearsal only — re-run with --apply to keep this');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
