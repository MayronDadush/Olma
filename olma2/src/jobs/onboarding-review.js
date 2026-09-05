'use strict';
// Three hours after a person's first message, read their first hours back and
// say what happened. Once per person, for ever.
//
// The judgement lives in domain/onboarding-review.js, which is pure. This file
// is the half that touches the world: it assembles the same evidence a human
// would pull — the gateway transcript, their rows in Postgres, the gateway log
// — and writes the answer where the owner will see it.
//
// WHY THREE HOURS. Early enough that the conversation is still the one thing
// the person has been judged on and a bad reminder has not fired yet; late
// enough that the onboarding rungs at 15m and 2h have run and the fact sweep
// has been round. Yahav's whole story — the reminder promised for an hour
// nothing was set for, the message that got no answer, the task filed over a
// "no thanks" — was fully formed by 23:05 on his first evening, and every one
// of those was still cheap to fix at that point.
//
// It never messages the person. This is a report about the system, addressed
// to whoever runs it.
const usersDomain = require('../domain/users');
const audit = require('../domain/audit');
const { review } = require('../domain/onboarding-review');
const sessions = require('../channels/sessions-async');
const laneLog = require('./lane-watchdog');

const REVIEW_AFTER_MS = 3 * 3600_000;
// Stop offering to review a conversation nobody can act on any more. A person
// whose first day was a week ago is a retrospective, not a repair.
const GIVE_UP_AFTER_MS = 48 * 3600_000;
// One person per tick. The transcript read is the expensive part and this job
// has no deadline — a backlog of two clears in two minutes.
const MAX_PER_TICK = 1;
// How many messages back to read. Three hours of a busy first evening was 14
// on the worst day so far; the cap is for a runaway, not for the normal case.
const TRANSCRIPT_LIMIT = 200;

// Tools that earn a reaction on the person's message (domain/reactions.js,
// TOOL_MARKS). We have no per-message record of a mark being placed — brokerd
// puts it on the phone and writes nothing down — so it is derived from the
// audit row the same tool call left behind: a reply that follows one of these
// within MARK_WINDOW_MS was almost certainly sent under a mark. Approximate on
// purpose, and only ever feeds a `note`.
const MARK_EVENTS = new Set([
  'task.created', 'task.bulk_created', 'task.completed', 'task.archived',
  'reminder.created', 'reminder.cancelled', 'fact.remembered', 'fact.forgotten',
  'preference.remembered', 'calendar.event_created',
]);
const MARK_WINDOW_MS = 120_000;

// The shape a failing tool call takes in the transcript when brokerd is not
// answering — the exact string three of Yahav's calls came back with while a
// deploy restarted it under him.
const TOOL_ERROR_RE = /assistant backend not reachable|ERROR unavailable/g;

// ---- assembly ---------------------------------------------------------------

async function evidenceFor(client, u, deps, now) {
  const startMs = new Date(u.first_turn_at).getTime();
  const endMs = Math.min(startMs + REVIEW_AFTER_MS, now);
  const inWindow = (at) => {
    const t = Date.parse(at);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  };

  const readMessages = deps.readMessages
    || ((agentId, peer) => sessions.readRecentMessages(agentId, TRANSCRIPT_LIMIT, undefined, peer));
  let msgs = [];
  try { msgs = (await readMessages(u.agent_id, u.phone)) || []; } catch { msgs = []; }

  const { rows: tasks } = await client.query(
    `SELECT id, title, source, due_at, status, created_at FROM tasks
      WHERE owner_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY id`,
    [u.id, new Date(startMs), new Date(endMs)]
  );
  const { rows: reminders } = await client.query(
    `SELECT r.id, r.task_id, r.remind_at, r.auto, r.cancelled_at
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.created_at BETWEEN $2 AND $3 ORDER BY r.id`,
    [u.id, new Date(startMs), new Date(endMs)]
  );
  const { rows: counts } = await client.query(
    `SELECT (SELECT count(*) FROM user_facts WHERE user_id = $1)::int AS facts,
            (SELECT count(*) FROM user_preferences WHERE user_id = $1)::int AS preferences`,
    [u.id]
  );
  const { rows: integrations } = await client.query(
    `SELECT provider, status FROM integrations WHERE user_id = $1`, [u.id]
  );
  const { rows: auditRows } = await client.query(
    `SELECT event, created_at, detail FROM audit_log
      WHERE actor_id = $1 AND created_at BETWEEN $2 AND $3 ORDER BY created_at`,
    [u.id, new Date(startMs), new Date(endMs)]
  );
  const { rows: repairs } = await client.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE actor_id = $1 AND event = 'delivery.unanswered_repair'
        AND created_at BETWEEN $2 AND $3`,
    [u.id, new Date(startMs), new Date(endMs)]
  );

  const markMoments = auditRows.filter((a) => MARK_EVENTS.has(a.event))
    .map((a) => new Date(a.created_at).getTime());

  const said = msgs.filter((m) => m.at && inWindow(m.at));
  const outbound = said.filter((m) => m.role === 'assistant').map((m) => ({
    at: m.at, text: m.text,
    markPlaced: markMoments.some((t) => {
      const d = Date.parse(m.at) - t;
      return d >= 0 && d <= MARK_WINDOW_MS;
    }),
  }));
  const inbound = said.filter((m) => m.role === 'user' && !/^DELIVERY:/.test(String(m.text || '')))
    .map((m) => ({ at: m.at, text: m.text }));

  // Failing tool calls, counted off the raw session events — the transcript's
  // text-only view drops tool results entirely, which is precisely where this
  // evidence lives.
  let toolErrors = 0;
  try {
    const key = usersDomain.sessionKeyFor(u.agent_id, 'whatsapp');
    const slice = deps.readSessionEvents
      ? await deps.readSessionEvents(u.agent_id, key)
      : await sessions.readSessionEventsSlice(u.agent_id, key, 0);
    if (slice && slice.text) toolErrors = (slice.text.match(TOOL_ERROR_RE) || []).length;
  } catch { toolErrors = 0; }

  // Dropped turns the gateway named for this person, whether or not the repair
  // sweep got to them.
  let droppedTurns = [];
  try {
    const chunks = deps.readLogTails ? deps.readLogTails() : [
      { raw: laneLog.readTail(laneLog.todayLogPath(now - 24 * 3600_000)) },
      { raw: laneLog.readTail(laneLog.todayLogPath(now)) },
    ];
    const { parseKey } = require('../channels/sessions');
    for (const { raw } of chunks) {
      for (const d of laneLog.parseDroppedTurns(raw)) {
        const parsed = parseKey(d.sessionKey);
        if (parsed && parsed.peer === u.phone && d.at >= startMs && d.at <= endMs) {
          droppedTurns.push({ messageId: d.messageId, at: new Date(d.at).toISOString() });
        }
      }
    }
  } catch { droppedTurns = []; }

  const release = deps.readRelease ? deps.readRelease() : readRelease();

  return {
    user: {
      id: u.id, firstName: u.first_name, timezone: u.timezone,
      timezoneConfirmed: u.timezone_confirmed, locale: u.locale,
    },
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    outbound,
    inbound,
    tasks: tasks.map((t) => ({
      id: t.id, title: t.title, source: t.source, status: t.status,
      dueAt: t.due_at ? new Date(t.due_at).toISOString() : null,
    })),
    reminders: reminders.map((r) => ({
      id: r.id, taskId: r.task_id, remindAt: new Date(r.remind_at).toISOString(),
      auto: r.auto, cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    })),
    facts: counts[0].facts,
    preferences: counts[0].preferences,
    integrations,
    droppedTurns,
    repairs: repairs[0].n,
    toolErrors,
    // A release whose marker was written inside the window landed on top of
    // them. null when the marker could not be read at all — could-not-tell is
    // never scored as did-not-happen (CLAUDE.md).
    deployedDuringWindow: release === null ? null
      : (release.at >= startMs && release.at <= endMs),
    release: release ? release.sha : null,
    calendarOffered: outbound.some((m) => /יומן|calendar/i.test(m.text))
      || auditRows.some((a) => /^calendar\./.test(a.event)),
    audit: auditRows.map((a) => ({ event: a.event, at: new Date(a.created_at).toISOString() })),
  };
}

// /opt/olma2/RELEASE, written by deploy.sh. Its mtime is when the deploy ran.
function readRelease() {
  try {
    const fs = require('node:fs');
    const path = process.env.OLMA_RELEASE_PATH || '/opt/olma2/RELEASE';
    const stat = fs.statSync(path);
    const text = fs.readFileSync(path, 'utf8');
    const sha = (/sha[=: ]+([0-9a-f]{7,40})/i.exec(text) || [])[1] || null;
    return { at: stat.mtimeMs, sha };
  } catch {
    return null;   // not "no deploy" — no answer
  }
}

// ---- the sweep --------------------------------------------------------------

async function sweepOnboardingReview(client, deps = {}) {
  const now = deps.now || Date.now();
  const { rows } = await client.query(
    `SELECT u.id, u.first_name, u.phone, u.agent_id, u.timezone, u.timezone_confirmed,
            u.locale, u.first_turn_at
       FROM users u
       LEFT JOIN onboarding_reviews r ON r.user_id = u.id
      WHERE u.first_turn_at IS NOT NULL
        AND u.agent_id IS NOT NULL
        AND NOT u.is_eval
        AND r.id IS NULL
        AND u.first_turn_at <= $1 AND u.first_turn_at > $2
      ORDER BY u.first_turn_at
      LIMIT $3`,
    [new Date(now - REVIEW_AFTER_MS), new Date(now - GIVE_UP_AFTER_MS), MAX_PER_TICK]
  );
  if (!rows.length) return { reviewed: [] };

  const reviewed = [];
  for (const u of rows) {
    const evidence = await evidenceFor(client, u, deps, now);
    const { findings, worst } = review(evidence);
    // The row is written whatever the verdict — a clean first day is the
    // baseline every later one is read against, and a review that only ever
    // appears when something is wrong cannot tell you the rate.
    const ins = await client.query(
      `INSERT INTO onboarding_reviews (user_id, window_start, window_end, worst, findings, evidence)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [u.id, evidence.windowStart, evidence.windowEnd, worst,
        JSON.stringify(findings), JSON.stringify(evidence)]
    );
    if (!ins.rows[0]) continue;   // another tick got there first
    await audit.record(client, u.id, 'onboarding.reviewed', {
      worst, findings: findings.map((f) => f.id),
    });
    reviewed.push({ userId: u.id, worst, findings: findings.length });
  }
  return { reviewed };
}

module.exports = {
  sweepOnboardingReview, evidenceFor, readRelease,
  REVIEW_AFTER_MS, GIVE_UP_AFTER_MS, MAX_PER_TICK,
};
