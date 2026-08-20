'use strict';
// Product analytics rollup — audit_log (+ quota counters) → one snapshot row
// per metric per day. Same idea as usage_ledger: the dashboard reads tiny
// pre-aggregated tables, never scans raw logs at render time. Idempotent
// upserts, so re-running for today/yesterday every hour is safe and cheap.
const METRIC_QUERIES = {
  active_users: `SELECT count(DISTINCT actor_id) FROM audit_log
                 WHERE created_at::date = $1::date AND actor_id IS NOT NULL`,
  tasks_created: `SELECT count(*) FROM audit_log
                  WHERE created_at::date = $1::date AND event IN ('task.created','task.bulk_created')`,
  reminders_created: `SELECT count(*) FROM audit_log
                      WHERE created_at::date = $1::date AND event = 'reminder.created'`,
  meetings_started: `SELECT count(*) FROM audit_log
                     WHERE created_at::date = $1::date AND event = 'meeting.started'`,
  meetings_confirmed: `SELECT count(*) FROM audit_log
                       WHERE created_at::date = $1::date AND event = 'meeting.confirmed'`,
  meetings_no_match: `SELECT count(*) FROM audit_log
                      WHERE created_at::date = $1::date AND event = 'meeting.no_match'`,
  shares_offered: `SELECT count(*) FROM audit_log
                   WHERE created_at::date = $1::date AND event = 'share.offered'`,
  shares_accepted: `SELECT count(*) FROM audit_log
                    WHERE created_at::date = $1::date AND event = 'share.accepted'`,
  connections_requested: `SELECT count(*) FROM audit_log
                          WHERE created_at::date = $1::date AND event = 'connection.requested'`,
  connections_approved: `SELECT count(*) FROM audit_log
                         WHERE created_at::date = $1::date AND event = 'connection.approved'`,
  issues_reported: `SELECT count(*) FROM audit_log
                    WHERE created_at::date = $1::date AND event = 'issue.reported'`,
  users_provisioned: `SELECT count(*) FROM audit_log
                      WHERE created_at::date = $1::date AND event = 'user.provisioned'`,
  // The north-star metric, as two counts rather than a percentage: a rate with
  // a zero denominator is not a number, and the screen needs to be able to say
  // "3 of 12" instead of a confident-looking 25%.
  //
  // Both halves are floored at the moment instrumentation began (the first
  // message.received row). Proactive messages sent before that have no
  // possible numerator — counting them would report every one of them as
  // ignored, which is a lie about users rather than a gap in our data. Until
  // that first row exists, min() is NULL and both counts are honestly zero.
  proactive_sent: `SELECT count(*) FROM outbox o
                   WHERE o.sent_at::date = $1::date AND o.hold_reason IS NULL
                     AND o.sent_at > (SELECT min(created_at) FROM audit_log
                                       WHERE event = 'message.received')`,
  proactive_answered: `SELECT count(*) FROM outbox o
                       WHERE o.sent_at::date = $1::date AND o.hold_reason IS NULL
                         AND o.sent_at > (SELECT min(created_at) FROM audit_log
                                           WHERE event = 'message.received')
                         AND EXISTS (SELECT 1 FROM audit_log a
                                      WHERE a.actor_id = o.user_id
                                        AND a.event = 'message.received'
                                        AND a.created_at > o.sent_at
                                        AND a.created_at <= o.sent_at + interval '24 hours')`,
  messages_counted: `SELECT coalesce(sum(count), 0) FROM quota_counters
                     WHERE window_kind = 'day' AND window_start::date = $1::date`,
};

async function rollupDay(client, dateIso) {
  for (const [metric, sql] of Object.entries(METRIC_QUERIES)) {
    const { rows } = await client.query(sql, [dateIso]);
    const value = Number(Object.values(rows[0])[0]) || 0;
    await client.query(
      `INSERT INTO product_metrics_daily (date, metric, value) VALUES ($1, $2, $3)
       ON CONFLICT (date, metric) DO UPDATE SET value = $3`,
      [dateIso, metric, value]
    );
  }
  return Object.keys(METRIC_QUERIES).length;
}

// Hourly-safe: refreshes today and finalises yesterday.
async function sweepMetrics(client, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
  const n = await rollupDay(client, yesterday) + await rollupDay(client, today);
  return { metricsWritten: n };
}

module.exports = { rollupDay, sweepMetrics, METRIC_QUERIES };
