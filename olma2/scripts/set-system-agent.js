#!/usr/bin/env node
// Name the agent that OWNS ambient work — the raw `openclaw message send`
// pipe above all, which carries reminders, the credit-outage alarm, the
// runway warning and the nightly eval alert.
//
// Why this exists (2026-09-01, found by an alarm that could not alarm):
// the 2026.8.1 upgrade added `agents.ownership: "explicit"` for multi-agent
// rosters, and from that moment every agent-less CLI operation refused:
//
//   Multiple agents are configured, but this operation has no explicit
//   owner. Select an agent explicitly; CLI callers can pass --agent <id>,
//   channels can add a binding, and ambient services can set their agentId
//   target.
//
// `message send` takes NO --agent flag (checked: --account, --channel,
// --target, --message and nothing else), and a per-peer binding does not
// resolve an OUTBOUND send's owner — so for a multi-agent roster the third
// door is the only one: `agents.defaults.systemAgent.agentId`, read by the
// gateway's own tryResolveAmbientOwnerAgentId. The upgrade's migration fills
// it in automatically ONLY when the roster it converted held exactly one
// agent; ours held eighteen, so it was left unset and every raw send began
// failing silently at 19:30 UTC.
//
// What that cost before anyone noticed: Miron's 08:00 rent reminder expired
// undelivered after 16 attempts, a second reminder sat at 12, and the credit
// alarm — the one channel that still works when the model provider is dry —
// could not have reached anybody. The outbox's retry/backoff absorbed it all
// exactly the way it absorbed the gateway outage the night before.
//
// `main` is the right owner and restores the pre-upgrade behaviour rather
// than changing it: raw sends always logged under the default agent (the
// comment in channels/openclaw.js says so, verified live), `main` has no
// user row, and nothing routes to it. A per-user agent must NEVER be named
// here — an ambient send would then land inside that person's session.
//
// Usage: node scripts/set-system-agent.js [--agent <id>] [--apply] [--reset]
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');
const at = process.argv.indexOf('--agent');
const WANT = at >= 0 ? process.argv[at + 1] : 'main';

const cfg = occ.loadConfig();
cfg.agents = cfg.agents || {};
cfg.agents.defaults = cfg.agents.defaults || {};
const before = (cfg.agents.defaults.systemAgent || {}).agentId || '(unset — ambient sends refuse)';

if (RESET) {
  delete cfg.agents.defaults.systemAgent;
  console.log('systemAgent.agentId:', before, '-> (unset)');
} else {
  if (!occ.hasAgent(cfg, WANT)) {
    console.error(`no such agent in the roster: ${WANT}\nknown: ${occ.listAgentIds(cfg).join(', ')}`);
    process.exit(1);
  }
  cfg.agents.defaults.systemAgent = { agentId: WANT };
  console.log('systemAgent.agentId:', before, '->', WANT);
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten. Verify the pipe itself, not just the file:');
console.log('  openclaw message send --channel whatsapp --target <E.164> --message probe --dry-run --json');
console.log('An ok:true there is the whole point; the config is only how it got there.');
