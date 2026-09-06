#!/usr/bin/env node
// Make the gateway give a message that arrives mid-turn a turn of its own.
//
// `messages.queue.mode` decides what the gateway does with a message that
// comes in while the agent is still working on the previous one. Its default
// is "steer": the new message is pushed INTO the running turn at the next
// checkpoint, and tool calls the model had just made are cancelled with
// "Skipped due to queued user message". Measured on a real exchange
// (Miron, 2026-09-06): "בוצע" replying to one reminder, "עוד לא" replying to
// another three seconds later — the completion of the first was cancelled,
// the model read the second as a retraction of the first, and neither
// message got what it asked for.
//
// "followup" lets the running turn finish and runs the queued message as a
// turn of its own — with its own count (the turn-open hook fires per
// message), its own opening in the prompt (the olma-turn plugin runs per
// prompt build) and its own reply target. "collect" would merge the queued
// messages into one prompt, which is one count and one reply target for two
// messages — not what we want either.
//
// Config only; the gateway reads this setting per reply from the live
// config. The guard rule in jobs/config-guard.js (checkOpenclawConfig) turns
// red when it is anything else, so an upgrade that resets it shows on the
// board. Verify with two quick messages, not with the file: the first one's
// tool call must run and the second must get its own reply.
//
// Usage: node scripts/set-queue-mode.js [--apply] [--reset]
//   --reset deletes `mode` (back to the gateway default, "steer")
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const cfg = occ.loadConfig();
cfg.messages = cfg.messages || {};
cfg.messages.queue = cfg.messages.queue || {};
const before = cfg.messages.queue.mode === undefined ? '(unset — gateway default "steer")' : cfg.messages.queue.mode;
if (RESET) delete cfg.messages.queue.mode; else cfg.messages.queue.mode = 'followup';
console.log('messages.queue.mode:', before, '->', RESET ? '(unset — "steer")' : 'followup');

if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
occ.saveConfig(cfg);
console.log('\nwritten. The gateway reads this per reply; prove it with two messages a few seconds apart:');
console.log('the first one\'s tool call must run to completion and the second must get its own turn.');
