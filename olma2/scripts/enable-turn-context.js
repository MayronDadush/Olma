#!/usr/bin/env node
// Phase B for everybody: the turn's opening rides the prompt, and the model
// never spends a call on `turn_start`.
//
// Measured over fourteen days to 2026-09-09: 922 of 2,482 tool calls were
// `turn_start` — one of the 2.9 model calls behind every message, a full
// round-trip (3–7 s on the box) whose answer brokerd already knew before
// the model asked. The plugin (gateway-plugin/olma-turn) has prepended that
// answer to the prompt for u-3 and u-12 since 2026-09-06; this turns it on
// for every `u-N` agent, in the two places CLAUDE.md says have to agree:
//
//   1. the `turn_context_phones` flag = "all" — what brokerd answers, and
//      what resync-agent-templates.js reads to pick the doctrine variant;
//   2. the plugin's `config.agents` EMPTY — the plugin serves every `u-N`
//      agent, so a person who joins next week is covered without anyone
//      remembering, and the flag stays the only gate.
//
// Then, by hand (the plugin reads its list once, at register):
//   XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
//   node scripts/resync-agent-templates.js --apply
//
// The evals were step one (2026-09-06): the harness opens each turn through
// brokerd itself and its opening check follows the flag, so the suite keeps
// measuring the path real people are on. Half of this — flag without
// plugin, plugin without doctrine — is the OLD behaviour, not a broken one
// (the doctrine variant falls back to `turn_start` when no Turn context
// block is there); jobs/config-guard.js goes red on the halves anyway,
// because a fallback nobody notices is a tool call on every message for
// ever. Proof is `/opt/olma2/run/turn-context-plugin.log` saying
// `prepended` for an agent that was not on the old list, never the file.
//
// Usage: node scripts/enable-turn-context.js [--apply] [--reset]
//   --reset puts the flag back to '' and leaves the plugin list as it is
'use strict';
const occ = require('../src/intake/openclaw-config');
const { createPool, withTx } = require('../src/db/pool');
const flags = require('../src/domain/flags');
const turn = require('../src/domain/turn');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const PLUGIN = 'olma-turn';

(async () => {
  const cfg = occ.loadConfig();
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  const entry = cfg.plugins.entries[PLUGIN];
  if (!entry || entry.enabled !== true) {
    console.error(`plugins.entries.${PLUGIN} is ${entry ? 'disabled' : 'missing'} — install and enable the plugin first (CLAUDE.md, Phase B)`);
    process.exit(1);
  }
  entry.config = entry.config || {};
  const listBefore = JSON.stringify(entry.config.agents || null);
  if (!RESET) entry.config.agents = [];

  const pool = createPool();
  try {
    const before = await withTx(pool, (c) => flags.getFlag(c, turn.CONTEXT_FLAG));
    const after = RESET ? '' : 'all';
    console.log(`${turn.CONTEXT_FLAG}:`, JSON.stringify(before), '->', JSON.stringify(after));
    console.log(`plugins.entries.${PLUGIN}.config.agents:`, listBefore, '->', RESET ? listBefore : '[] (every u-N agent)');
    if (!APPLY) { console.log('\ndry run — pass --apply to write'); return; }
    await withTx(pool, (c) => flags.setFlag(c, turn.CONTEXT_FLAG, after));
    if (!RESET) occ.saveConfig(cfg);
    console.log('\nwritten. The plugin reads its list once, at register — restart the gateway, then resync the doctrine:');
    console.log('  XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway');
    console.log('  node scripts/resync-agent-templates.js --apply');
    console.log('then watch /opt/olma2/run/turn-context-plugin.log for "prepended" on an agent that was not on the old list.');
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
