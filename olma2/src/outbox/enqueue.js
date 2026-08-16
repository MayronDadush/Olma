'use strict';
// The ONLY way anything sends a proactive message: write a row. No caller
// spawns a send directly — the worker drains, the gate decides, delivery is
// recorded. idempotency_key makes re-running any job harmless.
const { ok } = require('../domain/results');

async function enqueue(client, { userId, kind, payload, urgency, expiresAt, idempotencyKey, releaseAfter }) {
  const { rows } = await client.query(
    `INSERT INTO outbox (user_id, kind, payload, urgency, expires_at, idempotency_key, release_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [userId, kind, JSON.stringify(payload || {}), urgency || 'normal',
     expiresAt || null, idempotencyKey || null, releaseAfter || null]
  );
  return ok({ enqueued: rows.length > 0, outboxId: rows[0] ? rows[0].id : null });
}

// Rows folded into a digest/unblock summary: everything held for this user
// with the given reasons. Marks them sent (they ride along, not separately).
async function collectHeld(client, userId, reasons) {
  const { rows } = await client.query(
    `UPDATE outbox SET sent_at = now()
     WHERE user_id = $1 AND sent_at IS NULL AND hold_reason = ANY($2)
     RETURNING kind, payload, hold_reason, expires_at, created_at`,
    [userId, reasons]
  );
  return rows;
}

module.exports = { enqueue, collectHeld };
