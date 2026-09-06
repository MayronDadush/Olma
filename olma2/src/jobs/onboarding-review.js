'use strict';
// Three hours after a person's first message, read their first hours back and
// say what happened. Once per person, for ever.
//
// The judgement lives in domain/onboarding-review.js, which is pure. This file
// is the half that touches the world: it assembles the same evidence a human
// would pull — the gateway transcript, their rows in Postgres, the gateway log
// — and writes the answer where the owner will see it.
//
// WHY TWO STAGES. Three hours is early enough that the conversation is still
// the one thing the person has been judged on and a bad reminder has not fired
// yet; late enough that the onboarding rungs at 15m and 2h have run and the
// fact sweep has been round. Yahav's whole first story — the reminder promised
// for an hour nothing was set for, the message that got no answer, the task
// filed over a "no thanks" — was fully formed by 23:05 on his first evening,
// and every one of those was still cheap to fix at that point.
//
// But it was not the whole story, and the three-hour window is structurally
// unable to see the rest. Measured against his real first day: the refusal
// with nothing filed came at 3.7h, "מחר" about that same morning at 4.0h and
// again at 12.7h, two check-in rungs fifty seconds apart at 11.0h, a reminder
// still being chased at 13.0h. Four checks were written for exactly those
// faults and, at three hours, not one of them could ever have fired — which is
// the failure shape this whole file exists to catch, arriving inside the
// catcher (CLAUDE.md: "a detector that can no longer fail is not a detector").
// So a second review reads the first DAY back, after the night gate, the
// check-in ladder and the reminders have all had their turn.
//
// Both stages start at the person's first message; only the end moves, because
// several checks compare something said late against a reminder armed early
// and cannot be shown one without the other. The later stage therefore sees
// everything the earlier one saw, and reports only what is NEW — the earlier
// finding is already on its own row, unacknowledged, and repeating it would
// double every count that reads this table.
//
// It never messages the person. This is a report about the system, addressed
// to whoever runs it.
const usersDomain = require('../domain/users');
const audit = require('../domain/audit');
const { review, worstOf } = require('../domain/onboarding-review');
const sessions = require('../channels/sessions-async');
const laneLog = require('./lane-watchdog');

const REVIEW_AFTER_MS = 3 * 3600_000;
// Stop offering to review a conversation nobody can act on any more. A person
// whose first day was a week ago is a retrospective, not a repair.
const GIVE_UP_AFTER_MS = 48 * 3600_000;
// The day read. 26 hours, not 24: it clears the same hour of the following
// morning, so a first evening's night-gated messages and the morning rungs
// that follow them are inside one window rather than split across its edge.
const DAY_REVIEW_AFTER_MS = 26 * 3600_000;
const DAY_GIVE_UP_AFTER_MS = 5 * 24 * 3600_000;
const STAGES = [
  { id: '3h', after: REVIEW_AFTER_MS, giveUp: GIVE_UP_AFTER_MS },
  { id: '1d', after: DAY_REVIEW_AFTER_MS, giveUp: DAY_GIVE_UP_AFTER_MS },
];
// One review per tick, across both stages. The transcript read is the
// expensive part and this job has no deadline — a backlog of two clears in
// two minutes.
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

async function evidenceFor(client, u, deps, now, stage = STAGES[0]) {
  const startMs = new Date(u.first_turn_at).getTime();
  const endMs = Math.min(startMs + stage.after, now);
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
    `SELECT r.id, r.task_id, r.remind_at, r.auto, r.cancelled_at, r.attempts
       FROM task_reminders r JOIN tasks t ON t.id = r.task_id
      WHERE t.owner_id = $1 AND r.created_at BETWEEN $2 AND $3 ORDER BY r.id`,
    [u.id, new Date(startMs), new Date(endMs)]
  );
  // What Olma DECIDED to say, and when it actually landed. Not the window:
  // the whole first day, because the messages the night gate holds are exactly
  // the ones that arrive together in the morning, hours after the window this
  // review covers has closed. Held-then-released is the pile-up.
  const { rows: sends } = await client.query(
    `SELECT id, kind, payload->>'rung' AS rung, sent_at
       FROM outbox
      WHERE user_id = $1 AND sent_at IS NOT NULL AND hold_reason IS NULL
        AND created_at >= $2
      ORDER BY sent_at`,
    [u.id, new Date(startMs)]
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
    // Every daily log the window touches, not a fixed "today and yesterday":
    // the day stage looks 26 hours back, which is two calendar days from some
    // hours and three from others, and a log file nobody opened is a dropped
    // turn nobody sees.
    const days = new Set();
    for (let t = startMs; t < endMs + 86_400_000; t += 86_400_000) days.add(laneLog.todayLogPath(Math.min(t, endMs)));
    days.add(laneLog.todayLogPath(endMs));
    const chunks = deps.readLogTails ? deps.readLogTails()
      : [...days].map((path) => ({ raw: laneLog.readTail(path) }));
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
      auto: r.auto, attempts: Number(r.attempts) || 0,
      cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
    })),
    sends: sends.map((r) => ({
      kind: r.kind, rung: r.rung, at: new Date(r.sent_at).toISOString(),
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

// What this stage found that no earlier stage already reported. A finding is
// the same finding when its id and its detail are the same — the detail is
// what makes "the 07:00 she called tomorrow" different from "the 19:00 she
// called tomorrow", so comparing on id alone would silence the second.
function newFindings(findings, seen) {
  return findings.filter((f) => !seen.has(`${f.id}|${JSON.stringify(f.detail ?? null)}`));
}
async function sweepOnboardingReview(client, deps = {}) {
  const now = deps.now || Date.now();
  const reviewed = [];

  for (const stage of STAGES) {
    if (reviewed.length >= MAX_PER_TICK) break;
    const { rows } = await client.query(
      `SELECT u.id, u.first_name, u.phone, u.agent_id, u.timezone, u.timezone_confirmed,
              u.locale, u.first_turn_at
         FROM users u
         LEFT JOIN onboarding_reviews r ON r.user_id = u.id AND r.stage = $4
        WHERE u.first_turn_at IS NOT NULL
          AND u.agent_id IS NOT NULL
          AND NOT u.is_eval
          AND r.id IS NULL
          AND u.first_turn_at <= $1 AND u.first_turn_at > $2
        ORDER BY u.first_turn_at
        LIMIT $3`,
      [new Date(now - stage.after), new Date(now - stage.giveUp),
        MAX_PER_TICK - reviewed.length, stage.id]
    );

    for (const u of rows) {
      const evidence = await evidenceFor(client, u, deps, now, stage);
      const all = review(evidence).findings;
      // Everything an earlier stage already put on this person's record. The
      // day review sees the whole first day, the three-hour one included, and
      // a finding reported twice is counted twice by everything downstream.
      const { rows: prior } = await client.query(
        `SELECT findings FROM onboarding_reviews WHERE user_id = $1`, [u.id]
      );
      const seen = new Set();
      for (const row of prior) {
        for (const f of row.findings || []) seen.add(`${f.id}|${JSON.stringify(f.detail ?? null)}`);
      }
      const findings = newFindings(all, seen);
      const worst = worstOf(findings);

      // The row is written whatever the verdict — a clean first day is the
      // baseline every later one is read against, and a review that only ever
      // appears when something is wrong cannot tell you the rate. A second
      // stage with nothing new to say is itself the answer to "did the first
      // day get worse after we stopped watching".
      const ins = await client.query(
        `INSERT INTO onboarding_reviews (user_id, stage, window_start, window_end, worst, findings, evidence)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
         ON CONFLICT (user_id, stage) DO NOTHING
         RETURNING id`,
        [u.id, stage.id, evidence.windowStart, evidence.windowEnd, worst,
          JSON.stringify(findings), JSON.stringify(evidence)]
      );
      if (!ins.rows[0]) continue;   // another tick got there first
      await audit.record(client, u.id, 'onboarding.reviewed', {
        stage: stage.id, worst, findings: findings.map((f) => f.id),
      });
      reviewed.push({
        userId: u.id, stage: stage.id, worst, findings: findings.length, carried: all.length - findings.length,
      });
    }
  }
  return { reviewed };
}

module.exports = {
  sweepOnboardingReview, evidenceFor, readRelease, newFindings,
  STAGES, REVIEW_AFTER_MS, GIVE_UP_AFTER_MS, DAY_REVIEW_AFTER_MS, DAY_GIVE_UP_AFTER_MS, MAX_PER_TICK,
};
