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
const reminders = require('./reminders');

const SCOPES = ['summary', 'full', 'today', 'block_view'];

async function assemble(client, userId, scope) {
  if (!SCOPES.includes(scope)) return err('invalid', `scope must be one of ${SCOPES.join('|')}`);

  // `parent_id IS NULL` — a checklist item is not a thing on anybody's list.
  // Every RENDERER already knew that and filtered it out on the way to the
  // screen (digest-block.todoBlock and blockItemCount, tools/digest's
  // listWorthAPage, list-block); the counts are the one place that never
  // learned, so the number over a list of 20 read 36. Measured on the box
  // 2026-09-18: 16 of מאיה's 36 open tasks were items inside other tasks —
  // a packing list, counted as sixteen separate jobs she had not done — and
  // u-3 read 78 for 63. The count and the list it heads have to come out of
  // the same population, and the source is here, not in a fifth copy of the
  // filter downstream.
  const counts = (await client.query(
    `SELECT
       count(*) FILTER (WHERE status = 'open' AND kind IS DISTINCT FROM 'event') ::int AS open_tasks,
       count(*) FILTER (WHERE status = 'open' AND kind IS DISTINCT FROM 'event'
                          AND due_at::date <= CURRENT_DATE) ::int AS due_or_overdue,
       count(*) FILTER (WHERE status = 'open' AND kind = 'event') ::int AS open_events,
       count(*) FILTER (WHERE status = 'open' AND kind = 'event'
                          AND due_at::date = CURRENT_DATE) ::int AS events_today
     FROM tasks WHERE owner_id = $1 AND archived_at IS NULL AND parent_id IS NULL`,
    [userId]
  )).rows[0];
  const reminderCount = (await client.query(
    // attempts = 0: a reminder mid-escalation has already been delivered once
    // and keeps sent_at NULL until its ladder ends, so counting it here would
    // overstate what is still waiting to happen.
    `SELECT count(*)::int AS n FROM task_reminders r JOIN tasks t ON t.id = r.task_id
     WHERE COALESCE(r.user_id, t.owner_id) = $1 AND r.sent_at IS NULL AND r.cancelled_at IS NULL
       AND r.attempts = 0`,
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
  // Meetings waiting on SOMEBODY ELSE. `pendingMeetings` above asks only
  // "what do I owe an answer on", so a meeting the user has already confirmed
  // and is waiting on the other side for was invisible to every digest they
  // ever got. Sarah (user 17) proposed lunch on Aug 31, confirmed her own
  // side, was told "I'll let you know when he answers" — and then heard
  // nothing for three days, from a system that knew the whole time. Being
  // owed an answer is exactly as much news as owing one.
  const awaitingOthers = (await client.query(
    `SELECT m.id, m.title, m.proposed_slot, m.proposed_start_at,
            array_agg(coalesce(w.first_name, w.phone) ORDER BY w.id) AS waiting_on
       FROM meetings m
       JOIN meeting_participants me ON me.meeting_id = m.id AND me.user_id = $1
       JOIN meeting_participants them ON them.meeting_id = m.id
        AND them.user_id <> $1 AND them.state = 'awaiting'
       JOIN users w ON w.id = them.user_id
      WHERE m.status = 'negotiating' AND me.state <> 'opted_out'
      GROUP BY m.id, m.title, m.proposed_slot, m.proposed_start_at`,
    [userId]
  )).rows;
  // Coordinations that ENDED with no time, since the last digest that reached
  // them — expired (the moment passed) or no_match (not enough people left).
  // Until 2026-09-23 that was a message of its own, to the opener alone; now
  // nobody manages a coordination, and the owner chose that its ending is
  // never a message of its own: it is said here, in passing, to everybody who
  // was still in it. Bounded to three days so a first digest after a long gap
  // does not dig up the month. A cancellation is not here — that one was
  // somebody's act and was told at the time.
  const closedMeetings = (await client.query(
    `SELECT m.id, m.title, m.status
       FROM meetings m
       JOIN meeting_participants me ON me.meeting_id = m.id AND me.user_id = $1 AND me.state <> 'opted_out'
      WHERE m.status IN ('expired', 'no_match')
        AND m.closed_at > GREATEST(now() - interval '3 days',
              COALESCE((SELECT max(o.sent_at) FROM outbox o
                         WHERE o.user_id = $1 AND o.kind = 'digest' AND o.hold_reason IS NULL),
                       '-infinity'::timestamptz))
      ORDER BY m.closed_at`,
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

  // Standing nudges the reminder sweep handed to this digest rather than
  // sending on their own (owner, 2026-09-20). On `base`, ABOVE the summary
  // early-return on purpose: a nudge is the one personal item that is not a
  // count — it is a sentence somebody asked to hear at this hour — and the
  // scope they picked says how much of their LIST they want read back, which
  // is a different question. Dropping it on `summary` would turn the feature
  // off for four of the six people who have a digest at all.
  const nudges = await reminders.carriedForDigest(client, userId);

  const base = {
    scope,
    nudges,
    counts: {
      openTasks: counts.open_tasks, dueOrOverdue: counts.due_or_overdue, pendingReminders: reminderCount,
      // Calendar entries counted apart from jobs: "3 open tasks" that are two
      // meetings and an errand is not a number anybody can act on.
      openEvents: counts.open_events, eventsToday: counts.events_today,
    },
    crossUser: { pendingMeetings, awaitingOthers, closedMeetings, pendingConnections, pendingShares },
    ...(closedMeetings.length ? { hints: {
      closedMeetings: 'crossUser.closedMeetings ended since their last digest with no time found '
        + '(expired: the time passed; no_match: not enough people left). Nobody was told on its own — '
        + 'say it in ONE short clause here, by title, never as a question or an apology.',
    } } : {}),
  };

  if (scope === 'summary' || scope === 'block_view') {
    return ok(base); // personal items stay counts-only
  }

  const taskFilter = scope === 'today'
    ? `AND due_at IS NOT NULL AND due_at::date <= CURRENT_DATE` : '';
  const rows = (await client.query(
    `SELECT id, title, category, due_at, ends_at, kind, location, parent_id FROM tasks
     WHERE owner_id = $1 AND status = 'open' AND archived_at IS NULL AND include_in_digest ${taskFilter}
     ORDER BY due_at NULLS LAST, id`,
    [userId]
  )).rows;
  // Two lists, not one: what is on their calendar (a moment they will be at)
  // and what is on their plate (a job until it is done). One mixed list read
  // out in order is how a meeting gets announced as a task — ג.ב, 2026-09-07.
  const strip = (r, keys) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
  const events = rows.filter((r) => r.kind === 'event').map((r) => strip(r, ['kind']));
  const tasks = rows.filter((r) => r.kind !== 'event').map((r) => strip(r, ['kind', 'ends_at', 'location']));
  return ok({ ...base, events, tasks });
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
