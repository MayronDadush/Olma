#!/usr/bin/env node
'use strict';
// One-time install for group mode's greeter. Run by hand, never by a sweep:
// it changes how the live gateway treats EVERY WhatsApp group, and a feature
// that is not switched on yet has no business writing that config on a timer.
//
// What it adds, in one write:
//   agents.entries.ggreet                      the muted agent
//   bindings[] peer {kind:'group', id:'*'}     every group with no agent of its own
//   session.sendPolicy deny agent:ggreet:      the mute, permanent
//   channels.whatsapp.groups["*"]              admits groups we have never seen
//
// It does NOT touch `groupPolicy`. Group inbound stays exactly as disabled or
// enabled as it was — turning the feature on is a separate, deliberate step:
//
//   node scripts/install-group-greeter.js            # install
//   node scripts/install-group-greeter.js --status   # what is in place
//
// Then, when group mode is actually meant to go live, set
// `channels.whatsapp.accounts.default.groupPolicy` to "allowlist" with
// `groupAllowFrom` carrying Olma's USERS' phone numbers — and never her own
// (proactive-text.js explains the loop that guards against).
const occ = require('../src/intake/openclaw-config');
const pg = require('../src/intake/provision-group');

const configPath = process.env.OLMA_OPENCLAW_CONFIG || occ.DEFAULT_PATH;

function status() {
  const cfg = occ.loadConfig(configPath);
  const groups = (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.groups) || {};
  return {
    configPath,
    agent: occ.hasAgent(cfg, pg.GREETER_AGENT_ID),
    muted: occ.isAgentMuted(cfg, pg.GREETER_AGENT_ID),
    wildcardBinding: (cfg.bindings || []).some(
      (b) => b.match && b.match.peer && b.match.peer.kind === 'group' && b.match.peer.id === '*'),
    admitsUnknownGroups: Object.hasOwn(groups, '*'),
    registeredGroups: Object.keys(groups).filter((k) => k !== '*'),
    groupPolicy: (cfg.channels && cfg.channels.whatsapp && cfg.channels.whatsapp.accounts
      && cfg.channels.whatsapp.accounts.default || {}).groupPolicy || '(unset)',
  };
}

function main() {
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(status(), null, 2));
    return;
  }
  const changed = pg.installGreeter({ configPath });
  console.log(JSON.stringify({ changed, status: status() }, null, 2));
  if (!Object.values(changed).some(Boolean)) {
    console.log('\nAlready installed — nothing written.');
    return;
  }
  // The agent entry in this same write is the reload planner's hot reason, so
  // the mute and the wildcard ride along with it. Verify against the gateway
  // rather than the file: an invalid config is IGNORED, not rejected.
  console.log('\nWritten. Confirm the gateway actually took it:');
  console.log("  journalctl --user -u openclaw-gateway --since '-2min' | grep reload");
  console.log('Group inbound is still governed by groupPolicy; this script never changes it.');
}

if (require.main === module) main();
module.exports = { status };
