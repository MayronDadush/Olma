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
    `SELECT o.*, u.timezone, u.agent_id, u.quota_blocked_until, u.first_name, u.last_inbound_at,
            u.digest_times
     FROM outbox o JOIN users u ON u.id = o.user_id
     WHERE o.sent_at IS NULL AND (o.release_after IS NULL OR o.release_after <= $1)
       -- A budget hold with no release time is waiting for the next digest to
       -- carry it (collectHeld), so it must not be retried on a clock. One
       -- WITH a release time is the no-digest case: the gate scheduled it for
       -- the next day, and skipping it here is what left those rows unsent
       -- forever despite the release time the gate had set.
       AND (o.hold_reason IS DISTINCT FROM 'budget' OR o.release_after IS NOT NULL)
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
      // Count only what the budget actually governs. Urgent rows and the two
      // user-chosen kinds are exempt in decide() — counting them here let a day
      // with three reminders exhaust a budget those reminders ignored, and then
      // every ordinary message for the rest of that day was held. That is how a
      // real connection request went unseen: five sends, none of them subject to
      // the budget, ate all four slots. Keep this list in sync with decide().
      //
      // 'cancelled_by_admin' rows carry sent_at too — that is how cancelling
      // stops the sweep re-creating them — but nothing was ever delivered, so
      // counting them would let cancelling a message burn the same budget as
      // sending it.
      const { rows: sentRows } = await client.query(
        `SELECT count(*)::int AS n FROM outbox
         WHERE user_id = $1 AND sent_at IS NOT NULL AND sent_at::date = $2::date
           AND (hold_reason IS NULL OR hold_reason NOT IN ('expired', 'cancelled_by_admin'))
           AND urgency <> 'urgent'
           AND kind NOT IN ('reminder', 'digest')`,
        [row.user_id, now]
      );

      const verdict = decide({
        row, plan, blocked,
        blockedUntil: row.quota_blocked_until,
        window: win.data.window, tz: row.timezone,
        lastInboundAt: row.last_inbound_at,
        hasDigest: Boolean(row.digest_times),
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
        outcomes.delivered++;
      } else {
        // 5s, 15s, 45s, 2m15s, then capped at 10 minutes. The first retry has
        // to be seconds: the most common failure is a welcome racing the
        // gateway's config reload, a transient measured in seconds — a flat
        // 2-minute first backoff was what turned a 3-second setup into the
        // 2-minute wait new users actually experienced.
        //
        // The cap matters for the opposite case, an outage rather than a race:
        // when the Anthropic account ran out of credit every send failed for
        // as long as it took to notice. Uncapped tripling would have pushed a
        // waiting user's welcome days out, so it would still be unsent long
        // after the account was topped up. Capped, everything queued goes out
        // within ten minutes of service returning.
        await client.query(
          `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
                  release_after = now() + least(
                    interval '10 minutes',
                    interval '5 seconds' * power(3, attempts))
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
