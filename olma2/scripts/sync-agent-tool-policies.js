#!/usr/bin/env node
// Bring every person's and room's agent to the tool policy the registry says
// it should have (`agents.entries.<id>.tools.deny`, intake/agent-tool-policy.js).
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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const occ = require('../src/intake/openclaw-config');
const { agentToolPolicy, agentKind } = require('../src/intake/agent-tool-policy');

const APPLY = process.argv.includes('--apply');

function validate(cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-toolpolicy-'));
  try {
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
    let out;
    try {
      out = execFileSync('openclaw', ['config', 'validate', '--json'], {
        env: { ...process.env, OPENCLAW_HOME: home }, encoding: 'utf8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      out = e && e.stdout ? String(e.stdout) : '';
      if (!out) return { valid: false, why: `openclaw config validate could not run: ${e.message}` };
    }
    const j = JSON.parse(out);
    return { valid: j.valid === true, why: JSON.stringify(j.errors || j.issues || []).slice(0, 500) };
  } catch (e) {
    return { valid: false, why: `validation unreadable: ${e.message}` };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const cfg = occ.loadConfig();
const changed = [];
for (const id of occ.listAgentIds(cfg)) {
  if (!agentKind(id)) continue;
  const policy = agentToolPolicy(id, cfg);
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
