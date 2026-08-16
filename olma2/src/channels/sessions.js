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

module.exports = { listSessions, listSessionsForAgent, indexPath, parseKey };
