'use strict';
// Session state, read straight off the gateway's own storage.
//
// TWO storage generations, both supported, decided per agent at read time:
//
// - Legacy (OpenClaw ≤ 2026.6.x): `agents/<id>/sessions/sessions.json` — an
//   index keyed by session key — plus one append-only `<sessionId>.jsonl`
//   transcript per session. When sessions.json exists, this module reads the
//   files, exactly as it always did. Every test fixture builds this shape.
//
// - Sqlite (OpenClaw ≥ 2026.8.1): the 2026-08-31 upgrade migrated everything
//   into `agents/<id>/agent/openclaw-agent.sqlite` and DELETED the files —
//   sessions.json is gone, `sessions/` holds only trajectory-path pointers.
//   `session_nodes(session_key, current_session_id, entry_json)` is the old
//   index (entry_json carries the same object sessions.json held per key:
//   sessionId, lastInteractionAt, totalTokens, estimatedCostUsd, model...),
//   and `transcript_events(session_id, seq, event_json)` holds the old
//   transcript lines verbatim, one event per row, seq-ordered. Discovered
//   the hard way: every consumer of this module (intake discovery, usage
//   attribution, fact extraction, the unanswered nets, the dashboard's
//   conversation view) went silently blind the moment the upgrade landed.
//
// The dual mode is deliberate, not transitional debt: the file path is what
// the whole test suite builds its fixtures out of, and it is also what any
// rollback to 2026.6.10 would bring back. sessions.json PRESENT → files;
// absent → the agent sqlite, opened read-only (WAL mode makes a concurrent
// reader safe against the writing gateway).
//
// Measured on the box (2026-08-16): one `openclaw sessions list` call burns
// 2.9s of CPU. brokerd called it every 15s for intake discovery plus once per
// restart busy-check — roughly 20-30% of the droplet's single core, spent
// entirely on polling. This file is the fix: same facts, no process spawn.
// A read-only sqlite open costs single-digit milliseconds — still three
// orders of magnitude under the CLI.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const HOME = () => process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';

// key shape: agent:<agentId>:<channel>:<chatType>:<peer>
function parseKey(key) {
  const m = /^agent:([^:]+):([^:]+):([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  return { agentId: m[1], channel: m[2], chatType: m[3], peer: m[4] };
}

// ---- storage-generation plumbing -------------------------------------------

function legacyIndexPath(agentId, base) {
  return path.join(base, 'agents', agentId, 'sessions', 'sessions.json');
}

function agentDbPath(agentId, base) {
  return path.join(base, 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
}

// Opens the agent's sqlite read-only, runs fn, always closes. Returns null
// when the DB does not exist or cannot be opened — the caller's "no data"
// path, same as a missing sessions.json. Errors INSIDE fn propagate: a
// malformed store should fail the sweep's heartbeat loudly, not read as a
// convincing "no sessions" (the sessions.json-unreadable rule, kept).
function withAgentDb(agentId, base, fn) {
  let db;
  try {
    db = new DatabaseSync(agentDbPath(agentId, base), { readOnly: true });
  } catch {
    return null;
  }
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

function mapIndexEntry(key, parsed, v) {
  const last = Number(v.lastInteractionAt || v.updatedAt || 0);
  return {
    key, ...parsed,
    sessionId: v.sessionId,
    model: v.model || '',
    totalTokens: Number(v.totalTokens || 0),
    // the gateway's own per-model arithmetic; strictly better than our
    // blended-rate guess, so usage attribution prefers it when present
    estimatedCostUsd: v.estimatedCostUsd == null ? null : Number(v.estimatedCostUsd),
    lastInteractionAt: last || null,
    ageMs: last ? Date.now() - last : null,
  };
}

function readAgentIndex(agentId, base) {
  const p = legacyIndexPath(agentId, base);
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { /* not legacy storage */ }

  if (raw !== null) {
    let idx;
    // A half-written index is a transient the next tick fixes — but a
    // permanently malformed one would silently stall intake forever, so it is
    // worth surfacing rather than swallowing.
    try { idx = JSON.parse(raw); } catch (e) { throw new Error(`sessions.json unreadable for ${agentId}: ${e.message}`); }
    const out = [];
    for (const [key, v] of Object.entries(idx)) {
      const parsed = parseKey(key);
      if (!parsed) continue;
      out.push(mapIndexEntry(key, parsed, v));
    }
    return out;
  }

  const rows = withAgentDb(agentId, base, (db) =>
    db.prepare('SELECT session_key, current_session_id, entry_json FROM session_nodes').all());
  if (!rows) return [];
  const out = [];
  for (const r of rows) {
    const parsed = parseKey(r.session_key);
    if (!parsed) continue;
    let v;
    // Same rule as a malformed sessions.json: one corrupt entry in the
    // gateway's OWN store is not a transient we can wait out.
    try { v = JSON.parse(r.entry_json); } catch (e) { throw new Error(`session_nodes entry unreadable for ${agentId}: ${e.message}`); }
    if (!v.sessionId) v.sessionId = r.current_session_id;
    out.push(mapIndexEntry(r.session_key, parsed, v));
  }
  return out;
}

function listAgentIds(base) {
  try {
    return fs.readdirSync(path.join(base, 'agents'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

// Every session across every agent.
function listSessions(base = HOME()) {
  const out = [];
  for (const agentId of listAgentIds(base)) out.push(...readAgentIndex(agentId, base));
  return out;
}

// Just one agent's — what intake discovery needs.
function listSessionsForAgent(agentId, base = HOME()) {
  return readAgentIndex(agentId, base);
}

// Path to watch for "a new person just wrote to intake". Legacy-only: the
// sqlite generation has no per-agent index file, so watchers must poll
// listSessionsForAgent instead (nothing in the tree watches this today).
function indexPath(agentId, base = HOME()) {
  return legacyIndexPath(agentId, base);
}

// ---- reading an actual conversation ----------------------------------------
//
// The last N turns of what a person and Olma actually said, for the dashboard's
// "is this working?" view. Read from the gateway's own transcript rather than
// mirrored into our DB on write: a copy can silently drift from what the user
// really saw, and the whole point of this view is to answer "what actually
// happened" — a second, possibly-wrong record would defeat it.
//
// Written by the gateway in place of a reply when the model call itself fails
// (billing, provider outage, an aborted lane). Matched exactly, not loosely:
// it is a fixed string in the gateway, and a substring match here would let a
// user quoting it erase their own turn from every reader below.
const FAILED_TURN_MARKER = '[assistant turn failed before producing content]';

// Only the visible message text is returned. Model reasoning, tool calls and
// their results are deliberately dropped: they are the noisy majority of the
// transcript, and tool results routinely contain the identity token.
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ');
}

// The gateway wraps proactive turns in a long instruction block. Showing it
// verbatim would bury the conversation in prompt text, so it is labelled.
function isSystemInstruction(text) {
  return /^This is a brand-new user|^You are being asked to|^Send the following message EXACTLY/.test(text.trim());
}

// peer === null → the agent's most recently active session (the dashboard's
// "show me this person's conversation"). peer set → that specific peer's
// session, which is how we recover what a stranger said to the shared intake
// agent before they had an agent of their own.
//
// Returns { file } (legacy) or { sessionId } (sqlite) — readRecentMessages
// treats them as the two halves of one answer.
function currentSessionFor(agentId, base, peer) {
  const p = legacyIndexPath(agentId, base);
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { /* not legacy storage */ }

  if (raw !== null) {
    let idx;
    try { idx = JSON.parse(raw); } catch { return null; }
    const entries = Object.entries(idx).filter(([, v]) => v && v.sessionFile);
    const matching = peer
      ? entries.filter(([key]) => { const k = parseKey(key); return k && k.peer === peer; })
      : entries;
    const best = matching
      .map(([, v]) => v)
      .sort((a, b) => Number(b.lastInteractionAt || b.updatedAt || 0) - Number(a.lastInteractionAt || a.updatedAt || 0))[0];
    return best ? { file: best.sessionFile } : null;
  }

  const best = withAgentDb(agentId, base, (db) => {
    const rows = db.prepare('SELECT session_key, current_session_id, entry_json FROM session_nodes').all();
    let top = null;
    for (const r of rows) {
      if (peer) {
        const k = parseKey(r.session_key);
        if (!k || k.peer !== peer) continue;
      }
      let v = {};
      try { v = JSON.parse(r.entry_json); } catch { /* rank it last */ }
      const at = Number(v.lastInteractionAt || v.updatedAt || 0);
      if (!top || at > top.at) top = { at, sessionId: r.current_session_id };
    }
    return top ? { sessionId: top.sessionId } : null;
  });
  return best || null;
}

// One transcript's raw event objects, newest-first, capped. The cap bounds
// work on a busy transcript that is mostly tool traffic; callers stop as soon
// as they have their `limit` visible messages anyway.
const TRANSCRIPT_TAIL_EVENTS = 1000;

function readTranscriptTail(agentId, base, source) {
  if (source.file) {
    let lines;
    try { lines = fs.readFileSync(source.file, 'utf8').trim().split('\n'); } catch { return []; }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < TRANSCRIPT_TAIL_EVENTS; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* half-written tail line */ }
    }
    return out;
  }
  const rows = withAgentDb(agentId, base, (db) =>
    db.prepare('SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(source.sessionId, TRANSCRIPT_TAIL_EVENTS));
  if (!rows) return [];
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.event_json)); } catch { /* corrupt event */ }
  }
  return out;
}

function readRecentMessages(agentId, limit = 10, base = HOME(), peer = null) {
  const source = currentSessionFor(agentId, base, peer);
  if (!source) return [];

  const out = [];
  // Events arrive newest-first — a long conversation's transcript is mostly
  // tool traffic, and we only ever want the tail.
  for (const o of readTranscriptTail(agentId, base, source)) {
    if (out.length >= limit) break;
    if (o.type !== 'message' || !o.message) continue;
    const role = o.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(o.message.content).trim();
    if (!text) continue; // pure tool-call or reasoning turn
    // A crashed turn is not an answer. When the model call fails outright the
    // gateway still writes an assistant message, whose entire content is this
    // one fixed marker — so to anything reading history back, a dead turn is
    // indistinguishable from a reply. That blinded the one safety net built
    // for exactly this: jobs/unanswered.js saw an "assistant" turn after the
    // user's message and skipped the repair. Observed live 2026-08-20, when
    // the Anthropic account ran out of credit mid-conversation and a user's
    // message got no reply and no repair either.
    if (role === 'assistant' && text === FAILED_TURN_MARKER) continue;
    out.push({
      role,
      text: isSystemInstruction(text) ? '(הודעה יזומה של המערכת)' : text,
      at: o.timestamp || null,
      // a voice note carries its media path; the text is whatever the
      // transcriber made of it, which is exactly what we want to eyeball
      isVoice: Boolean(o.message.MediaType && /audio/.test(o.message.MediaType)),
    });
  }
  return out.reverse();
}

// The WhatsApp display name this person's turns arrived under.
//
// BACKFILL ONLY — do not reach for this on a live path. The supported way to
// learn a display name is `turn_start(sender_name)`, where the agent passes on
// what the gateway put in front of it for free; this function exists because
// three live users were already nameless by the time that existed, and their
// display names were sitting unread in the gateway's own trajectory files.
//
// It is deliberately the expensive one, and it goes around the session index
// rather than through it: the index holds only the CURRENT session per key,
// and the block we need is usually not in that one — only turns the PERSON
// started carry a Conversation info block, so a workspace whose recent traffic
// is proactive delivery has none in its newest session at all. Trajectory
// files stay files in both storage generations; the 2026.8.1 migration parked
// the pre-migration ones in `session-sqlite-import-archive/` with an
// `.imported-<ts>` suffix, so that directory is scanned too.
const CONVERSATION_INFO_RE = /Conversation info[^\n]*\n```json\n([\s\S]*?)\n```/;

function displayNameFromPrompt(prompt, peer = null) {
  const m = CONVERSATION_INFO_RE.exec(String(prompt || ''));
  if (!m) return null;
  let info;
  try { info = JSON.parse(m[1]); } catch { return null; }
  const digits = (v) => String(v || '').replace(/\D/g, '');
  // Whose turn this was. The intake agent's directory is shared by every
  // stranger who ever wrote in, so a name lifted from the wrong session would
  // be a name attached to the wrong person.
  if (peer && digits(info.sender_id) !== digits(peer)) return null;
  const sender = typeof info.sender === 'string' ? info.sender.trim() : '';
  if (!sender) return null;
  // With no display name set, the gateway puts the number in this field.
  if (digits(sender) && digits(sender) === digits(info.sender_id)) return null;
  return sender;
}

function listTrajectoryFiles(dir, suffixRe) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((f) => suffixRe.test(f)).map((f) => path.join(dir, f));
}

function readPeerDisplayName(agentId, peer, base = HOME()) {
  const live = listTrajectoryFiles(
    path.join(base, 'agents', agentId, 'sessions'), /\.trajectory\.jsonl$/);
  const archived = listTrajectoryFiles(
    path.join(base, 'agents', agentId, 'session-sqlite-import-archive'),
    /\.trajectory\.jsonl\.imported-\d+$/);
  let files;
  try {
    files = [...live, ...archived]
      .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f);
  } catch { return null; }

  for (const trajectory of files) {
    let lines;
    try { lines = fs.readFileSync(trajectory, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('Conversation info')) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const found = displayNameFromPrompt(o.data && o.data.prompt, peer);
      if (found) return found;
    }
  }
  return null;
}

// The raw event lines appended to one session KEY since `fromSeq` — sqlite
// generation only; legacy callers read their transcript file directly. This
// exists for the eval harness: 2026.8.1's `agent --json` reports the session
// KEY in `meta.sessionFile` (the transcript is no longer a file), so "the
// tool calls this turn made" has to come from transcript_events. Returns
// { text, offset } with offset = the next unread seq, or null when the agent
// has no sqlite store or the key has no session yet — the caller's signal
// that there is nothing to read rather than an empty turn.
function readSessionEventsSlice(agentId, sessionKey, fromSeq = 0, base = HOME()) {
  return withAgentDb(agentId, base, (db) => {
    const node = db.prepare(
      'SELECT current_session_id FROM session_nodes WHERE session_key = ?').get(sessionKey);
    if (!node) return null;
    const rows = db.prepare(
      'SELECT seq, event_json FROM transcript_events WHERE session_id = ? AND seq >= ? ORDER BY seq')
      .all(node.current_session_id, fromSeq);
    if (!rows.length) return { text: '', offset: fromSeq };
    return {
      text: rows.map((r) => r.event_json).join('\n'),
      offset: Number(rows[rows.length - 1].seq) + 1,
    };
  });
}

// Everything a stranger said to the intake greeter, joined into one blob.
// This is what makes the greeter's silence safe: nothing the person typed
// while we were setting them up is lost — their own agent gets it and
// answers it, so their first reply is a real reply, not a canned hello.
function readPeerUserText(agentId, peer, { limit = 6, maxChars = 600, base = HOME() } = {}) {
  const msgs = readRecentMessages(agentId, limit, base, peer);
  const text = msgs.filter((m) => m.role === 'user').map((m) => m.text).join('\n').trim();
  return text ? text.slice(0, maxChars) : null;
}

// ---- transcripts, for cost accounting --------------------------------------
//
// Every transcript, not just the ones the index still points at. That
// distinction is the entire reason this exists: session keys are reused when
// a session rotates, so the index holds only the CURRENT session per key and
// everything before it disappears from view — including, on one verified day,
// a session carrying 5.69M billable tokens. Legacy: the files stay on disk.
// Sqlite: transcript_events keeps every session's rows regardless of what
// session_nodes currently points at (a deleted/reset session moves to
// session_transcript_archives as a compressed blob — not read here yet; a
// reset is rare and the sweep runs often enough to have consumed it first).
//
// `.trajectory.jsonl` siblings are the gateway's own tracing and carry no
// billable usage blocks; including them would double-count nothing but would
// waste a read of the largest files on disk.
//
// Sqlite entries use a `sqlite:<agentId>:<sessionId>` pseudo-path and count
// EVENTS, not bytes: `size` is max(seq)+1 and the offset readTranscriptUsage
// returns is the next unread seq. The skip test in jobs/usage.js
// (`t.size === fromOffset`) works unchanged.
function listTranscripts(base = HOME()) {
  const out = [];
  for (const agentId of listAgentIds(base)) {
    const dir = path.join(base, 'agents', agentId, 'sessions');
    // Both generations are scanned unconditionally: a legacy agent has no
    // sqlite store, a migrated one has no bare .jsonl left in sessions/ (the
    // migration renames them into the archive dir), so in practice exactly
    // one branch yields entries. The freak overlap — a rollback restoring
    // files beside a leftover sqlite — prefers the files, because a rolled-
    // back gateway appends to the files and the sqlite is the frozen copy.
    const seen = new Set();
    let names;
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.endsWith('.trajectory.jsonl')) continue;
      const file = path.join(dir, name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      const sessionId = name.slice(0, -'.jsonl'.length);
      seen.add(sessionId);
      out.push({ agentId, sessionId, file, size });
    }
    const rows = withAgentDb(agentId, base, (db) =>
      db.prepare('SELECT session_id, max(seq) AS max_seq FROM transcript_events GROUP BY session_id').all());
    if (!rows) continue;
    for (const r of rows) {
      if (seen.has(r.session_id)) continue;
      out.push({
        agentId,
        sessionId: r.session_id,
        file: `sqlite:${agentId}:${r.session_id}`,
        size: Number(r.max_seq) + 1,
      });
    }
  }
  return out;
}

function usageCallOf(o) {
  const m = o && o.message;
  if (!m || m.role !== 'assistant' || !m.usage) return null;
  const u = m.usage;
  return {
    model: m.responseModel || m.model || '',
    at: o.timestamp || null,
    input: Number(u.input) || 0,
    output: Number(u.output) || 0,
    cacheRead: Number(u.cacheRead) || 0,
    cacheWrite: Number(u.cacheWrite) || 0,
  };
}

// The billable calls appended to one transcript since `fromOffset`.
//
// Returns { calls, offset } where the caller persists the returned offset, so
// a re-run reads nothing twice — which is what makes this safe to run on a
// timer against an append-only record. Offsets are BYTES for a file source
// and EVENT SEQS for a sqlite source; the two are never mixed for one
// session, except once: see the era note below.
function readTranscriptUsage(file, fromOffset = 0) {
  const sq = /^sqlite:([^:]+):(.+)$/.exec(String(file || ''));
  if (sq) {
    const [, agentId, sessionId] = sq;
    const result = withAgentDb(agentId, HOME(), (db) => {
      const top = db.prepare(
        'SELECT max(seq) AS max_seq FROM transcript_events WHERE session_id = ?').get(sessionId);
      const size = top && top.max_seq != null ? Number(top.max_seq) + 1 : 0;
      // Era guard. A watermark bigger than the event count is a BYTE offset
      // left over from the file generation of the same session (bytes always
      // dwarf event counts). Re-reading from zero would re-attribute the whole
      // history the file era already charged — the one corruption worse than a
      // gap — so the watermark jumps to "now" and only genuinely new events
      // are ever read. The cost: usage appended between the gateway's own
      // migration moment and the first post-migration sweep goes uncounted,
      // once, and the reconciliation line on the dashboard shows the gap.
      if (fromOffset > size) return { calls: [], offset: size };
      const rows = db.prepare(
        'SELECT event_json FROM transcript_events WHERE session_id = ? AND seq >= ? ORDER BY seq')
        .all(sessionId, fromOffset);
      const calls = [];
      for (const r of rows) {
        let o;
        try { o = JSON.parse(r.event_json); } catch { continue; }
        const c = usageCallOf(o);
        if (c) calls.push(c);
      }
      return { calls, offset: size };
    });
    return result || { calls: [], offset: fromOffset };
  }

  let size;
  try { size = fs.statSync(file).size; } catch { return { calls: [], offset: fromOffset }; }
  // Shrunk means rewritten, not appended — the stored offset now points into
  // the middle of different content. Re-reading from zero may re-attribute
  // what we already counted, but silently skipping the file loses real cost,
  // and losing cost is the failure this whole path exists to end.
  const start = size < fromOffset ? 0 : fromOffset;
  if (size === start) return { calls: [], offset: start };

  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return { calls: [], offset: fromOffset }; }

  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { calls: [], offset: start }; // no complete line yet
  const complete = buf.subarray(0, lastNewline + 1);

  const calls = [];
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const c = usageCallOf(o);
    if (c) calls.push(c);
  }
  return { calls, offset: start + complete.length };
}

module.exports = {
  listSessions, listSessionsForAgent, indexPath, parseKey,
  readRecentMessages, readPeerUserText, readPeerDisplayName, displayNameFromPrompt,
  listTranscripts, readTranscriptUsage, readSessionEventsSlice,
};
