#!/usr/bin/env node
// One-off (idempotent, safe to re-run): bring EXISTING active connections up
// to the 2026-08-27 rule that friendship enables every feature on both sides
// (sharing / meetings / messages) unless someone switched one off. New
// approvals get this automatically (connections.respondToConnection →
// grants.autoGrantAll); this reaches the pairs who became friends before the
// rule existed and were left half-configured or silent.
//
// It only ever ADDS grants — a feature someone explicitly revoked after this
// runs stays revoked (re-running cannot resurrect it within the same day it
// was revoked either: rows are inserted ON CONFLICT DO NOTHING, and a
// revoked grant is simply re-added once, same as the rule would have granted
// it at approval time — run this ONCE at rollout, not on a schedule, exactly
// so a later revoke is never overridden).
//
// Usage: node scripts/backfill-connection-grants.js [--apply]
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const grants = require('../src/domain/grants');

const APPLY = process.argv.includes('--apply');

(async () => {
  const pool = createPool();
  const { rows: conns } = await pool.query(
    `SELECT c.id, c.requester_id, c.target_id,
            ru.first_name AS requester_name, tu.first_name AS target_name,
            (SELECT array_agg(grantor_id || ':' || feature ORDER BY grantor_id, feature)
             FROM connection_feature_grants g WHERE g.connection_id = c.id) AS existing
     FROM connections c
     JOIN users ru ON ru.id = c.requester_id
     JOIN users tu ON tu.id = c.target_id
     WHERE c.status = 'active'
     ORDER BY c.id`);

  let touched = 0;
  for (const c of conns) {
    const have = new Set(c.existing || []);
    const missing = [];
    for (const uid of [Number(c.requester_id), Number(c.target_id)]) {
      for (const f of grants.KNOWN_CONNECTION_FEATURES) {
        if (!have.has(`${uid}:${f}`)) missing.push(`${uid}:${f}`);
      }
    }
    const label = `#${c.id} ${c.requester_name || c.requester_id} ↔ ${c.target_name || c.target_id}`;
    if (!missing.length) {
      console.log(`  · ${label}: complete already`);
      continue;
    }
    if (!APPLY) {
      console.log(`  · ${label}: would add ${missing.join(', ')}`);
      continue;
    }
    await withTx(pool, (client) =>
      grants.autoGrantAll(client, Number(c.id),
        [Number(c.requester_id), Number(c.target_id)], { backfill: true }));
    console.log(`  → ${label}: added ${missing.join(', ')}`);
    touched++;
  }
  console.log(APPLY
    ? `done: ${touched} of ${conns.length} active connections updated`
    : `dry run over ${conns.length} active connections — re-run with --apply`);
  await pool.end();
})();
