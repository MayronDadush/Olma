#!/usr/bin/env node
'use strict';
// What actually happens between "the person typed something" and "a reply
// arrived", one turn at a time.
//
//   node scripts/turn-trace.js <target> [--turns 5] [--follow] [--since <ISO>]
//
// <target> is +E.164 or `id:<n>`. --follow polls and prints turns as they land.
//
// Built 2026-09-04 while walking the onboarding as a brand-new user: the DB
// says what was decided, but not the order things happened in or where the
// seconds went, and "he replied but didn't onboard me" is a question about the
// sequence, not about any single row.
//
// THE FOUR PLACES A TURN LEAVES A TRACE, and why it takes all four:
//
//   1. gateway sqlite `channel_ingress_events` — the message arriving on the
//      wire. The only place that knows when WhatsApp handed it over, which is
//      the only honest t=0. `payload_json` is nulled once the event completes,
//      so the TEXT is never here — do not go looking for it.
//   2. per-agent sqlite `transcript_events` — the conversation itself: user
//      text, model choice, every tool call and result, the reply, token usage.
//      This is the substance. It lives at agents/<agent_id>/agent/, NOT in the
//      gateway's state db.
//   3. gateway sqlite `audit_events` — agent.run.started/finished, so a turn
//      that died has an end even when the transcript stops mid-sentence.
//   4. Postgres `audit_log` + `outbox` — what Olma's own domain decided
//      (name observed, timezone set, task created) and anything queued to send
//      proactively. A tool call that "succeeded" at the gateway but wrote
//      nothing here did nothing.
//
// AGENT IDS ARE REUSED. `u-18` today is not `u-18` last week — deprovisioning
// frees the number and the next signup takes it. Every query here is bounded
// by the user's `created_at`, and dropping that bound silently mixes two
// different people's turns into one timeline. That mistake was made while
// writing this file.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPool } = require('../src/db/pool');

const HOME = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';
const STATE_DB = path.join(HOME, 'state', 'openclaw.sqlite');

// ----------------------------------------------------------------- reading

// Every read here is readOnly. This runs against a live gateway that is
// actively writing these files; opening them any other way risks blocking the
// thing we are trying to observe.
function openRO(file) {
  if (!fs.existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

function agentDbFor(agentId) {
  return openRO(path.join(HOME, 'agents', agentId, 'agent', 'openclaw-agent.sqlite'));
}

// The transcript is a flat event log; a turn is "one user message and
// everything the agent did before the next one".
function readTranscript(agentId, sinceMs) {
  const db = agentDbFor(agentId);
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT session_id, seq, event_json, created_at FROM transcript_events
       WHERE created_at >= ? ORDER BY created_at, seq`).all(sinceMs);
    return rows.map((r) => {
      let e = null;
      try { e = JSON.parse(r.event_json); } catch { /* a partially written row */ }
      return e && { at: r.created_at, sessionId: r.session_id, seq: r.seq, e };
    }).filter(Boolean);
  } finally { db.close(); }
}

function readGateway(agentId, sinceMs) {
  const db = openRO(STATE_DB);
  if (!db) return { runs: [], ingress: [] };
  try {
    const runs = db.prepare(
      `SELECT occurred_at, kind, action, status, tool_name, error_code, duration_ms
       FROM audit_events WHERE agent_id = ? AND occurred_at >= ? ORDER BY occurred_at`)
      .all(agentId, sinceMs);
    const ingress = db.prepare(
      `SELECT received_at, completed_at, status, lane_key, attempts, last_error, failed_reason
       FROM channel_ingress_events WHERE received_at >= ? ORDER BY received_at`).all(sinceMs);
    return { runs, ingress };
  } finally { db.close(); }
}

async function readOlma(pool, userId, sinceMs) {
  const since = new Date(sinceMs).toISOString();
  const audit = (await pool.query(
    `SELECT created_at, event, detail FROM audit_log
     WHERE actor_id = $1 AND created_at >= $2 ORDER BY created_at`, [userId, since])).rows;
  const outbox = (await pool.query(
    `SELECT id, kind, created_at, sent_at, hold_reason, attempts FROM outbox
     WHERE user_id = $1 AND created_at >= $2 ORDER BY id`, [userId, since])).rows;
  return { audit, outbox };
}

// ------------------------------------------------------------------ shaping

// Split the transcript into turns on each inbound user message.
function intoTurns(events) {
  const turns = [];
  for (const ev of events) {
    const m = ev.e;
    const isUser = m.type === 'message' && m.message && m.message.role === 'user';
    if (isUser || !turns.length) turns.push({ start: ev.at, events: [] });
    turns[turns.length - 1].events.push(ev);
  }
  return turns;
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// One transcript event -> one printable line, or null for the bookkeeping
// events nobody needs to see (cache ttl markers, parent-id plumbing).
function describe(ev) {
  const m = ev.e;
  if (m.type === 'session') return { lane: 'agent', what: 'session opened', extra: String(m.id).slice(0, 8) };
  if (m.type === 'thinking_level_change') return null;
  if (m.type === 'custom' && m.customType === 'model-snapshot') {
    const d = m.data || {};
    return { lane: 'model', what: d.modelId || '?', extra: d.provider || '' };
  }
  if (m.type !== 'message' || !m.message) return null;
  const msg = m.message;

  if (msg.role === 'user') {
    const oc = msg.__openclaw || {};
    return { lane: 'inbound', what: `"${clip(msg.content, 60)}"`,
             extra: oc.senderName ? `from ${oc.senderName}` : '' };
  }
  if (msg.role === 'toolResult') {
    const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    return { lane: 'tool  <-', what: msg.toolName || '?', extra: clip(text, 70), error: msg.isError };
  }
  if (msg.role === 'assistant') {
    const calls = (msg.content || []).filter((c) => c.type === 'toolCall');
    if (calls.length) {
      return calls.map((c) => ({
        lane: 'tool  ->', what: c.name,
        extra: clip(JSON.stringify(redact(c.arguments || {})), 70),
      }));
    }
    const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
    const u = msg.usage || {};
    return { lane: 'reply', what: `"${clip(text, 60)}"`,
             extra: u.input != null ? `in ${u.input} / out ${u.output} / cached ${u.cacheRead || 0}` : '' };
  }
  return null;
}

// The identity token is the root of trust and appears in every single tool
// call. It must never be the thing that leaks because somebody pasted a trace
// into a chat window.
function redact(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = /identity|token|secret/i.test(k) ? '<redacted>' : v;
  }
  return out;
}

// ------------------------------------------------------------------- render

function renderTurn(turn, n, ctx) {
  const t0 = turn.start;
  const rows = [];
  const push = (at, lane, what, extra, flag) =>
    rows.push({ off: (at - t0) / 1000, lane, what, extra: extra || '', flag });

  // The wire event that opened this turn, if we can find one near it. Matching
  // on time rather than on an id because ingress rows carry a lane key, not an
  // agent — close enough for one user, and honest about being a heuristic.
  const wire = ctx.ingress.find((i) => Math.abs(i.received_at - t0) < 3000);
  if (wire) push(wire.received_at, 'channel', `inbound ${wire.status}`,
    `lane ${clip(wire.lane_key, 28)}${wire.attempts ? ` att=${wire.attempts}` : ''}`);

  for (const ev of turn.events) {
    const d = describe(ev);
    if (!d) continue;
    for (const one of [].concat(d)) push(ev.at, one.lane, one.what, one.extra, one.error ? 'ERR' : null);
  }

  const end = turn.events[turn.events.length - 1].at;
  for (const a of ctx.olma) {
    const at = a.created_at.getTime();
    if (at < t0 - 500 || at > end + 4000) continue;
    push(at, 'olma', a.event, clip(JSON.stringify(a.detail || {}), 70));
  }
  for (const r of ctx.runs) {
    if (r.occurred_at < t0 || r.occurred_at > end + 6000) continue;
    if (r.action === 'agent.run.finished') {
      push(r.occurred_at, 'agent', `run ${r.status}`, r.error_code || '',
        r.status === 'succeeded' ? null : 'ERR');
    }
  }
  for (const o of ctx.outbox) {
    const at = o.created_at.getTime();
    if (at < t0 || at > end + 6000) continue;
    push(at, 'outbox', `${o.kind} queued`,
      o.sent_at ? 'sent' : `pending${o.hold_reason ? ` (${o.hold_reason})` : ''}`);
  }

  rows.sort((a, b) => a.off - b.off);

  const head = turn.events.find((e) => e.e.message && e.e.message.role === 'user');
  const said = head ? clip(head.e.message.content, 50) : '(no user message)';
  const total = rows.length ? rows[rows.length - 1].off : 0;
  const tools = rows.filter((r) => r.lane === 'tool  ->').length;

  const out = [];
  out.push(`\n┌─ TURN ${n}  ${new Date(t0).toISOString().slice(11, 19)}Z  "${said}"`);
  for (const r of rows) {
    const off = `+${r.off.toFixed(2)}s`.padStart(8);
    out.push(`│ ${off}  ${r.lane.padEnd(9)} ${r.what.padEnd(34)} ${r.extra}${r.flag ? `  [${r.flag}]` : ''}`);
  }
  out.push(`└─ ${total.toFixed(1)}s total · ${tools} tool call${tools === 1 ? '' : 's'} · `
    + `${rows.filter((r) => r.lane === 'outbox').length} outbox row(s)`);
  return out.join('\n');
}

// --------------------------------------------------------------------- main

async function collect(pool, user, sinceMs) {
  const events = readTranscript(user.agent_id, sinceMs);
  const { runs, ingress } = readGateway(user.agent_id, sinceMs);
  const { audit, outbox } = await readOlma(pool, user.id, sinceMs);
  return { turns: intoTurns(events), ctx: { runs, ingress, olma: audit, outbox } };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const valueOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const follow = args.includes('--follow');
  const wantTurns = Number(valueOf('--turns') || 5);

  const pool = createPool();
  try {
    const where = /^id:\d+$/.test(target || '') ? 'id = $1' : 'phone = $1';
    const key = /^id:\d+$/.test(target || '') ? Number(target.slice(3)) : target;
    const { rows } = await pool.query(
      `SELECT id, phone, first_name, agent_id, created_at FROM users WHERE ${where}`, [key]);
    const user = rows[0];
    if (!user) { console.error(`no user matching ${target}`); process.exitCode = 1; return; }

    // Never look further back than this user has existed: the agent id was
    // very likely somebody else's before them.
    const floor = user.created_at.getTime();
    const sinceMs = valueOf('--since') ? Math.max(floor, Date.parse(valueOf('--since'))) : floor;

    console.log(`user ${user.id} (${user.first_name || 'no name yet'}) agent ${user.agent_id}, `
      + `created ${user.created_at.toISOString()}`);
    console.log(`reading from ${new Date(sinceMs).toISOString()}`
      + `${follow ? ' — following, ctrl-c to stop' : ''}`);

    let shown = 0;
    const render = ({ turns, ctx }) => {
      const fresh = turns.slice(shown);
      const start = follow ? 0 : Math.max(0, fresh.length - wantTurns);
      for (let i = start; i < fresh.length; i++) {
        console.log(renderTurn(fresh[i], shown + i + 1, ctx));
      }
      shown = turns.length;
    };

    render(await collect(pool, user, sinceMs));
    if (!follow) return;

    // 3s is comfortably below a person's typing-and-waiting rhythm and these
    // are all indexed reads on a 14MB sqlite — but this box has one vCPU and
    // every cycle spent here is a cycle not spent answering somebody, so it
    // stays a plain interval and never grows into a busy loop.
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      render(await collect(pool, user, sinceMs));
    }
  } finally { await pool.end(); }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { intoTurns, describe, redact };
