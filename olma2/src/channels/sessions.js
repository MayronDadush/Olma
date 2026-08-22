'use strict';
// Session state, read straight off disk.
//
// The gateway maintains `agents/<id>/sessions/sessions.json` — an index keyed
// by session key, carrying everything `openclaw sessions list --all-agents
// --json` reports (and more: per-session token counters and the gateway's own
// cost estimate). Reading it costs microseconds.
//
// Measured on the box (2026-08-16): one `openclaw sessions list` call burns
// 2.9s of CPU. brokerd called it every 15s for intake discovery plus once per
// restart busy-check — roughly 20-30% of the droplet's single core, spent
// entirely on polling. The gateway shares that core, so the polling was
// directly slowing down every reply Olma gave. This file is the fix: same
// facts, no process spawn, cheap enough to read on a 5s tick or an fs.watch.
const fs = require('node:fs');
const path = require('node:path');

const HOME = () => process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';

// key shape: agent:<agentId>:<channel>:<chatType>:<peer>
function parseKey(key) {
  const m = /^agent:([^:]+):([^:]+):([^:]+):(.+)$/.exec(key);
  if (!m) return null;
  return { agentId: m[1], channel: m[2], chatType: m[3], peer: m[4] };
}

function readAgentIndex(agentId, base) {
  const p = path.join(base, 'agents', agentId, 'sessions', 'sessions.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  let idx;
  // A half-written index is a transient the next tick fixes — but a
  // permanently malformed one would silently stall intake forever, so it is
  // worth surfacing rather than swallowing.
  try { idx = JSON.parse(raw); } catch (e) { throw new Error(`sessions.json unreadable for ${agentId}: ${e.message}`); }
  const out = [];
  for (const [key, v] of Object.entries(idx)) {
    const parsed = parseKey(key);
    if (!parsed) continue;
    const last = Number(v.lastInteractionAt || v.updatedAt || 0);
    out.push({
      key, ...parsed,
      sessionId: v.sessionId,
      model: v.model || '',
      totalTokens: Number(v.totalTokens || 0),
      // the gateway's own per-model arithmetic; strictly better than our
      // blended-rate guess, so usage attribution prefers it when present
      estimatedCostUsd: v.estimatedCostUsd == null ? null : Number(v.estimatedCostUsd),
      lastInteractionAt: last || null,
      ageMs: last ? Date.now() - last : null,
    });
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

// Just one agent's — what intake discovery needs (one small file, not N).
function listSessionsForAgent(agentId, base = HOME()) {
  return readAgentIndex(agentId, base);
}

// Path to watch for "a new person just wrote to intake".
function indexPath(agentId, base = HOME()) {
  return path.join(base, 'agents', agentId, 'sessions', 'sessions.json');
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
// file, and tool results routinely contain the identity token.
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
function sessionFileFor(agentId, base, peer) {
  const dir = path.join(base, 'agents', agentId, 'sessions');
  let idx;
  try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')); } catch { return null; }
  const entries = Object.entries(idx).filter(([, v]) => v && v.sessionFile);
  const matching = peer
    ? entries.filter(([key]) => { const p = parseKey(key); return p && p.peer === peer; })
    : entries;
  const best = matching
    .map(([, v]) => v)
    .sort((a, b) => Number(b.lastInteractionAt || b.updatedAt || 0) - Number(a.lastInteractionAt || a.updatedAt || 0))[0];
  return best ? best.sessionFile : null;
}

function readRecentMessages(agentId, limit = 10, base = HOME(), peer = null) {
  const sessionFile = sessionFileFor(agentId, base, peer);
  if (!sessionFile) return [];

  let lines;
  try { lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n'); } catch { return []; }

  const out = [];
  // Walk backwards — a long conversation's transcript is mostly tool traffic,
  // and we only ever want the tail.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
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
// Every transcript file on disk, not just the ones sessions.json still points
// at. That distinction is the entire reason this exists: session keys are
// reused when a session rotates, so the index holds only the CURRENT session
// per key and everything before it disappears from view — including, on one
// verified day, a session carrying 5.69M billable tokens. The files stay.
//
// `.trajectory.jsonl` siblings are the gateway's own tracing and carry no
// billable usage blocks; including them would double-count nothing but would
// waste a read of the largest files on disk.
function listTranscripts(base = HOME()) {
  const out = [];
  for (const agentId of listAgentIds(base)) {
    const dir = path.join(base, 'agents', agentId, 'sessions');
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || name.endsWith('.trajectory.jsonl')) continue;
      const file = path.join(dir, name);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      out.push({ agentId, sessionId: name.slice(0, -'.jsonl'.length), file, size });
    }
  }
  return out;
}

// The billable calls appended to one transcript since `fromOffset`.
//
// Returns { calls, offset } where offset is advanced ONLY past complete lines:
// a transcript being written to right now ends mid-JSON, and consuming that
// partial line would both lose the call and corrupt the resume point. The
// caller persists the returned offset, so a re-run reads nothing twice — which
// is what makes this safe to run on a timer against an append-only file.
function readTranscriptUsage(file, fromOffset = 0) {
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
    const m = o.message;
    if (!m || m.role !== 'assistant' || !m.usage) continue;
    const u = m.usage;
    calls.push({
      model: m.responseModel || m.model || '',
      at: o.timestamp || null,
      input: Number(u.input) || 0,
      output: Number(u.output) || 0,
      cacheRead: Number(u.cacheRead) || 0,
      cacheWrite: Number(u.cacheWrite) || 0,
    });
  }
  return { calls, offset: start + complete.length };
}

module.exports = {
  listSessions, listSessionsForAgent, indexPath, parseKey,
  readRecentMessages, readPeerUserText,
  listTranscripts, readTranscriptUsage,
};
