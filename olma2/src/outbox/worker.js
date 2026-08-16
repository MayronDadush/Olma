'use strict';
// Drains the outbox. Runs inside brokerd on an interval. FOR UPDATE SKIP
// LOCKED means a second worker (or an overlapping tick) can never double-send
// — the idempotency the whole "nothing is lost, nothing sent twice" promise
// rests on.
const { withTx } = require('../db/pool');
const preferences = require('../domain/preferences');
const quota = require('../domain/quota');
const flagsDomain = require('../domain/flags');
const { decide } = require('./gate');

// deliver(user, row) → { ok, error? } — injected; production uses
// channels/openclaw.js, tests inject a recorder.
async function drainOnce(pool, deliver, now = new Date()) {
  const outcomes = { delivered: 0, held: 0, expired: 0, failed: 0 };

  // Plain read — the authoritative locking is the per-row FOR UPDATE SKIP
  // LOCKED below (a lock taken here would be released at this tx's commit
  // anyway, and only mislead readers into thinking it protects something).
  const { rows: candidates } = await pool.query(
    `SELECT o.*, u.timezone, u.agent_id, u.quota_blocked_until, u.first_name
     FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.sent_at IS NULL AND (o.release_after IS NULL OR o.release_after <= $1)
       AND (o.hold_reason IS NULL OR o.hold_reason <> 'budget')
     ORDER BY o.created_at LIMIT 50`,
    [now]
  );

  for (const row of candidates) {
    await withTx(pool, async (client) => {
      // re-lock this row; skip if another tick got it meanwhile
      const { rows: locked } = await client.query(
        `SELECT * FROM outbox WHERE id = $1 AND sent_at IS NULL FOR UPDATE SKIP LOCKED`, [row.id]
      );
      if (!locked[0]) return;

      const plan = await quota.planFor(client, row.user_id);
      const blocked = await quota.isBlocked(client, row.user_id, now.toISOString());
      const win = await preferences.availabilityWindow(client, row.user_id);
      const budget = Number(await flagsDomain.getFlag(client, 'proactive_daily_budget') ?? 4);
      const { rows: sentRows } = await client.query(
        `SELECT count(*)::int AS n FROM outbox
         WHERE user_id = $1 AND sent_at IS NOT NULL AND sent_at::date = $2::date
           AND hold_reason IS DISTINCT FROM 'expired'`,
        [row.user_id, now]
      );

      const verdict = decide({
        row, plan, blocked,
        blockedUntil: row.quota_blocked_until,
        window: win.data.window, tz: row.timezone,
        sentToday: sentRows[0].n, budget, now,
      });

      if (verdict.action === 'expire') {
        await client.query(
          `UPDATE outbox SET sent_at = now(), hold_reason = 'expired' WHERE id = $1`, [row.id]
        );
        outcomes.expired++;
        return;
      }
      if (verdict.action === 'hold') {
        await client.query(
          `UPDATE outbox SET hold_reason = $2, release_after = $3 WHERE id = $1`,
          [row.id, verdict.holdReason, verdict.releaseAfter]
        );
        outcomes.held++;
        return;
      }

      const result = await deliver(row);
      if (result.ok) {
        await client.query(
          `UPDATE outbox SET sent_at = now(), hold_reason = NULL WHERE id = $1`, [row.id]
        );
        if (row.kind === 'welcome') {
          // the delivered welcome IS the onboarding moment — checkin and
          // digest eligibility both key off this
          await client.query(
            `UPDATE users SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL`, [row.user_id]
          );
        }
        outcomes.delivered++;
      } else {
        // 5s, 15s, 45s, 2m15s, 6m45s. The first retry has to be seconds, not
        // minutes: the most common failure by far is a welcome racing the
        // gateway's config reload — a transient measured in seconds. A flat
        // 2-minute first backoff turned a 3-second setup into the 2-minute
        // wait new users actually experienced.
        await client.query(
          `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
                  release_after = now() + (interval '5 seconds' * power(3, attempts))
           WHERE id = $1`,
          [row.id, String(result.error || 'delivery failed').slice(0, 500)]
        );
        outcomes.failed++;
      }
    });
  }
  return outcomes;
}

module.exports = { drainOnce };
