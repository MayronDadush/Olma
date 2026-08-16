'use strict';
// The retention promise every table was born with, kept: routine audit rows
// age out; permanent (consent/privacy) rows never do. Sent outbox rows and
// stale session snapshots age out too. Days tunable via flag, no deploy.
const flags = require('../domain/flags');

async function sweepRetention(client) {
  const days = Number(await flags.getFlag(client, 'audit_retention_days') ?? 180);
  const audit = await client.query(
    `DELETE FROM audit_log WHERE retention_class = 'routine'
       AND created_at < now() - make_interval(days => $1)`,
    [days]
  );
  const outbox = await client.query(
    `DELETE FROM outbox WHERE sent_at IS NOT NULL
       AND sent_at < now() - make_interval(days => $1)`,
    [days]
  );
  const snapshots = await client.query(
    `DELETE FROM usage_session_snapshots WHERE updated_at < now() - interval '30 days'`
  );
  return { auditPurged: audit.rowCount, outboxPurged: outbox.rowCount, snapshotsPurged: snapshots.rowCount };
}

module.exports = { sweepRetention };
