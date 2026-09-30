'use strict';
// Turning a pack on for one person, from a message they sent (stage 4א of game
// nights, 2026-09-30). Until now only the owner could, by hand: a `user_packs`
// row and then `scripts/sync-agent-tool-policies.js --apply`. This is the same
// two steps for one agent, from brokerd, when somebody writes "ערב משחק חדש"
// or sends a night's join code.
//
// The row is the permission (gamesd asks `identity_resolve`, which reads it);
// the deny list is only what the model is SHOWN. So the row goes first and a
// failed config write costs the person nothing but the tools arriving a deploy
// later — the deploy's sync writes the same list, and config_guard names any
// agent whose list differs.
//
// The write is `tools.deny` on one agent entry, the shape the sync script has
// written on every deploy since migration 100, and like every other write
// brokerd makes to this file (jobs/groups.js, jobs/boost.js) it is load, set,
// save with nothing awaited in between, so no other write in this process can
// land inside it. An agents-only change hot-reloads and restarts no channel.
const occ = require('../intake/openclaw-config');
const { agentToolPolicy } = require('../intake/agent-tool-policy');

const VIAS = new Set(['owner', 'phrase', 'code']);

// → { enabled: true } when this call wrote the row, { enabled: false } when
// they already had it. `packs` is the whole list after, for the policy.
async function enable(client, userId, pack, via) {
  if (!VIAS.has(via)) throw new Error(`unknown via: ${via}`);
  const { rowCount } = await client.query(
    `INSERT INTO user_packs (user_id, pack, via) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pack) DO NOTHING`, [userId, pack, via]);
  const { rows } = await client.query(
    'SELECT pack FROM user_packs WHERE user_id = $1 ORDER BY pack', [userId]);
  return { enabled: rowCount > 0, packs: rows.map((r) => r.pack) };
}

// → { changed } — false when the agent already had this list, or has no entry
// (a roster the sync will reach on the next deploy). Throws on an unreadable
// or unwritable file; the caller reports it and carries on.
function applyPolicy(agentId, packs, { configPath } = {}) {
  const cfg = occ.loadConfig(configPath);
  const policy = agentToolPolicy(agentId, cfg, { packs });
  if (!occ.setAgentTools(cfg, agentId, policy)) return { changed: false };
  occ.saveConfig(cfg, configPath);
  return { changed: true };
}

module.exports = { enable, applyPolicy };
