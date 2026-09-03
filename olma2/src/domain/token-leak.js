'use strict';
// A live identity token that reached a real person's chat.
//
// On 2026-09-02 u-3's agent tried to call `render_schedule_card` and the model
// failed to format the tool call, emitting DeepSeek's raw `<｜DSML｜tool_calls>`
// syntax as ordinary reply text instead. During a DELIVERY turn ("whatever you
// say in this turn is automatically sent to the user") that text went to
// WhatsApp verbatim — including `olma_identity`, i.e. מירון's live credential,
// which is the whole auth mechanism for all 77 tools (domain/users.resolveByToken).
//
// Nothing in our code could have blocked it, and that was checked rather than
// assumed: a malformed call never reaches the tool dispatcher, the shim runs
// with cwd=/root and no agent context in its environment (measured from /proc),
// the gateway exposes no per-agent MCP server config and no outbound
// message hook (both confirmed against its published schema). So the token
// must live in the model's context, and a garbled generation can spill it.
// What is left, and what this file does, is NOTICE.
//
// The signal is narrow on purpose, and the narrowing is measured, not guessed.
// Over 14 days on the live box an identity token appears:
//
//   717x  assistant / toolCall    every authenticated call — ordinary operation
//    13x  toolResult / text       an agent reading .olma-identity — never delivered
//     1x  assistant / thinking    model reasoning — never delivered
//     1x  assistant / text        the leak, and nothing else
//
// Keying on that last shape gives one hit in fourteen days, and it is the
// incident. Keying on the token's mere presence would file a violation against
// a working system 730 times a fortnight — the cry-wolf failure this repo has
// now recorded four times.
const crypto = require('node:crypto');
const sessions = require('../channels/sessions');

// Global flag: `match` needs it to find every token in one block of text.
const TOKEN_RE = /olma_tok_[0-9a-f]{32}/g;

// How far back a scan looks. It bounds COST only, never truth: a finding is
// remembered (see reconcile) and stays reported after it ages out of the
// window, because a credential nobody rotated is still exposed. Measured at
// ~380ms / 10k events / 72MB across 19 agents, against a 600s sweep.
const WINDOW_DAYS = 14;

// Tokens are compared and stored by fingerprint, never in the clear — a
// detector for a leaked credential must not become a second place the
// credential is written down.
//
// The empty guard is load-bearing: sha256("") is a perfectly valid-looking
// digest, so hashing a missing token would make two absent values compare
// EQUAL and read as "still the same token". Absent is not a fingerprint.
function fingerprint(token) {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!t) return null;
  return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
}

// Every active user's CURRENT token, by id and by token value.
async function liveTokens(client) {
  const { rows } = await client.query(
    `SELECT id, agent_id, identity_token FROM users
      WHERE status = 'active' AND identity_token IS NOT NULL AND agent_id IS NOT NULL`);
  const byToken = new Map();
  const fpByUser = new Map();
  for (const u of rows) {
    const fp = fingerprint(u.identity_token);
    if (!fp) continue;
    byToken.set(u.identity_token, { id: Number(u.id), agentId: u.agent_id });
    fpByUser.set(Number(u.id), fp);
  }
  return { rows, byToken, fpByUser };
}

// Assistant text, across every active user's agent, carrying a token that is
// STILL a live credential. A token already rotated is not reported: the thing
// being detected is exposure, and a dead string exposes nothing.
//
// Every agent is scanned against every user's token rather than only its own,
// so a token that somehow surfaced in another agent's output is caught too —
// the cross-user case is the one that would matter most and the one a
// per-agent shortcut would miss.
async function scanForLeaks(client, { scan, now, windowDays } = {}) {
  const read = scan || sessions.scanAssistantTextSince;
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const since = nowMs - (windowDays || WINDOW_DAYS) * 86400000;
  const { rows, byToken } = await liveTokens(client);

  const found = [];
  for (const agentId of [...new Set(rows.map((u) => u.agent_id))]) {
    let events;
    // A store that cannot be opened returns null and a throwing read is
    // skipped: "could not read" is not "nothing was said". Manufacturing a
    // clean bill of health from an unreadable store is the failure mode this
    // whole area keeps relearning.
    try { events = read(agentId, since); } catch { continue; }
    if (!Array.isArray(events)) continue;

    for (const e of events) {
      const matches = String(e.text || '').match(TOKEN_RE);
      if (!matches) continue;
      for (const tok of new Set(matches)) {
        const owner = byToken.get(tok);
        if (!owner) continue;
        found.push({
          userId: owner.id,
          agentId,
          // Whether the agent that said it is the token's OWN agent. A token
          // spoken by somebody else's agent is a different, worse fact and
          // gets said differently — see violationFor.
          ownAgent: owner.agentId === agentId,
          sessionId: e.sessionId,
          at: e.at,
          fingerprint: fingerprint(tok),
        });
      }
    }
  }
  return found;
}

// The stored set, advanced by one scan.
//
// Findings are REMEMBERED rather than recomputed each tick, because the scan
// window bounds cost and would otherwise bound truth: a leak that scrolls past
// 14 days with the credential still live would drop out of the violations list
// and closeResolved would quietly close the issue — a detector reporting a fix
// that never happened.
//
// An entry leaves for exactly one reason: the user's token no longer matches
// the fingerprint that leaked, i.e. it was rotated and the exposure is over.
// That makes "the row cleared" mean something real — and it re-arms the alert,
// so a second leak later is announced instead of being swallowed by a stale flag.
function reconcile(stored, found, fpByUser) {
  const out = new Map();
  const keep = (e) => {
    if (!e || !e.fingerprint || !Number.isFinite(Number(e.userId))) return;
    const userId = Number(e.userId);
    // Still live? Only then is anything exposed.
    if (fpByUser.get(userId) !== e.fingerprint) return;
    // Keyed by the AGENT too, not just the user: one token spoken by two
    // different agents is two different exposures, and collapsing them would
    // hide the cross-user one behind whichever happened first.
    const key = `${userId}:${e.fingerprint}:${e.agentId}`;
    const prev = out.get(key);
    // Keep the EARLIEST sighting: that is when the credential became public.
    if (!prev || Number(e.at) < Number(prev.at)) {
      out.set(key, {
        userId, fingerprint: e.fingerprint, agentId: e.agentId,
        ownAgent: e.ownAgent !== false,
        at: Number(e.at) || (prev ? prev.at : 0),
        sessionId: e.sessionId,
      });
    }
  };
  for (const e of Array.isArray(stored) ? stored : []) keep(e);
  for (const e of Array.isArray(found) ? found : []) keep(e);
  return [...out.values()].sort((a, b) => a.userId - b.userId || a.at - b.at);
}

// One stable line per (user, token, agent). No count, no timestamp:
// fileViolations dedupes on the title, so anything that moves would file a
// brand-new issue every tick — checkStuckOutbox's lesson. The agent id is
// fixed at the earliest sighting and therefore does not move.
function violationFor(entry) {
  const head = `user ${entry.userId}: a live identity token was sent as message text`;
  return entry.ownAgent === false
    ? `${head} by agent ${entry.agentId}, which is NOT theirs — that agent can act as them, and the credential still works`
    : `${head} — the credential is exposed in a real chat and still works`;
}

module.exports = {
  scanForLeaks, reconcile, violationFor, fingerprint, liveTokens,
  TOKEN_RE, WINDOW_DAYS,
};
