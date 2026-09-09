'use strict';
// Product analytics rollup — audit_log (+ quota counters) → one snapshot row
// per metric per day. Same idea as usage_ledger: the dashboard reads tiny
// pre-aggregated tables, never scans raw logs at render time. Idempotent
// upserts, so re-running for today/yesterday every hour is safe and cheap.

// ---- corrections (מדד C — the "correction rate") ----------------------------
// A correction is our mistake surfacing: something Olma remembered had to be
// fixed shortly after. Two real incidents made this a metric — a user fixing a
// fact that had been saved about them, and a meeting confirmed on the wrong
// day that the admin repaired by hand. Three shapes, all detected from
// audit_log alone (no new table — the trail already carries what's needed):
//
//   fact       — fact.forgotten within the window of the fact.remembered that
//                created it (the detail carries factId on both sides).
//   preference — preference.remembered that overwrote a DIFFERENT value on the
//                same key, within the window of the previous write. The
//                'overwrote' detail flag (written since 2026-08-20) keeps an
//                idempotent re-save of the same value from counting; rows that
//                predate the flag fall back to pair-detection alone.
//   admin      — an operator fixing things from the dashboard. A correction is
//                a correction whoever makes it. admin.meeting.slot_corrected is
//                named here ahead of anything emitting it, so the day the
//                dashboard grows that action the metric already counts it.
//
// Window: 7 days. Past that, forgetting is life moving on (a project ended, a
// fact expired) — not Olma having heard wrong.
//
// Shared as SQL fragments (over an aliased audit_log row) so the dashboard's
// live per-user table and the daily rollup below can never drift apart on what
// "a correction" means.
const hebrewQuality = require('../domain/hebrew-quality');

const CORRECTION_WINDOW_DAYS = 7;
const WINDOW = `interval '${CORRECTION_WINDOW_DAYS} days'`;

// "Earlier" is by insertion order (r.id < a.id), not created_at: two writes in
// the same transaction share one now(), so a timestamp comparison silently
// misses a save-then-correct that happened in a single agent turn. The window
// itself still compares created_at — ids order events, days measure distance.
const correctionSql = {
  fact: (a) => `${a}.event = 'fact.forgotten' AND EXISTS (
      SELECT 1 FROM audit_log r
       WHERE r.event = 'fact.remembered'
         AND r.detail->>'factId' = ${a}.detail->>'factId'
         AND r.id < ${a}.id
         AND r.created_at > ${a}.created_at - ${WINDOW})`,
  preference: (a) => `${a}.event = 'preference.remembered'
      AND coalesce((${a}.detail->>'overwrote')::boolean, true)
      AND EXISTS (
      SELECT 1 FROM audit_log r
       WHERE r.event = 'preference.remembered'
         AND r.actor_id = ${a}.actor_id
         AND r.detail->>'key' = ${a}.detail->>'key'
         AND r.id < ${a}.id
         AND r.created_at > ${a}.created_at - ${WINDOW})`,
  admin: (a) => `(${a}.event IN ('admin.meeting.slot_corrected', 'admin.outbox.cancelled')
      OR ${a}.event LIKE 'admin.fact.%')`,
};

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
  // Growth, as the owner reads it day over day and week over week (2026-09-09):
  // what people SENT (the gateway's count, one row per accepted inbound
  // message — messages_counted below is quota turns, which also counts the
  // ones Olma started), and rooms she was added to.
  messages_received: `SELECT count(*) FROM audit_log
                      WHERE created_at::date = $1::date AND event = 'message.received'`,
  groups_created: `SELECT count(*) FROM chat_groups WHERE created_at::date = $1::date`,
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
  // Correction rate, as numerators + their denominators (same reasoning as the
  // north-star pair above: "2 of 15 facts had to be fixed" is a statement,
  // "13%" alone is an invitation to misread an empty week). Note an admin
  // deleting a fresh fact through the dashboard lands in BOTH facts_corrected
  // (the fact was wrong) and admin_corrections (a human had to step in) — two
  // lenses on one event, deliberately not deduplicated.
  facts_remembered: `SELECT count(*) FROM audit_log
                     WHERE created_at::date = $1::date AND event = 'fact.remembered'`,
  facts_corrected: `SELECT count(*) FROM audit_log a
                    WHERE a.created_at::date = $1::date AND ${correctionSql.fact('a')}`,
  preferences_remembered: `SELECT count(*) FROM audit_log
                           WHERE created_at::date = $1::date AND event = 'preference.remembered'`,
  preferences_corrected: `SELECT count(*) FROM audit_log a
                          WHERE a.created_at::date = $1::date AND ${correctionSql.preference('a')}`,
  admin_corrections: `SELECT count(*) FROM audit_log a
                      WHERE a.created_at::date = $1::date AND ${correctionSql.admin('a')}`,
};

// ---- her voice, counted (מדד D) -------------------------------------------
// How many of the sentences Olma wrote that day carried a flaw code can see —
// a masculine self-reference, or the model's own markup delivered as text
// (domain/hebrew-quality, the same reader the evals go red on). Two counts,
// never a rate: "3 of 120" is a statement, "2.5%" hides an empty day.
//
// The text lives only in the gateway's transcripts, so this half reads them
// through the injected `sessions` (channels/sessions-async inside brokerd —
// never sessions.js on the daemon's own loop). One scan per agent per day,
// assistant text only; a store that cannot be read (null) counts as nothing
// rather than as clean, and says so in the return value.
const FAILED_TURN_MARKER = '[assistant turn failed before producing content]';

async function rollupVoiceDay(client, sessions, dateIso) {
  const { rows: agents } = await client.query(
    `SELECT agent_id FROM users WHERE agent_id IS NOT NULL AND NOT is_eval`);
  const start = Date.parse(`${dateIso}T00:00:00Z`);
  const end = start + 86400_000;
  let messages = 0, flawed = 0, unreadable = 0;
  for (const { agent_id: agentId } of agents) {
    const texts = await sessions.scanAssistantTextSince(agentId, start - 1);
    if (!Array.isArray(texts)) { unreadable++; continue; }
    for (const t of texts) {
      if (!(t.at >= start && t.at < end)) continue;
      const text = String(t.text || '').trim();
      if (!text || text === 'NO_REPLY' || text === FAILED_TURN_MARKER) continue;
      messages++;
      if (hebrewQuality.flawsIn(text).length) flawed++;
    }
  }
  for (const [metric, value] of [['assistant_messages', messages], ['hebrew_flaws', flawed]]) {
    await client.query(
      `INSERT INTO product_metrics_daily (date, metric, value) VALUES ($1, $2, $3)
       ON CONFLICT (date, metric) DO UPDATE SET value = $3`,
      [dateIso, metric, value]);
  }
  return { messages, flawed, unreadable };
}

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

// Hourly-safe: refreshes today and finalises yesterday. The voice count runs
// only when a transcript reader is handed in (brokerd passes sessions-async);
// without one the SQL half still runs and the heartbeat says the other half
// did not, because a count that quietly stops is indistinguishable from a
// clean day.
async function sweepMetrics(client, now = new Date(), deps = {}) {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
  const n = await rollupDay(client, yesterday) + await rollupDay(client, today);
  const out = { metricsWritten: n };
  if (deps.sessions) {
    const y = await rollupVoiceDay(client, deps.sessions, yesterday);
    const t = await rollupVoiceDay(client, deps.sessions, today);
    out.voice = { messages: y.messages + t.messages, flawed: y.flawed + t.flawed, unreadable: y.unreadable + t.unreadable };
  } else {
    out.voice = 'skipped — no transcript reader';
  }
  return out;
}

module.exports = { rollupDay, rollupVoiceDay, sweepMetrics, METRIC_QUERIES, correctionSql, CORRECTION_WINDOW_DAYS };
