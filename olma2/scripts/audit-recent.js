'use strict';
// The last few hours of audit_log as event NAMES only — who (actor id, an
// internal number), when, and what kind of thing — for finding a turn that
// ended with no reply and no write ("בר asked for an option and nothing
// happened", 2026-10-09). Never `detail`, apart from the single `kind` key of
// reply.gated (a closed word: echo, after_silence, burst…), because this
// prints into a GitHub Actions log through ops.sh and nothing there may carry
// a person's words, name or number (see count-early-reminders.js).
//
//   node olma2/scripts/audit-recent.js   (on the box; `ops.sh audit-recent`)
const path = require('node:path');
const { createPool } = require(path.join(__dirname, '..', 'src/db/pool'));

const HOURS = 6;
const LIMIT = 400;

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT created_at, actor_id, event,
              CASE WHEN event = 'reply.gated' THEN detail->>'kind' END AS kind
         FROM audit_log
        WHERE created_at > now() - make_interval(hours => $1)
          AND (event LIKE 'reply.%' OR event LIKE 'turn.%' OR event LIKE 'message.%'
               OR event LIKE 'meeting.%' OR event LIKE 'unanswered%' OR event LIKE 'tool.%')
        ORDER BY created_at DESC
        LIMIT $2`, [HOURS, LIMIT]);
    for (const r of rows.reverse()) {
      console.log(`${r.created_at.toISOString()} u-${r.actor_id ?? '?'} ${r.event}${r.kind ? ` [${r.kind}]` : ''}`);
    }
    console.log(`-- ${rows.length} rows, last ${HOURS}h, newest ${LIMIT} at most`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
