'use strict';
// How many reminders still to fire were armed an hour before a due_at that may
// itself have been the hour the person NAMED — the shape fixed in #403, in
// rows that were written before the fix. Read-only, COUNTS ONLY.
//
//   node olma2/scripts/count-early-reminders.js   (on the box; `ops.sh count-early-reminders`)
//
// What it can and cannot know: `auto = true` means `attachAutoReminder` wrote
// the row, so the hour is Olma's, derived as due_at minus an hour. Whether
// that due_at was the THING's time (correct — a meeting somebody has to leave
// for) or the hour they NAMED (wrong) is in no column; it is in what they
// typed. So this SIZES the problem, it does not decide any row.
//
// Counts only, and no titles, because it prints into a GitHub Actions log
// through ops.sh — see the note in measure-ask-re.js. Acting on the rows means
// reading them, which is a person at their own ssh, not this workflow.
const path = require('node:path');
const { createPool } = require(path.join(__dirname, '..', 'src/db/pool'));

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT
         count(*)::int                        AS rows_total,
         count(DISTINCT t.owner_id)::int      AS people,
         count(*) FILTER (WHERE t.kind = 'todo')::int  AS todo_rows,
         count(*) FILTER (WHERE t.kind = 'event')::int AS event_rows,
         count(*) FILTER (WHERE t.location IS NOT NULL)::int AS with_location,
         min(r.remind_at)                     AS soonest
       FROM task_reminders r
       JOIN tasks t ON t.id = r.task_id
       JOIN users u ON u.id = t.owner_id
      WHERE r.sent_at IS NULL
        AND r.cancelled_at IS NULL
        AND r.attempts = 0
        AND r.auto IS TRUE
        AND r.repeat_rule IS NULL
        AND r.remind_at > now()
        AND t.due_at IS NOT NULL
        AND t.status = 'open'
        AND t.archived_at IS NULL
        AND t.due_at - r.remind_at = interval '60 minutes'
        AND NOT u.is_eval`
    );
    const r = rows[0];
    console.log('== pending auto reminders armed exactly an hour before a due_at ==');
    console.log(`rows            : ${r.rows_total}`);
    console.log(`people affected : ${r.people}`);
    console.log(`  kind=todo     : ${r.todo_rows}   <- the shape most likely to be wrong`);
    console.log(`  kind=event    : ${r.event_rows}   <- the shape the hour-before was built for`);
    console.log(`  with location : ${r.with_location}   <- somewhere to travel to: the lead is right`);
    console.log(`soonest to fire : ${r.soonest ? new Date(r.soonest).toISOString() : '(none)'}`);
    console.log('');
    if (!r.todo_rows) {
      console.log('READ: nothing of the suspect shape is pending. Nothing to clean up.');
    } else {
      console.log(`READ: ${r.todo_rows} todo row(s) worth eyeballing. The titles are NOT printed here;`);
      console.log('      read them over ssh with the find-early-reminders.sql query.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
