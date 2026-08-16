'use strict';
// Per-user cost attribution from OpenClaw's own session usage counters.
// Sessions report CUMULATIVE totals; we keep a snapshot per session and add
// only positive deltas (a vanished/reset session simply re-baselines).
//
// Cost prefers the gateway's own per-session estimate, which knows the actual
// per-model input/output/cache rates. The blended cost_per_mtok_usd flag is
// the fallback for sessions that don't report one.
const flags = require('../domain/flags');
const sessions = require('../channels/sessions');

// Reads the on-disk session index (no process spawn). Throws if it is
// unreadable, so the usage_sweep heartbeat goes red instead of silently
// recording zero cost forever.
function defaultListAllSessions() {
  return sessions.listSessions();
}

async function sweepUsage(client, { listSessions } = {}) {
  const sessions = await (listSessions || defaultListAllSessions)();
  const costPerMtok = Number(await flags.getFlag(client, 'cost_per_mtok_usd') ?? 1.5);
  let recorded = 0;

  for (const s of sessions) {
    const agentId = s.agentId || '';
    const total = Number(s.totalTokens || 0);
    if (!s.sessionId || !agentId.startsWith('u-') || !(total > 0)) continue;

    const prev = (await client.query(
      `SELECT total_tokens FROM usage_session_snapshots WHERE session_id = $1`, [s.sessionId]
    )).rows[0];
    const prevTotal = prev ? Number(prev.total_tokens) : 0;
    const delta = total - prevTotal;
    // Attribute the same fraction of the session's reported cost as the token
    // delta represents — the counters are cumulative, so the delta is the only
    // part that is new since the last sweep.
    const reported = s.estimatedCostUsd;

    await client.query(
      `INSERT INTO usage_session_snapshots (session_id, agent_id, model, total_tokens, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (session_id) DO UPDATE SET total_tokens = $4, model = $3, updated_at = now()`,
      [s.sessionId, agentId, s.model || '', total]
    );
    if (delta <= 0) continue; // new baseline or no growth — nothing to attribute

    const { rows: userRows } = await client.query(`SELECT id FROM users WHERE agent_id = $1`, [agentId]);
    if (!userRows[0]) continue;
    const cost = reported != null && reported > 0 && total > 0
      ? reported * (delta / total)
      : (delta / 1e6) * costPerMtok;
    await client.query(
      `INSERT INTO usage_ledger (user_id, date, model, total_tokens, cost_usd)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       ON CONFLICT (user_id, date, model)
       DO UPDATE SET total_tokens = usage_ledger.total_tokens + $3,
                     cost_usd = usage_ledger.cost_usd + $4`,
      [userRows[0].id, s.model || '', delta, cost.toFixed(4)]
    );
    recorded++;
  }
  return { sessions: sessions.length, recorded };
}

module.exports = { sweepUsage, defaultListAllSessions };
