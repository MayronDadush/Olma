#!/usr/bin/env node
// Turn on the gateway's olma-turn-open internal hook (gateway-hooks/
// olma-turn-open, synced to /root/.openclaw/hooks by deploy.sh). It opens a
// person's turn in brokerd the moment their message is accepted, before the
// model's first call — the record side of turn_start without the model call.
//
// Config only. Internal hooks are loaded at GATEWAY STARTUP (docs/automation/
// hooks.md, "Hook discovery"), so after --apply the gateway needs one restart:
//   XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
// config_guard reports the entry missing or disabled as a dashboard row.
//
// Usage: node scripts/enable-turn-open-hook.js [--apply] [--disable]
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const DISABLE = process.argv.includes('--disable');
const cfg = occ.loadConfig();
cfg.hooks = cfg.hooks || {};
cfg.hooks.internal = cfg.hooks.internal || {};
cfg.hooks.internal.entries = cfg.hooks.internal.entries || {};
const before = cfg.hooks.internal.entries['olma-turn-open'];
cfg.hooks.internal.enabled = true;
cfg.hooks.internal.entries['olma-turn-open'] = { enabled: !DISABLE };
console.log('hooks.internal.entries.olma-turn-open:', JSON.stringify(before || null), '->', JSON.stringify(cfg.hooks.internal.entries['olma-turn-open']));
if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
occ.saveConfig(cfg);
console.log('\nwritten. Hooks load at gateway startup — restart it once, then verify:');
console.log('  XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway');
console.log('  XDG_RUNTIME_DIR=/run/user/0 openclaw hooks info olma-turn-open');
console.log('and after the next real message: SELECT * FROM audit_log WHERE event = \'turn.opened_by_gateway\' ORDER BY id DESC LIMIT 1');
