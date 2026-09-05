'use strict';
// Per-user cost attribution, read from the gateway's TRANSCRIPTS.
//
// It used to read sessions.json's `totalTokens` and accumulate deltas, on the
// belief that the field was a cumulative counter. Migration 010 has the full
// autopsy; the short version is that it is a context-size gauge, that
// `estimatedCostUsd` is derived from it, that each call's own cost block comes
// back all-zero, and that rotated sessions vanish from the index entirely —
// so a day Anthropic billed at $4.57 landed in our ledger as cents.
//
// Transcripts are append-only and every assistant message carries a real
// usage block. Reading them from a stored byte offset gives an honest
// high-water mark: the offset only moves forward, so a re-run charges nothing
// twice, and nothing is lost when a session rotates because the FILE is still
// there even after the index forgets it.
// The worker-thread facade: a cold run of this sweep walks every transcript
// on disk, and the yield-per-file below was the first patch for the main
// thread going deaf during it (2026-08-25). The reads now happen off the
// loop entirely; the yield stays as the cheap second guard.
const sessions = require('../channels/sessions-async');
const pricing = require('../domain/model-pricing');

// Which calendar day a call belongs to. Anthropic's own Cost page is in UTC
// and reconciling against it is the point, so this deliberately does not use
// the user's timezone the way user-facing dates do.
function utcDate(at) {
  const d = at ? new Date(at) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

async function sweepUsage(client, deps = {}) {
  const listTranscripts = deps.listTranscripts || (() => sessions.listTranscripts());
  const readUsage = deps.readTranscriptUsage || sessions.readTranscriptUsage;
  const blended = await pricing.blendedRate(client);

  // agent_id -> user_id, resolved once. An agent with no user row (main,
  // intake) is real spend with nobody to bill it to, and goes to the system
  // ledger rather than being dropped the way it used to be.
  const { rows: userRows } = await client.query(
    `SELECT id, agent_id FROM users WHERE agent_id IS NOT NULL`);
  const userByAgent = new Map(userRows.map((r) => [r.agent_id, Number(r.id)]));

  // Accumulate in memory first, then write one row per bucket: a busy
  // transcript holds hundreds of calls that all land on the same
  // (owner, date, model) key, and that should be one UPDATE, not hundreds.
  const buckets = new Map();
  let calls = 0, filesRead = 0;

  for (const t of await listTranscripts()) {
    const prev = (await client.query(
      `SELECT byte_offset FROM usage_session_snapshots WHERE session_id = $1`, [t.sessionId]
    )).rows[0];
    const fromOffset = prev ? Number(prev.byte_offset) : 0;
    if (t.size === fromOffset) continue; // nothing appended since last sweep

    // readUsage is a synchronous read + a JSON.parse per line, and this loop
    // walks EVERY transcript on disk on a cold run — on the 1-vCPU box that
    // blocked brokerd's event loop for the better part of a minute. Observed
    // live 2026-08-25: the post-deploy startup kick ran this exactly when a
    // user's message arrived, and his turn_start timed out twice (30s each)
    // against a brokerd that was healthy but deaf. One yield per file caps
    // the contiguous block at the largest single transcript (~1-3s), which a
    // 30s socket timeout never notices.
    await new Promise((resolve) => setImmediate(resolve));
    const { calls: newCalls, offset } = await readUsage(t.file, fromOffset);
    await client.query(
      `INSERT INTO usage_session_snapshots (session_id, agent_id, model, byte_offset, transcript_path, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (session_id) DO UPDATE SET
         byte_offset = $4, agent_id = $2, model = $3, transcript_path = $5, updated_at = now()`,
      [t.sessionId, t.agentId, newCalls.length ? newCalls[newCalls.length - 1].model : '', offset, t.file]
    );
    if (!newCalls.length) continue;
    filesRead++;

    const userId = userByAgent.get(t.agentId) ?? null;
    for (const c of newCalls) {
      const priced = pricing.priceUsage(c, c.model, blended);
      const key = `${userId ?? 'agent:' + t.agentId}|${utcDate(c.at)}|${priced.model}`;
      const b = buckets.get(key) || {
        userId, agentId: t.agentId, date: utcDate(c.at), model: priced.model,
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, estimated: false,
      };
      b.input += c.input; b.output += c.output;
      b.cacheRead += c.cacheRead; b.cacheWrite += c.cacheWrite;
      b.cost += priced.cost;
      b.estimated = b.estimated || priced.estimated;
      buckets.set(key, b);
      calls++;
    }
  }

  let recorded = 0;
  for (const b of buckets.values()) {
    const total = b.input + b.output + b.cacheRead + b.cacheWrite;
    if (b.userId != null) {
      await client.query(
        `INSERT INTO usage_ledger
           (user_id, date, model, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, total_tokens, cost_usd, estimated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id, date, model) DO UPDATE SET
           input_tokens = usage_ledger.input_tokens + $4,
           output_tokens = usage_ledger.output_tokens + $5,
           cache_read_tokens = usage_ledger.cache_read_tokens + $6,
           cache_write_tokens = usage_ledger.cache_write_tokens + $7,
           total_tokens = usage_ledger.total_tokens + $8,
           cost_usd = usage_ledger.cost_usd + $9,
           estimated = usage_ledger.estimated OR $10`,
        [b.userId, b.date, b.model, b.input, b.output, b.cacheRead, b.cacheWrite,
         total, b.cost.toFixed(4), b.estimated]
      );
    } else {
      await client.query(
        `INSERT INTO usage_system_ledger
           (agent_id, date, model, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, cost_usd, estimated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (agent_id, date, model) DO UPDATE SET
           input_tokens = usage_system_ledger.input_tokens + $4,
           output_tokens = usage_system_ledger.output_tokens + $5,
           cache_read_tokens = usage_system_ledger.cache_read_tokens + $6,
           cache_write_tokens = usage_system_ledger.cache_write_tokens + $7,
           cost_usd = usage_system_ledger.cost_usd + $8,
           estimated = usage_system_ledger.estimated OR $9`,
        [b.agentId, b.date, b.model, b.input, b.output, b.cacheRead, b.cacheWrite,
         b.cost.toFixed(4), b.estimated]
      );
    }
    recorded++;
  }
  return { filesRead, calls, recorded };
}

module.exports = { sweepUsage };
