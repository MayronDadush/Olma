#!/usr/bin/env node
// Switch off the bundled gateway plugins nothing of ours uses
// (src/intake/unused-plugins.js says which, and how each was checked).
//
// Why: the gateway imports them into its own process at startup, on a 2GB
// box where the gateway is already the process that does not fit. The saving
// is measured on the box before and after, not assumed — see the incident
// entry "The gateway carried sixteen plugins and used five".
//
// Validated before it is written (src/intake/validate-candidate.js): an
// invalid openclaw.json is ignored, not rejected, and every later reload
// with it. A plugin change does NOT hot-reload — restart the gateway after,
// at a quiet hour, and read the startup line to confirm the count dropped.
//
// config_guard (checkUnusedPlugins) turns a row on when a gateway upgrade or
// a hand edit brings one back.
//
// Usage: node scripts/disable-unused-plugins.js [--apply]
'use strict';
const occ = require('../src/intake/openclaw-config');
const { disableUnused } = require('../src/intake/unused-plugins');
const { validateCandidate: validate } = require('../src/intake/validate-candidate');

const APPLY = process.argv.includes('--apply');

const cfg = occ.loadConfig();
const changed = disableUnused(cfg);
console.log(changed.length ? `would switch off ${changed.length} plugin(s): ${changed.join(', ')}` : 'every unused plugin is already off — nothing to write');
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
console.log('\nwritten. Plugins load at startup, so restart the gateway (user scope) at a quiet hour, then confirm:');
console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since "-5min" | grep "http server listening"');
console.log('The plugin list in that line should no longer name any of the ids above.');
