#!/usr/bin/env node
// Deny the gateway tools Olma never uses — they cost real money every turn.
//
// Every tool's JSON schema rides inside the cached prompt prefix, so every
// cold cache write pays for all of them. Measured live (systemPromptReport,
// 2026-08-22) the injected gateway tools cost, in schema characters:
//
//   cron 12,525 · message 5,813 · sessions_list 570 · sessions_send 557 ·
//   session_status 367 · apply_patch 285 · sessions_history 279  ≈ 20.4k chars
//
// and none of them has a caller by design:
//   * cron — v2 scheduling lives entirely in brokerd (outbox + sweeps); agent
//     cron was v1's mechanism and `openclaw cron list` is empty.
//   * message — DELIVERY_PREAMBLE forbids it outright (calling it double-sends
//     what --deliver already sends). The DeepSeek pilot proved the hazard is
//     real: it tried exactly this call and was saved only by guessing an
//     invalid target. Denying makes the doctrine a hard stop.
//   * sessions_* — agent-to-agent session access; cross-user anything goes
//     through the brokered outbox, never direct. (lane-watchdog uses the
//     sessions.abort RPC, which is not an agent tool and is unaffected.)
//   * apply_patch — agents edit USER.md with plain `write`.
//
// `read` and `write` stay: .olma-identity and the USER.md intake-note rewrite
// depend on them.
//
// Usage: node scripts/trim-agent-tools.js [--apply | --reset --apply]
'use strict';
const occ = require('../src/intake/openclaw-config');

const DENY = ['cron', 'message', 'sessions_list', 'sessions_send',
  'session_status', 'sessions_history', 'apply_patch'];
const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const cfg = occ.loadConfig();
cfg.tools = cfg.tools || {};
const beforeDeny = cfg.tools.deny || [];
const beforeAllow = cfg.tools.alsoAllow || [];

if (RESET) {
  delete cfg.tools.deny;
  if (!beforeAllow.includes('cron')) cfg.tools.alsoAllow = [...beforeAllow, 'cron'];
  console.log('deny:', JSON.stringify(beforeDeny), '-> (none)');
} else {
  cfg.tools.deny = DENY;
  // cron was explicitly alsoAllow'ed once; leaving it there while denying it
  // would make the config argue with itself.
  cfg.tools.alsoAllow = beforeAllow.filter((t) => t !== 'cron');
  console.log('deny:', JSON.stringify(beforeDeny), '->', JSON.stringify(DENY));
  console.log('alsoAllow:', JSON.stringify(beforeAllow), '->', JSON.stringify(cfg.tools.alsoAllow));
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten. tool policy is not a hot-reload path — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
