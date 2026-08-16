'use strict';
// Every meaningful action lands here — personal actions included, not just
// cross-user exposure. product_metrics_daily is rolled up from these rows
// nightly; friction detection is a query over them, not a separate mechanism.

// Events whose rows are kept forever (consent/privacy trail). Everything else
// is 'routine' and gets cleaned after a few months by a retention job.
const PERMANENT_PREFIXES = ['share.', 'connection.', 'grant.', 'user.provisioned', 'user.blocked'];

function retentionClassFor(event) {
  return PERMANENT_PREFIXES.some((p) => event.startsWith(p)) ? 'permanent' : 'routine';
}

async function record(client, actorId, event, detail) {
  await client.query(
    `INSERT INTO audit_log (actor_id, event, detail, retention_class) VALUES ($1, $2, $3, $4)`,
    [actorId, event, detail ? JSON.stringify(detail) : null, retentionClassFor(event)]
  );
}

module.exports = { record, retentionClassFor };
