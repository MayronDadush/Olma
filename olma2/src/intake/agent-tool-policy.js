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
// intake, the room greeter `ggreet` — is not ours to narrow.
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
  const names = Object.keys(servers);
  if (names.length === 1) return names[0];
  const ours = names.find((n) => JSON.stringify(servers[n] || {}).includes('olma-mcp.js'));
  return ours || null;
}

// `{ deny: [...] }`, sorted so an unchanged policy compares equal, or null
// when this agent is not narrowed at all.
function agentToolPolicy(agentId, cfg) {
  const kind = agentKind(agentId);
  if (!kind) return null;
  const server = serverName(cfg);
  if (!server) return null;
  // Required here, not at the top: the registry pulls in every tool module,
  // and provisioning should not pay for that until it writes an agent.
  const { TOOLS, audienceOf } = require('../adapters/mcp/registry');
  const deny = TOOLS
    .filter((t) => audienceOf(t) !== kind)
    .map((t) => `${server}${SEP}${t.name}`)
    .sort();
  return { deny };
}

// Does this entry carry exactly the policy it should? The guard's question.
function policyMatches(entry, expected) {
  const have = entry && entry.tools && Array.isArray(entry.tools.deny) ? [...entry.tools.deny].sort() : null;
  if (!expected) return !have;
  return JSON.stringify(have) === JSON.stringify(expected.deny);
}

module.exports = { agentKind, serverName, agentToolPolicy, policyMatches, SEP };
