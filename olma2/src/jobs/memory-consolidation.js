'use strict';
// Weekly memory consolidation — fold each person's raw daily notes into their
// curated long-term file.
//
// Provisioning seeds every workspace with MEMORY.md and a memory/ directory,
// and the gateway auto-injects the last two days of memory/YYYY-MM-DD.md on
// session start. Without this job nothing ever folds them: the daily notes
// just accumulate, and MEMORY.md — the file that is supposed to carry what
// still matters in a month — stays as provisioning wrote it. v1 had this as a
// root-crontab script; it was left behind by the cutover.
//
// Shape differences from v1, all forced by living inside brokerd:
//   * no crontab, no `openclaw cron` (that wants an admin scope upgrade this
//     does not need) — an hourly tick that decides for itself;
//   * per-user timing, not one global Sunday 03:00, because "the small hours"
//     is only meaningful in the user's own timezone;
//   * a per-tick cap, because each user costs a model turn and the box has
//     one core.
//
// The turn runs WITHOUT --deliver: the agent still reads and writes its files,
// but nothing is sent to anyone. This is housekeeping the user never sees.
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../domain/audit');
const { minutesInTz } = require('../outbox/gate');

const EVERY_DAYS = 7;
// The small hours in the user's own zone: their agent is almost certainly idle,
// and on a single-core box that keeps this off the same core as live replies.
const QUIET_START_MIN = 3 * 60;   // 03:00
const QUIET_END_MIN = 5 * 60;     // 05:00
const MAX_PER_TICK = 3;
const TURN_TIMEOUT_MS = 120_000;

// An INSTRUCTION, never content — the same rule the digest incident bought.
// Wording follows v1's, which was well judged: it tells the agent what to fold
// and, just as importantly, that an empty week is a normal outcome.
const PAYLOAD = [
  'Fold your recent daily notes into your long-term memory file. Do this now,',
  'silently — nothing is being sent to anyone, and you must not reply to the user.',
  '',
  'Steps, in order:',
  '1. List `memory/` in your workspace and read any memory/YYYY-MM-DD.md files',
  '   from the last 7 days.',
  '2. Read your current MEMORY.md.',
  '3. Update MEMORY.md: add genuinely durable facts from the week (ongoing',
  '   situations, context that will still matter in a month) that are not',
  '   already there. Fold overlapping or superseded detail into fewer, denser',
  '   lines rather than letting the file grow — keep the whole file well under',
  '   2000 characters.',
  '4. Never write a phone number, or "who is connected to whom", into MEMORY.md.',
  '   That lives in the connections system (list_my_connections /',
  '   set_contact_label), which is structured and tool-backed — prose you might',
  '   mis-recall is exactly the wrong place for it.',
  '5. If nothing from the week is worth keeping, leave MEMORY.md unchanged.',
  '   An empty week is a normal outcome, not something to pad out.',
].join('\n');

// Is there anything to fold? A model turn for a user who wrote no notes is
// pure cost, and on this box it competes with live replies.
function hasRecentNotes(workspacePath, now = Date.now()) {
  try {
    const dir = path.join(workspacePath, 'memory');
    const cutoff = now - EVERY_DAYS * 24 * 3600_000;
    return fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .some((f) => {
        try { return fs.statSync(path.join(dir, f)).mtimeMs >= cutoff; }
        catch { return false; }
      });
  } catch {
    return false; // no memory/ dir yet — nothing to do, not an error
  }
}

function inQuietHours(tz, now) {
  const m = minutesInTz(tz, new Date(now));
  return m >= QUIET_START_MIN && m < QUIET_END_MIN;
}

// Users due a fold: active, with an agent, onboarded, not consolidated in the
// last EVERY_DAYS, and currently in their own small hours.
async function dueUsers(client, now = Date.now()) {
  const { rows } = await client.query(
    `SELECT u.id, u.agent_id, u.workspace_path, u.timezone,
            (SELECT max(a.created_at) FROM audit_log a
              WHERE a.actor_id = u.id AND a.event = 'memory.consolidated') AS last_run
       FROM users u
      WHERE u.status = 'active' AND u.agent_id IS NOT NULL
        AND u.workspace_path IS NOT NULL AND u.onboarded_at IS NOT NULL`
  );
  return rows.filter((u) => {
    if (!inQuietHours(u.timezone, now)) return false;
    if (u.last_run && now - new Date(u.last_run).getTime() < EVERY_DAYS * 24 * 3600_000) return false;
    return true;
  });
}

// deps.runAgent({agentId, message}) -> {ok, error?}   (injected; production
// uses channels/openclaw.runSilentAgentTurn, tests a recorder)
async function sweepMemoryConsolidation(client, deps = {}) {
  const now = deps.now || Date.now();
  const hasNotes = deps.hasRecentNotes || hasRecentNotes;
  const due = await dueUsers(client, now);

  const out = { considered: due.length, consolidated: [], skipped: 0, failed: [] };
  for (const u of due) {
    // The cap bounds MODEL TURNS, not candidates: slicing the list first let a
    // user with nothing to fold hold a slot every tick while someone with a
    // real week of notes was never reached (the same starvation the fact
    // extraction sweep documents).
    if (out.consolidated.length + out.failed.length >= MAX_PER_TICK) break;
    if (!hasNotes(u.workspace_path, now)) { out.skipped++; continue; }

    const res = await deps.runAgent({
      agentId: u.agent_id,
      message: PAYLOAD,
      // A key of its own, per run. Without one the gateway files every silent
      // turn into the agent's default session, so each week's turn re-sends
      // all the previous ones as context — and that session, being the most
      // recently active, is what a peer-less transcript read would pick up.
      sessionKey: `agent:${u.agent_id}:memory-${now}`,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    if (res && res.ok) {
      // The audit row IS the schedule — it is what makes the next run due in a
      // week, so it must be written even though nothing user-visible happened.
      await audit.record(client, u.id, 'memory.consolidated', { agentId: u.agent_id });
      out.consolidated.push(u.id);
    } else {
      // One agent failing must not stop the sweep for everyone else, and must
      // not count as a run — it stays due, and the next tick tries again.
      out.failed.push({ userId: u.id, error: String((res && res.error) || 'unknown').slice(0, 200) });
    }
  }
  return out;
}

module.exports = {
  sweepMemoryConsolidation, dueUsers, hasRecentNotes, inQuietHours,
  PAYLOAD, EVERY_DAYS, MAX_PER_TICK,
};
