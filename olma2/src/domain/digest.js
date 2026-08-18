'use strict';
// One assembly function, parametric scope — the today view and the daily
// digest are the same code called with different scopes (the unification
// decision; no second snapshot mechanism).
//
// scope:
//   'summary'    – counts only ("5 open, 2 due today")
//   'full'       – every open task, nothing omitted
//   'today'      – due today / overdue only
//   'block_view' – the quota-block notice: counts ONLY for personal items
//                  (deliberate FOMO), full detail for anything involving
//                  another person (never block human-to-human coordination)
const { ok, err } = require('./results');
const audit = require('./audit');

const SCOPES = ['summary', 'full', 'today', 'block_view'];

async function assemble(client, userId, scope) {
  if (!SCOPES.includes(scope)) return err('invalid', `scope must be one of ${SCOPES.join('|')}`);

  const counts = (await client.query(
    `SELECT
       count(*) FILTER (WHERE status = 'open') ::int AS open_tasks,
       count(*) FILTER (WHERE status = 'open' AND due_at::date <= CURRENT_DATE) ::int AS due_or_overdue
     FROM tasks WHERE owner_id = $1 AND archived_at IS NULL`,
    [userId]
  )).rows[0];
  const reminderCount = (await client.query(
    `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE t.owner_id = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL`,
    [userId]
  )).rows[0].n;

  // Cross-user items — always fully detailed in block_view.
  const pendingMeetings = (await client.query(
    `SELECT m.id, m.title, m.proposed_slot, u.first_name AS initiator_name, u.phone AS initiator_phone
     FROM meetings m
     JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = $1 AND p.state = 'awaiting'
     JOIN users u ON u.id = m.initiator_id
     WHERE m.status = 'negotiating'`,
    [userId]
  )).rows;
  const pendingConnections = (await client.query(
    `SELECT c.id, c.invite_reason, u.first_name, u.last_name, u.phone
     FROM connections c JOIN users u ON u.id = c.requester_id
     WHERE c.target_id = $1 AND c.status = 'pending_target'`,
    [userId]
  )).rows;
  const pendingShares = (await client.query(
    `SELECT s.id, t.title AS task_title, u.first_name AS owner_name
     FROM shares s JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.owner_id
     WHERE s.viewer_id = $1 AND s.status = 'pending_viewer'`,
    [userId]
  )).rows;

  const base = {
    scope,
    counts: { openTasks: counts.open_tasks, dueOrOverdue: counts.due_or_overdue, pendingReminders: reminderCount },
    crossUser: { pendingMeetings, pendingConnections, pendingShares },
  };

  if (scope === 'summary' || scope === 'block_view') {
    return ok(base); // personal items stay counts-only
  }

  const taskFilter = scope === 'today'
    ? `AND due_at IS NOT NULL AND due_at::date <= CURRENT_DATE` : '';
  const tasks = (await client.query(
    `SELECT id, title, category, due_at, parent_id FROM tasks
     WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL AND include_in_digest ${taskFilter}
     ORDER BY due_at NULLS LAST, id`,
    [userId]
  )).rows;
  return ok({ ...base, tasks });
}


// ---- preferences ------------------------------------------------------------
//
// The scheduled digest already worked — sweeps.js matches each user's local
// HH:MM against users.digest_times — but nothing could SET it. The column was
// reachable only by hand-written SQL, so in practice no user could choose when
// (or whether) they get a digest. Added 2026-08-18, ported in spirit from v1's
// set_digest_preferences.
//
// 'block_view' is deliberately not selectable: it is the quota-block notice
// assembled by turn_start, not a scope a person can ask for.
const USER_SCOPES = ['summary', 'full', 'today'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Each digest is a model turn, so this is a real cost ceiling, not tidiness.
const MAX_TIMES = 4;

async function setPreferences(client, userId, times, scope) {
  let digestTimes;                       // undefined = leave alone
  if (times !== undefined && times !== null) {
    if (!Array.isArray(times)) return err('invalid', 'times must be an array of "HH:MM" strings');
    const cleaned = [...new Set(times.map((t) => String(t).trim()).filter(Boolean))];
    for (const t of cleaned) {
      if (!HHMM.test(t)) return err('invalid', `not a valid 24h time: ${t}`, { expected: 'HH:MM' });
    }
    if (cleaned.length > MAX_TIMES) {
      return err('invalid', `at most ${MAX_TIMES} digest times`, { got: cleaned.length });
    }
    cleaned.sort();
    // an empty array is how the user turns the digest off
    digestTimes = cleaned.length ? cleaned.join(',') : null;
  }

  let digestScope;
  if (scope !== undefined && scope !== null && String(scope).trim() !== '') {
    const sc = String(scope).trim();
    if (!USER_SCOPES.includes(sc)) {
      return err('invalid', `scope must be one of ${USER_SCOPES.join('|')}`, { got: sc });
    }
    digestScope = sc;
  }

  if (digestTimes === undefined && digestScope === undefined) {
    return err('invalid', 'nothing to change — pass times and/or scope');
  }

  // $2 says whether times was supplied at all, which is what separates
  // "leave it alone" from "turn it off" — both of which arrive here as a
  // null-ish $3.
  const { rows } = await client.query(
    `UPDATE users
        SET digest_times = CASE WHEN $2::boolean THEN $3::text ELSE digest_times END,
            digest_scope = COALESCE($4::text, digest_scope)
      WHERE id = $1
      RETURNING digest_times, digest_scope, timezone`,
    [userId, digestTimes !== undefined, digestTimes ?? null, digestScope ?? null]
  );
  const u = rows[0];
  await audit.record(client, userId, 'digest.preferences_set', {
    digestTimes: u.digest_times, digestScope: u.digest_scope,
  });
  return ok({
    digestTimes: u.digest_times,
    digestScope: u.digest_scope,
    enabled: Boolean(u.digest_times),
    // The sweep resolves these against the user's own zone; surfacing it lets
    // the agent say "20:00 your time" instead of hoping.
    timezone: u.timezone,
  });
}

module.exports = { assemble, setPreferences, SCOPES, USER_SCOPES, MAX_TIMES };
