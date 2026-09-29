#!/usr/bin/env node
// Bring every agent to the tool policy the registry and the packs say it
// should have (`agents.entries.<id>.tools.deny`, intake/agent-tool-policy.js).
//
// deploy.sh runs this with --apply after every release, which is what keeps a
// NEW tool from reaching the wrong audience: provisioning writes the policy
// for a new agent, but only this touches the agents that already exist.
// config_guard reports any agent that still differs.
//
// Validated before it is written. An invalid openclaw.json is not rejected,
// it is ignored — the gateway skips EVERY reload, silently, and a joiner's
// agent never goes live (docs/model-experiments.md, "The finding that outlived
// the experiment"). So the candidate is written to a scratch OPENCLAW_HOME and
// run through `openclaw config validate --json` first; anything but
// `valid: true` writes nothing and exits non-zero.
//
// An agents-only change hot-reloads and restarts no channel.
//
// Usage: node scripts/sync-agent-tool-policies.js [--apply]
'use strict';
const occ = require('../src/intake/openclaw-config');
const { agentToolPolicy, packsByAgent } = require('../src/intake/agent-tool-policy');
const { validateCandidate: validate } = require('../src/intake/validate-candidate');

const APPLY = process.argv.includes('--apply');

// Who has turned a pack on (user_packs). Unreadable is read as NOBODY: the
// direction that fails is hiding a pack from somebody who had it until the
// next deploy, never showing one to somebody who did not.
async function readPacks() {
  let pool;
  try {
    const { createPool } = require('../src/db/pool');
    pool = createPool();
    return await packsByAgent(pool);
  } catch (e) {
    console.error(`WARNING: user_packs unreadable (${e.message}) — every pack stays hidden from everyone`);
    return new Map();
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

(async () => {
  const packs = await readPacks();
  const cfg = occ.loadConfig();
  const changed = [];
  // Every agent, not only people and rooms: main, intake and ggreet carry the
  // pack denies too (intake/agent-tool-policy.js, PACKS).
  for (const id of occ.listAgentIds(cfg)) {
    const policy = agentToolPolicy(id, cfg, { packs: packs.get(id) || [] });
    if (occ.setAgentTools(cfg, id, policy)) changed.push(`${id}: deny ${policy ? policy.deny.length : 0}`);
  }

  console.log(changed.length ? `would change ${changed.length} agent(s):\n  ${changed.join('\n  ')}` : 'every agent already matches — nothing to write');
  if (!APPLY || !changed.length) {
    if (!APPLY && changed.length) console.log('\ndry run — pass --apply to write');
    process.exit(0);
  }

  const v = validate(cfg);
  if (!v.valid) {
    console.error(`NOT written: the candidate config does not validate — ${v.why}`);
    process.exit(1);
  }
  occ.saveConfig(cfg);
  console.log(`\nwritten (${changed.length} agent(s)). Confirm the gateway applied it, not just the file:`);
  console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "-2min" | grep "\\[reload\\]"');
  console.log('A "reload skipped (invalid config)" line means NOTHING was applied — every later reload is dead too.');
})().catch((e) => { console.error(e); process.exit(1); });
