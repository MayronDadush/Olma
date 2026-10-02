#!/usr/bin/env node
// Make the gateway answer several WhatsApp messages sent in a row as ONE.
//
// Owner, 2026-10-02: when somebody writes three short messages one after the
// other, Olma should answer all of them together, not once per message. The
// gateway already does this — `messages.inbound` holds a text for a window,
// every new message from the same chat restarts the window (capped at five
// windows from the first), and when it closes the texts are joined with a
// line break into ONE turn: one hook call, one count, one reply, and the reply
// target / message id of the LAST of them. Media, a location and a WhatsApp
// reply (a quote) are never held and flush whatever is waiting ahead of them.
//
// This is the half `messages.queue.mode` cannot do. "followup" is still right
// for a message that arrives while a turn is already RUNNING (set-queue-mode.js
// has why "collect" and "steer" are not); this one decides how long to wait
// before a turn opens at all.
//
// The WhatsApp listener reads the value when it connects, not per message, so
// the gateway must be restarted after --apply. Verify with three quick short
// messages: one reply, and the gateway log shows one dispatch.
//
// Usage: node scripts/set-inbound-debounce.js [--apply] [--reset]
//   --reset deletes the WhatsApp entry (back to the gateway default, 0: no batching)
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const RESET = process.argv.includes('--reset');

const cfg = occ.loadConfig();
const before = occ.whatsappInboundDebounceMs(cfg);
cfg.messages = cfg.messages || {};
cfg.messages.inbound = cfg.messages.inbound || {};
cfg.messages.inbound.byChannel = cfg.messages.inbound.byChannel || {};
if (RESET) {
  delete cfg.messages.inbound.byChannel.whatsapp;
  if (!Object.keys(cfg.messages.inbound.byChannel).length) delete cfg.messages.inbound.byChannel;
  if (!Object.keys(cfg.messages.inbound).length) delete cfg.messages.inbound;
} else {
  cfg.messages.inbound.byChannel.whatsapp = occ.WHATSAPP_INBOUND_DEBOUNCE_MS;
}
console.log('WhatsApp inbound debounce:', `${before}ms`, '->', `${occ.whatsappInboundDebounceMs(cfg)}ms`);

if (!APPLY) { console.log('\ndry run — pass --apply to write'); process.exit(0); }
occ.saveConfig(cfg);
console.log('\nwritten. The WhatsApp listener reads this when it connects: restart the gateway,');
console.log('then send three short messages a few seconds apart and expect ONE reply.');
