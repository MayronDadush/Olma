#!/usr/bin/env node
// PR #103 split the discovery rung's shared 'calendar' topic into
// 'calendar:not_connected' / 'calendar:needs_reauth' so a topic offered once
// is never offered again, without letting the not-connected pitch silently
// suppress the needs_reauth recovery (or vice versa). That "never again" rule
// only sees exactly what a payload's topic string says — an OLD row still
// reading 'calendar' does not match either new string, so everyone with
// history under the old name was due exactly one grace repeat under the new
// one before the rule engaged for them. Six real users had that history
// (checked live 2026-09-01): each row's own checkinInstruction records which
// of the two pitches was actually sent, so this rewrites 'calendar' rows to
// the correct new topic directly rather than guessing from today's calendar
// status — a user who has since reconnected or broken their connection again
// must not have history rewritten to a case they were never actually told.
//
// Usage:
//   node scripts/backfill-calendar-topic.js          # report what would change
//   node scripts/backfill-calendar-topic.js --apply
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const audit = require('../src/domain/audit');

const APPLY = process.argv.includes('--apply');

// Both variants live in domain/checkin's discoveryGaps and are otherwise
// identical between old rows and the current source — this phrase only ever
// appears in the needs_reauth pitch.
const NEEDS_REAUTH_MARKER = 'WAS connected';

function newTopicFor(instruction) {
  return instruction && instruction.includes(NEEDS_REAUTH_MARKER)
    ? 'calendar:needs_reauth'
    : 'calendar:not_connected';
}

(async () => {
  const pool = createPool();
  const { rows } = await pool.query(
    `SELECT o.id, o.user_id, o.payload->>'checkinInstruction' AS instruction, u.first_name
       FROM outbox o JOIN users u ON u.id = o.user_id
      WHERE o.kind = 'checkin' AND o.payload->>'rung' = 'discovery'
        AND o.payload->>'topic' = 'calendar'
      ORDER BY o.user_id, o.id`
  );

  if (!rows.length) {
    console.log('nothing to backfill — no rows carry the old \'calendar\' topic.');
    await pool.end();
    return;
  }

  const targets = rows.map((r) => ({ row: r, newTopic: newTopicFor(r.instruction) }));
  const byUser = new Map();
  for (const t of targets) {
    if (!byUser.has(t.row.user_id)) byUser.set(t.row.user_id, []);
    byUser.get(t.row.user_id).push(t);
  }
  for (const [userId, items] of byUser) {
    const name = items[0].row.first_name || userId;
    console.log(`${APPLY ? 'rewriting' : 'would rewrite'} user ${userId} (${name}): `
      + `${items.length} row(s) → ${[...new Set(items.map((i) => i.newTopic))].join(', ')}`);
  }

  if (!APPLY) {
    console.log(`\n${targets.length} row(s) across ${byUser.size} user(s). Re-run with --apply to write.`);
    await pool.end();
    return;
  }

  await withTx(pool, async (client) => {
    for (const { row, newTopic } of targets) {
      await client.query(
        `UPDATE outbox SET payload = jsonb_set(payload, '{topic}', to_jsonb($2::text))
          WHERE id = $1 AND payload->>'topic' = 'calendar'`,
        [row.id, newTopic]
      );
    }
    for (const userId of byUser.keys()) {
      await audit.record(client, userId, 'admin.checkin_topic_backfilled',
        { rows: byUser.get(userId).length, from: 'calendar' });
    }
  });
  console.log(`\nrewrote ${targets.length} row(s) across ${byUser.size} user(s).`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
