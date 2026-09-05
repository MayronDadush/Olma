#!/usr/bin/env node
// Turn the gateway's recurring heartbeat off for every agent.
//
// What a heartbeat is here: every 30 minutes (the gateway default) the
// scheduler wakes each agent on the roster with the prompt
// "[OpenClaw heartbeat poll]" and runs a full model turn. Our doctrine's
// only instruction for that turn is to answer NO_REPLY, and
// `heartbeat.target: "none"` — which is what the config carried — only
// suppresses DELIVERY of that answer; the turn still runs, and it still costs.
//
// Measured on 2026-09-05 by walking seven days of every agent's transcript
// store: 4,944 heartbeat runs, 3,051 model calls (~33k tokens each),
// $7.15 — against 1,072 calls and $1.57 for every real message from every
// real person. Heartbeats were 82% of the bill, for turns that by design
// produce nothing. This is also the road one agent's brunch reminder took into
// a DIFFERENT user's chat (agents-template.md, "A heartbeat poll is not a
// conversation"): a turn that never runs cannot leak.
//
// Nothing of ours rides on it. Reminders, check-ins, digests, the fact
// extraction, the credit alarm — every one is a brokerd job with its own
// heartbeat row in job_heartbeats (a different thing with the same name),
// delivered through the raw pipe or --deliver. The gateway's docs are explicit
// that "0m" disables only the recurring cadence; targeted event-driven wakes
// (a background exec finishing) still work.
//
// The guard rule in jobs/config-guard.js (checkOpenclawConfig) turns red when
// this is not "0m", so a gateway upgrade that resets it shows on the board.
//
// Usage: node scripts/disable-heartbeats.js [--apply] [--reset]
//   --reset puts the 30m default back (deletes `every`, keeps target: none)
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
const hb = cfg.agents.defaults.heartbeat || {};
const before = hb.every === undefined ? '(unset — gateway default 30m)' : hb.every;

if (RESET) {
  delete hb.every;
  cfg.agents.defaults.heartbeat = { ...hb, target: hb.target || 'none' };
  console.log('heartbeat.every:', before, '-> (unset — 30m)');
} else {
  cfg.agents.defaults.heartbeat = { ...hb, every: '0m', target: hb.target || 'none' };
  console.log('heartbeat.every:', before, '-> 0m');
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten. Verify the scheduler picked it up, not just the file:');
console.log('  XDG_RUNTIME_DIR=/run/user/0 openclaw cron list --all | grep -i heartbeat');
console.log('Every "Heartbeat (<agent>)" row should now read disabled; if they still say "every 30m",');
console.log('the gateway did not reload — restart openclaw-gateway (user scope) and look again.');
