#!/usr/bin/env node
// Register the food MCP server with the gateway (`mcp.servers.food`),
// or take it off again with --remove.
//
// The server is food/bin/food-mcp.js, deployed to /opt/olma-food by the
// food workflow. Registering it shows its tools to NOBODY: every agent
// carries `food__*` in its deny list (intake/agent-tool-policy.js, PACKS),
// and this script writes those denies in the SAME save as the server, so
// there is no moment in which the server is registered and an agent is not
// denied it. Whoever has the pack (user_packs) is shown the tools; nobody holds
// 'food' until the owner writes a row.
//
// Refuses when the shim is not on disk (a registered server whose command
// fails is a failed spawn on every turn of every agent), and validates the
// candidate with `openclaw config validate` first, like the policy sync — an
// invalid openclaw.json is ignored, not rejected.
//
// An `mcp` change is read at the next spawn of the server, so nothing
// restarts; confirm the reload line in the gateway journal all the same.
//
// A copy of register-games-mcp.js with the names changed.
//
// Usage: node scripts/register-food-mcp.js [--apply] [--remove]
'use strict';
const fs = require('node:fs');
const occ = require('../src/intake/openclaw-config');
const { agentToolPolicy, packsByAgent, PACKS } = require('../src/intake/agent-tool-policy');
const { validateCandidate } = require('../src/intake/validate-candidate');

const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');
const NAME = PACKS.food;
const SHIM = process.env.OLMA_FOOD_SHIM || '/opt/olma-food/bin/food-mcp.js';

(async () => {
  const cfg = occ.loadConfig();
  cfg.mcp = cfg.mcp || {};
  cfg.mcp.servers = cfg.mcp.servers || {};
  const before = JSON.stringify(cfg.mcp.servers[NAME] || null);

  if (REMOVE) {
    delete cfg.mcp.servers[NAME];
  } else {
    if (!fs.existsSync(SHIM)) {
      console.error(`NOT written: ${SHIM} does not exist — deploy food/ first`);
      process.exit(1);
    }
    cfg.mcp.servers[NAME] = { command: 'node', args: [SHIM] };
  }

  // Every agent's policy in the same write. The pack denies do not depend on
  // the server being registered, so --remove leaves them in place.
  let packs = new Map();
  let pool;
  try {
    pool = require('../src/db/pool').createPool();
    packs = await packsByAgent(pool);
  } catch (e) {
    console.error(`WARNING: user_packs unreadable (${e.message}) — the pack stays hidden from everyone`);
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
  const changed = [];
  for (const id of occ.listAgentIds(cfg)) {
    if (occ.setAgentTools(cfg, id, agentToolPolicy(id, cfg, { packs: packs.get(id) || [] }))) changed.push(id);
  }

  const after = JSON.stringify(cfg.mcp.servers[NAME] || null);
  console.log(`mcp.servers.${NAME}: ${before} -> ${after}`);
  console.log(`agent policies changed: ${changed.length ? changed.join(', ') : 'none'}`);
  console.log(`agents shown the pack: ${[...packs].filter(([, p]) => p.includes(NAME)).map(([a]) => a).join(', ') || 'nobody'}`);
  if (before === after && !changed.length) { console.log('nothing to write'); return; }
  if (!APPLY) { console.log('\ndry run — pass --apply to write'); return; }

  const v = validateCandidate(cfg);
  if (!v.valid) {
    console.error(`NOT written: the candidate config does not validate — ${v.why}`);
    process.exit(1);
  }
  occ.saveConfig(cfg);
  console.log('\nwritten. Confirm the gateway applied it, not just the file:');
  console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "-2min" | grep "\\[reload\\]"');
})().catch((e) => { console.error(e); process.exit(1); });
