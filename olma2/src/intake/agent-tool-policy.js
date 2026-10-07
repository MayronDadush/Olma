'use strict';
// Which of OUR tools each gateway agent is shown — written into its entry as
// `agents.entries.<id>.tools.deny`, and derived from the registry every time.
//
// The shim serves the whole list because it cannot tell who is asking (see
// adapters/mcp/registry.js), and brokerd refuses a token on the wrong
// audience's tool, so this was never about access. It is about what the model
// READS. A room's agent was handed all 90 schemas on every turn and can use
// six of them. Measured on the live g-7 agent, 2026-09-23, one probe turn
// before and after, the prompt otherwise identical:
//
//   input tokens   27,337 -> 11,625
//   our tools          90 -> 6
//   turn time       16.0s -> 4.5s   (one probe each; indicative only)
//
// A person's agent loses the six room tools the same way, a much smaller cut.
//
// DENY, never ALLOW. An agent-level allow list restricts the gateway's own
// tools too (read, write, edit), and deny wins in the gateway's matcher
// whatever else is configured, which is the direction a mistake here should
// fail in. The global `tools.deny` has run in production this way since
// before v2.
//
// The one real risk is a stale list — a person's tool added after the list
// was written would leak into every room. So nothing here is a constant: the
// list is computed from `toolDefinitions` at provisioning, the deploy
// re-applies it to every agent (scripts/sync-agent-tool-policies.js), and
// config_guard goes red on any agent whose list differs from this function.

// The gateway names an MCP tool `<server>__<tool>`
// (agent-bundle-mcp-names: buildSafeToolName).
const SEP = '__';

// `u-<id>` is a person's agent, `g-<id>` a room's. Everything else — main,
// intake, the room greeter `ggreet` — keeps every tool of OURS and is denied
// only the packs (below).
function agentKind(agentId) {
  if (/^u-\d+$/.test(String(agentId))) return 'user';
  if (/^g-\d+$/.test(String(agentId))) return 'group';
  return null;
}

// The name our server is registered under in `mcp.servers`. One entry is what
// the box has; with several, the one running olma-mcp.js. Unknown -> null,
// and a null writes nothing: a deny list under the wrong prefix would hide
// nothing and look like it worked.
function serverName(cfg) {
  const servers = (cfg && cfg.mcp && cfg.mcp.servers) || {};
  // A pack's server is never ours, so it never counts toward "one entry".
  const packServers = new Set(Object.values(PACKS));
  const names = Object.keys(servers).filter((n) => !packServers.has(n));
  if (names.length === 1) return names[0];
  const ours = names.find((n) => JSON.stringify(servers[n] || {}).includes('olma-mcp.js'));
  return ours || null;
}

// Tools that belong to a PACK — a whole MCP server a person turns on, not a
// tool of ours with an audience. Game nights is the first: its server is
// registered as `games` (scripts/register-games-mcp.js), and every agent on
// the roster is denied all of it — main, intake and ggreet included — until
// its person has the pack (`user_packs`, migration 100). A glob, so a tool
// added to the games server later is hidden the day it ships, with no re-sync.
//
// Written whether or not the server is registered yet: a deny on a name
// nothing serves hides nothing and costs nothing, and it means that on the day
// the server IS registered every agent already carries it. The other order
// would show the game tools to everybody for as long as the sync took.
//
// Food tracking is the second (food/, scripts/register-food-mcp.js): the same
// shape, its own server name, its own `user_packs` value (migration 114).
const PACKS = { games: 'games', food: 'food' };
const packDeny = (packs) => Object.keys(PACKS)
  .filter((p) => !(packs || []).includes(p))
  .map((p) => `${PACKS[p]}${SEP}*`);

// `{ deny: [...] }`, sorted so an unchanged policy compares equal, or null
// when this agent is not narrowed at all. `packs` are the ones its person has
// turned on; only a person's agent can hold one, so a room, the greeters and
// main are denied every pack whatever they are handed.
function agentToolPolicy(agentId, cfg, { packs = [] } = {}) {
  const kind = agentKind(agentId);
  const deny = packDeny(kind === 'user' ? packs : []);
  const server = kind ? serverName(cfg) : null;
  if (server) {
    // Required here, not at the top: the registry pulls in every tool module,
    // and provisioning should not pay for that until it writes an agent.
    const { TOOLS, audienceOf } = require('../adapters/mcp/registry');
    for (const t of TOOLS) if (audienceOf(t) !== kind) deny.push(`${server}${SEP}${t.name}`);
  }
  return deny.length ? { deny: deny.sort() } : null;
}

// agent id -> the packs its person has turned on, read once for a roster.
// The sync, the guard and provisioning all pass it, so they agree about who
// is shown a pack.
async function packsByAgent(client) {
  const { rows } = await client.query(
    `SELECT u.agent_id, array_agg(p.pack ORDER BY p.pack) AS packs
       FROM user_packs p JOIN users u ON u.id = p.user_id
      WHERE u.agent_id IS NOT NULL
      GROUP BY u.agent_id`);
  return new Map(rows.map((r) => [r.agent_id, r.packs]));
}

// Does this entry carry exactly the policy it should? The guard's question.
function policyMatches(entry, expected) {
  const have = entry && entry.tools && Array.isArray(entry.tools.deny) ? [...entry.tools.deny].sort() : null;
  if (!expected) return !have;
  return JSON.stringify(have) === JSON.stringify(expected.deny);
}

module.exports = { agentKind, serverName, agentToolPolicy, policyMatches, packsByAgent, PACKS, SEP };
