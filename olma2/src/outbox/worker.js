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
  const outcomes = { delivered: 0, held: 0, expired: 0, dropped: 0, failed: 0 };
  // Rows whose own bookkeeping threw, recorded rather than rethrown — see the
  // catch at the bottom of the loop.
  const errored = [];

  // Plain read — the authoritative locking is the per-row FOR UPDATE SKIP
  // LOCKED below (a lock taken here would be released at this tx's commit
  // anyway, and only mislead readers into thinking it protects something).
  const { rows: candidates } = await pool.query(
    `SELECT o.*, u.timezone, u.agent_id, u.quota_blocked_until, u.first_name, u.last_inbound_at,
            u.digest_times, u.paused_at
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
    try {
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
             AND (hold_reason IS NULL OR hold_reason NOT IN ('expired', 'cancelled_by_admin', 'paused'))
             AND urgency <> 'urgent'
             AND kind NOT IN ('reminder', 'digest')`,
          [row.user_id, now]
        );

        const verdict = decide({
          row, plan, blocked, paused: Boolean(row.paused_at),
          blockedUntil: row.quota_blocked_until,
          window: win.data.window, tz: row.timezone,
          lastInboundAt: row.last_inbound_at,
          hasDigest: Boolean(row.digest_times),
          sentToday: sentRows[0].n, budget, now,
        });

        // Terminal, like 'expired': sent_at is stamped so the sweep that produced
        // this row cannot produce it again, and hold_reason records that nothing
        // was actually sent.
        if (verdict.action === 'drop') {
          await client.query(
            `UPDATE outbox SET sent_at = now(), hold_reason = $2 WHERE id = $1`,
            [row.id, verdict.holdReason]
          );
          outcomes.dropped++;
          return;
        }
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
          //
          // The exponent is capped BEFORE it is multiplied, not after. least()
          // evaluates both of its arguments, so `interval '5 seconds' *
          // power(3, attempts)` was computed in full and only then compared to
          // the cap — and an interval holds microseconds in an int64, so at
          // attempts = 26 (5s x 3^26 = 1.3e19us > 9.2e18) the multiplication
          // itself threw `interval out of range`, and the row could no longer
          // even record its own failure.
          //
          // That turned the very outage this cap was written for into a
          // permanent one: the Anthropic account ran dry on 2026-08-23, every
          // send failed, attempts climbed for a day, and once two rows crossed
          // 26 each tick aborted on them — oldest-first, so they sat at the head
          // of the queue with 28 healthy messages stuck behind them. Topping the
          // account back up would not have cleared it; only this line does.
          await client.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
                    release_after = now() + least(
                      interval '10 minutes',
                      interval '5 seconds' * power(3, least(attempts, 6)))
             WHERE id = $1`,
            [row.id, String(result.error || 'delivery failed').slice(0, 500)]
          );
          outcomes.failed++;
        }
      });
    } catch (e) {
      // Isolated on purpose. Anything escaping the per-row transaction is a
      // defect in OUR handling of THIS row, and the rest of the queue has
      // nothing to do with it — so it is recorded and stepped over, never
      // rethrown. Before this, one unprocessable row aborted the tick and took
      // every healthy message behind it down too, for as long as it sat there.
      // One row failing is a defect; one row silencing the system is an outage.
      errored.push({ id: row.id, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  if (errored.length) outcomes.errored = errored;
  return outcomes;
}

module.exports = { drainOnce };
