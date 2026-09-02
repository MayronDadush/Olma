'use strict';
// Turns a finished phone call into the two things a WhatsApp chapter already
// produces via fact-extraction.js: durable facts/tasks, and — new here — a
// short WhatsApp recap, since nobody else was watching this channel. A call's
// own hangup IS its chapter boundary, so unlike fact-extraction there is no
// idle-gap heuristic to compute — a written transcript file is simply due.
//
// Source: /opt/olma2-voice-bridge/transcripts/<ts>.json, written by the voice
// bridge on every call's `stop` event as {user: <id>, messages: [...]}. This
// job reaches into another service's directory on purpose — both already run
// on the same box, and the bridge already requires olma2's own domain modules
// directly (see the persona work, PR #86); a shared filesystem is the
// simplest join between two processes that will only ever run on one host.
//
// "Processed" is a file move to processed/, not a DB row: a crash between the
// writes below and the move just means the same call is looked at again next
// tick, and every write downstream is itself safe to repeat — the summary's
// enqueue is idempotency-keyed on the filename, and a fact/task the model
// re-proposes is caught by the same dedupe reference (known facts, open task
// list) a second read of the same transcript would produce anyway. No new
// table, no migration.
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../domain/audit');
const llm = require('../adapters/llm');
const { enqueue } = require('../outbox/enqueue');
const extraction = require('./fact-extraction');

const TRANSCRIPTS_DIR = process.env.VOICE_TRANSCRIPTS_DIR || '/opt/olma2-voice-bridge/transcripts';
const PROCESSED_SUBDIR = 'processed';
// Each call costs a model turn on a one-core box shared with live replies —
// same reasoning as fact-extraction's own per-tick cap.
const MAX_PER_TICK = 3;
const TURN_TIMEOUT_MS = 120_000;

// Call messages are {role, content, tool_calls?} — buildInstruction wants the
// same {role, text} shape a WhatsApp read already produces. Tool turns and
// empty/non-string content carry nothing anyone said or heard.
function toChatMessages(callMessages) {
  return (Array.isArray(callMessages) ? callMessages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, text: m.content.trim() }));
}

function listPendingFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; } // bridge not installed here — nothing to do
  return names.filter((n) => n.endsWith('.json')).sort();
}

function moveToProcessed(dir, file) {
  const processedDir = path.join(dir, PROCESSED_SUBDIR);
  fs.mkdirSync(processedDir, { recursive: true });
  fs.renameSync(path.join(dir, file), path.join(processedDir, file));
}

async function processFile(client, dir, file, deps) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const userId = Number(raw.user);
  const { rows } = await client.query(
    `SELECT id, first_name FROM users WHERE id = $1 AND status = 'active' AND NOT is_eval`,
    [userId]
  );
  const user = rows[0];
  const chat = toChatMessages(raw.messages);
  const said = chat.some((m) => m.role === 'user');

  // No matching user row, or a call that opened with nobody saying a word (a
  // missed call, a hangup mid-greeting) — nothing to learn and nothing to
  // recap, but the file still counts as handled.
  if (!user || !said) return { skipped: true };

  const transcript = extraction.renderTranscript(chat);
  const { known, openTasks, meetingConstraints } = await extraction.gatherContext(client, user.id);
  const message = extraction.buildInstruction(transcript, known, openTasks,
    { firstName: user.first_name }, meetingConstraints, { includeSummary: true });

  const complete = deps.complete || llm.complete;
  const res = await complete({ ...(await llm.backgroundModel(client)), user: message, timeoutMs: TURN_TIMEOUT_MS });
  const parsed = res.ok ? llm.parseJsonObject(res.text) : null;
  if (!res.ok || !parsed) {
    return { failed: true, error: String((res && res.error) || 'unparseable model output').slice(0, 200) };
  }
  try { await llm.recordUsage(client, user.id, res.model, res.usage); } catch { /* never fail the run over bookkeeping */ }

  const applied = await extraction.applyExtraction(client, user, parsed, new Set(known.map((f) => Number(f.id))));
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 1000) : '';

  if (summary) {
    // payload.instruction is delivered verbatim by channels/openclaw.js — no
    // new `case` needed there, same as any other free-text proactive kind.
    await enqueue(client, {
      userId: user.id, kind: 'voice_call_summary', urgency: 'normal',
      payload: {
        instruction: `A phone call with the user just ended. Tell them, in their own language, in one short warm message: <<<${summary}>>>. This IS the recap — do not add filler, do not re-derive it, and do not mention it came from a background process.`,
      },
      idempotencyKey: `voicecall:${file}`,
    });
  }

  await audit.record(client, user.id, 'voice_call.processed', {
    file, factsRecorded: applied.recorded, tasksCaptured: applied.tasksCaptured,
    summarized: Boolean(summary),
  });

  return { processed: true, userId: user.id };
}

// deps.complete, deps.refreshCard, deps.transcriptsDir — the same injection
// shape fact-extraction.js uses, for the same reason: tests never touch a
// real LLM or a real filesystem path outside their own tmp dir.
async function sweepVoiceCalls(client, deps = {}) {
  const dir = deps.transcriptsDir || TRANSCRIPTS_DIR;
  const files = listPendingFiles(dir).slice(0, MAX_PER_TICK);
  const out = { considered: files.length, processed: [], skipped: 0, failed: [] };
  for (const file of files) {
    try {
      const result = await processFile(client, dir, file, deps);
      if (result.processed) { out.processed.push(result.userId); moveToProcessed(dir, file); }
      else if (result.skipped) { out.skipped++; moveToProcessed(dir, file); }
      else if (result.failed) out.failed.push({ file, error: result.error });
      // A failed file is left in place on purpose: this tick or the next one
      // retries it, and nothing here can succeed silently twice.
    } catch (e) {
      out.failed.push({ file, error: String(e.message).slice(0, 200) });
    }
  }
  return out;
}

module.exports = {
  sweepVoiceCalls, processFile, toChatMessages, listPendingFiles,
  TRANSCRIPTS_DIR, MAX_PER_TICK,
};
