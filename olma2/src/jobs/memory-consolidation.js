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
//   * a per-tick cap, because each user costs a model call.
//
// This ran as a silent agent turn until 2026-09-10 — the last background job
// that did. An agent turn carries the whole interactive stack (system prompt,
// AGENTS.md, 60+ tool schemas, ~21k cold tokens) so that the model can call
// file tools; the work underneath is "here are the week's notes, here is the
// current file, return the new one". It reads and thinks and never speaks,
// which is the sentence at the top of adapters/llm.js naming this job as one
// of its own — intended from the start and never moved across.
//
// Moving it also puts the WRITE below the model, which is the other half of
// what that file claims. The rule about phone numbers used to be step 4 of an
// instruction, and an instruction is a request: the model was the only thing
// standing between a contact and the prose file that is not allowed to hold
// one. Now the server checks what came back and refuses to write it.
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../domain/audit');
const llm = require('../adapters/llm');
const { minutesInTz } = require('../outbox/gate');

const EVERY_DAYS = 7;
// The small hours in the user's own zone: their agent is almost certainly idle,
// and this keeps the work off the same cores as live replies.
const QUIET_START_MIN = 3 * 60;   // 03:00
const QUIET_END_MIN = 5 * 60;     // 05:00
const MAX_PER_TICK = 3;
const TURN_TIMEOUT_MS = 120_000;

// A week of notes is small in practice; the cap is here so that one runaway
// workspace cannot send an unbounded prompt. Newest notes are kept.
const MAX_NOTES_CHARS = 20_000;
// The instruction asks for well under 2000 characters. This is the refusal
// line, not the target: past it the model has misunderstood the job, and a
// truncation would leave somebody's memory cut off mid-sentence.
const MAX_MEMORY_CHARS = 4_000;

const SYSTEM = [
  'You maintain one person\'s long-term memory file. You are given their daily',
  'notes from the past week and the current contents of that file, and you',
  'return what the file should now say.',
  '',
  'Answer with a JSON object and nothing else:',
  '  {"changed": true, "memory": "<the complete new file>"}',
  '  {"changed": false}   — when nothing this week is worth keeping',
  '',
  '"memory" must be the WHOLE file, not a patch: it replaces what is there.',
].join('\n');

// Wording follows v1's, which was well judged: it tells the model what to fold
// and, just as importantly, that an empty week is a normal outcome.
function buildInstruction(notes, memory) {
  return [
    'Fold these daily notes into the long-term memory file.',
    '',
    'Rules:',
    '1. Add genuinely durable facts from the week — ongoing situations, context',
    '   that will still matter in a month — that are not already in the file.',
    '2. Fold overlapping or superseded detail into fewer, denser lines rather',
    '   than letting the file grow. Keep the whole file well under 2000',
    '   characters.',
    '3. Never write a phone number, or "who is connected to whom", into the',
    '   file. That lives in the connections system, which is structured and',
    '   tool-backed — prose you might mis-recall is exactly the wrong place for',
    '   it. An answer containing a phone number is refused and the week is lost.',
    '4. If nothing from the week is worth keeping, answer {"changed": false}.',
    '   An empty week is a normal outcome, not something to pad out.',
    '',
    '--- CURRENT MEMORY FILE ---',
    memory || '(empty)',
    '',
    '--- DAILY NOTES FROM THE PAST WEEK ---',
    ...notes.map((n) => `[${n.name}]\n${n.text}`),
  ].join('\n');
}

// Is there anything to fold? Stat-only on purpose: the common tick must cost a
// directory listing, never a model call and not even a file read.
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

// The reads, for a user who already passed hasRecentNotes.
function readNotes(workspacePath, now = Date.now()) {
  let names;
  try {
    const dir = path.join(workspacePath, 'memory');
    const cutoff = now - EVERY_DAYS * 24 * 3600_000;
    names = fs.readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .filter((f) => {
        try { return fs.statSync(path.join(dir, f)).mtimeMs >= cutoff; }
        catch { return false; }
      })
      .sort()
      .reverse(); // newest first, so the cap drops the oldest
  } catch {
    return [];
  }
  const out = [];
  let budget = MAX_NOTES_CHARS;
  for (const name of names) {
    if (budget <= 0) break;
    try {
      const text = fs.readFileSync(path.join(workspacePath, 'memory', name), 'utf8');
      out.push({ name, text: text.slice(0, budget) });
      budget -= text.length;
    } catch { /* an unreadable note is not a failed run */ }
  }
  return out.reverse(); // chronological for the model
}

function readMemory(workspacePath) {
  try {
    return fs.readFileSync(path.join(workspacePath, 'MEMORY.md'), 'utf8');
  } catch {
    return null; // provisioning seeds it; missing means we write a fresh one
  }
}

function writeMemory(workspacePath, text) {
  try {
    fs.writeFileSync(path.join(workspacePath, 'MEMORY.md'), text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// An international number, or a bare run of nine or more digits. Dates and the
// "2000 characters" in the instruction are four digits and do not match; a
// local mobile written as 0501234567 does.
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\d{9,}/;

// What came back is about to overwrite a file nobody reads until it is wrong,
// so nothing doubtful is written. Every refusal leaves the week unstamped: the
// user stays due and the next tick tries again, same as any failed run.
function usableMemory(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'no memory text in the answer' };
  const text = value.trim();
  if (!text) return { ok: false, reason: 'empty memory text' };
  if (text.length > MAX_MEMORY_CHARS) {
    return { ok: false, reason: `memory text is ${text.length} chars, over the ${MAX_MEMORY_CHARS} ceiling` };
  }
  if (PHONE_RE.test(text)) return { ok: false, reason: 'memory text contains a phone number' };
  return { ok: true, text: text.endsWith('\n') ? text : `${text}\n` };
}

// deps.complete({system, user, timeoutMs}) -> {ok, text, model, usage} | {ok:false, error}
// (injected; production uses adapters/llm.complete, tests a recorder). The file
// readers and the writer are injectable for the same reason.
async function sweepMemoryConsolidation(client, deps = {}) {
  const now = deps.now || Date.now();
  const hasNotes = deps.hasRecentNotes || hasRecentNotes;
  const complete = deps.complete || llm.complete;
  const getNotes = deps.readNotes || readNotes;
  const getMemory = deps.readMemory || readMemory;
  const putMemory = deps.writeMemory || writeMemory;
  const due = await dueUsers(client, now);

  const out = { considered: due.length, consolidated: [], unchanged: 0, skipped: 0, failed: [] };
  for (const u of due) {
    // The cap bounds MODEL CALLS, not candidates: slicing the list first let a
    // user with nothing to fold hold a slot every tick while someone with a
    // real week of notes was never reached (the same starvation the fact
    // extraction sweep documents).
    if (out.consolidated.length + out.unchanged + out.failed.length >= MAX_PER_TICK) break;
    if (!hasNotes(u.workspace_path, now)) { out.skipped++; continue; }

    const notes = getNotes(u.workspace_path, now);
    // hasRecentNotes said yes and the read came back empty: the files went away
    // between the two, or none of them could be read. Not a failure to retry a
    // model call over.
    if (!notes.length) { out.skipped++; continue; }

    const res = await complete({
      ...(await llm.backgroundModel(client)),
      system: SYSTEM,
      user: buildInstruction(notes, getMemory(u.workspace_path)),
      timeoutMs: TURN_TIMEOUT_MS,
      // The answer is a whole file, and the instruction caps that file well
      // below this. Stated rather than left to the adapter default so that
      // somebody editing the ceiling in the prompt sees the budget beside it.
      maxTokens: llm.BACKGROUND_MAX_TOKENS,
    });

    // Usage is written down for every call that reached the model, parseable or
    // not — a direct call leaves no transcript, so a refusal that skipped this
    // would be spend the dashboard cannot see.
    if (res.ok) {
      try { await llm.recordUsage(client, u.id, res.model, res.usage); }
      catch { /* never fail a run over bookkeeping */ }
    }

    const parsed = res.ok ? llm.parseJsonObject(res.text) : null;
    if (!parsed) {
      out.failed.push({ userId: u.id, error: llm.whyUnparseable(res).slice(0, 200) });
      continue;
    }

    // "Nothing worth keeping" is a real answer, not a failed run — and it still
    // stamps the audit row, because that row IS the schedule and an unstamped
    // quiet week would be re-read every tick for ever.
    if (parsed.changed === false) {
      await audit.record(client, u.id, 'memory.consolidated',
        { agentId: u.agent_id, model: res.model, changed: false });
      out.unchanged++;
      continue;
    }

    const check = usableMemory(parsed.memory);
    if (!check.ok) { out.failed.push({ userId: u.id, error: check.reason }); continue; }

    const wrote = putMemory(u.workspace_path, check.text);
    if (!wrote.ok) { out.failed.push({ userId: u.id, error: wrote.error }); continue; }

    await audit.record(client, u.id, 'memory.consolidated',
      { agentId: u.agent_id, model: res.model, changed: true, chars: check.text.length });
    out.consolidated.push(u.id);
  }
  return out;
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
        AND u.workspace_path IS NOT NULL AND u.onboarded_at IS NOT NULL
        AND NOT u.is_eval`
  );
  return rows.filter((u) => {
    if (!inQuietHours(u.timezone, now)) return false;
    if (u.last_run && now - new Date(u.last_run).getTime() < EVERY_DAYS * 24 * 3600_000) return false;
    return true;
  });
}

module.exports = {
  sweepMemoryConsolidation, dueUsers, hasRecentNotes, inQuietHours,
  readNotes, readMemory, writeMemory, usableMemory, buildInstruction,
  SYSTEM, EVERY_DAYS, MAX_PER_TICK, MAX_MEMORY_CHARS,
};
