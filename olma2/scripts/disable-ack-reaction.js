#!/usr/bin/env node
// Stop the GATEWAY from placing its own acknowledgement reaction, so the only
// 👀 on a person's message is ours.
//
// WHY THERE ARE TWO
//
// Two systems mark an inbound message and neither can see the other:
//
//   the gateway   `ackReaction` in openclaw.json — one fixed emoji, placed
//                 from its own config the moment a message is accepted.
//   us            brokerd's `openTurnFromGateway` → domain/reactions.placeMark,
//                 ~15s later (a whole `openclaw` CLI start-up).
//
// Miron, 2026-09-14: "עיניים, עיניים, ואז לייק" — 👀, 👀, 👍 on one message.
// That is not a bug in either one; it is both of them working.
//
// WHY OURS IS THE ONE THAT STAYS (owner's call, 2026-09-14)
//
// They are not interchangeable. The gateway's ack can only ever be one emoji.
// Ours picks between three at turn-open — `thanksOnly ? 'thanks' : (kind ===
// 'voice' ? 'listening' : 'working')` — so a voice note gets 👂 and a
// thanks-only message gets 🙏, both of which carry what 👀 cannot (a voice
// note has to be uploaded and transcribed, and that is the part most likely to
// fail silently; 🙏 says the exchange is closed and promises no reply). Ours is
// also the same vocabulary that places every later mark — 👍 ⏰ ❓ — with one
// table and one operator-editable flag (`reactions.VOCAB_FLAG`).
//
// So today the gateway's ack is not merely redundant, it is WRONG twice over:
// on a voice note the person sees 👀 and then 👂 fifteen seconds later, and on
// a thanks-only message 👀 then 🙏. We are visibly correcting its guess.
//
// WHAT THIS COSTS, SAID OUT LOUD
//
// The gateway's ack is instant; ours waits on a CLI start-up. Removing it
// makes the acknowledgement land ~15s late instead of immediately. A cold turn
// is ~77s, so it still arrives well ahead of the reply — but it IS slower, and
// the honest fix for that is to move `placeMark` onto the gateway's own
// WebSocket (channels/gateway-rpc.js already holds one, and its `send()` takes
// any method name; the same move took a raw send from 8.8-12.7s to 5-35ms).
//
// And it removes a safety net: the gateway's ack is what made the reaction
// feature LOOK alive through the six hours our own mark path was dead
// (`incidents.md`, "The mark that never moved"). After this, a failure in
// placeMark is visible instead of masked — which is what this repo wants
// ("the reaction failed" and "no reaction was ever attempted" must not be the
// same observation), but it is a real change in failure mode.
//
// Usage:
//   node scripts/disable-ack-reaction.js                 # report only
//   node scripts/disable-ack-reaction.js --apply         # remove it
//   node scripts/disable-ack-reaction.js --set 👀 --apply  # put a value back
'use strict';
const occ = require('../src/intake/openclaw-config');

const APPLY = process.argv.includes('--apply');
const setIdx = process.argv.indexOf('--set');
const SET = setIdx >= 0 ? process.argv[setIdx + 1] : null;

const KEY = 'ackReaction';

// Found rather than assumed: the gateway owns this file and has moved keys
// between versions before, so the path is read off the config in front of us
// instead of hard-coded. Returns [{ path, parent, value }].
function findKey(node, key, trail = []) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push({ path: [...trail, k].join('.'), parent: node, value: v });
    else if (v && typeof v === 'object') out.push(...findKey(v, key, [...trail, k]));
  }
  return out;
}

const cfg = occ.loadConfig();
const hits = findKey(cfg, KEY);

if (!hits.length && !SET) {
  console.log(`${KEY} is not set anywhere in the config.`);
  console.log('');
  console.log('That is a FINDING, not a no-op: if a person is still seeing two 👀,');
  console.log('the second one is not the gateway\'s ack, and the diagnosis is wrong.');
  console.log('Next place to look is what the gateway actually SENT, per emoji:');
  console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway --since today | grep -i react');
  process.exit(0);
}

for (const h of hits) console.log(`found ${h.path} = ${JSON.stringify(h.value)}`);

// A write under channels.whatsapp restarts the WhatsApp channel — 16s measured,
// every send inside it refused (.claude/rules/gateway.md). Whether this change
// is invisible or a brief outage depends entirely on where the key lives, so it
// is stated before anything is written rather than discovered afterwards.
const restarts = hits.some((h) => h.path.startsWith('channels.whatsapp'));

if (SET) {
  const target = hits[0];
  if (!target) {
    console.log(`\ncannot --set: ${KEY} is not present, and this script will not guess where it belongs.`);
    console.log('Add it by hand in the gateway\'s own shape, then re-run to confirm.');
    process.exit(1);
  }
  target.parent[KEY] = SET;
  console.log(`\n${target.path}: -> ${JSON.stringify(SET)}`);
} else {
  for (const h of hits) delete h.parent[KEY];
  console.log(`\nremoving ${hits.length} key(s) — the only acknowledgement mark left is ours (domain/reactions.js)`);
}

if (restarts) {
  console.log('\n⚠  this key lives under channels.whatsapp, so writing it RESTARTS the');
  console.log('   WhatsApp channel (~16s, every send refused inside it). Pick a quiet');
  console.log('   moment; group_outbox already stays silent for 45s after a restart.');
}

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}

occ.saveConfig(cfg);
console.log('\nwritten. Now verify the GATEWAY applied it, not that the file says so —');
console.log('an invalid config is IGNORED rather than rejected, and looks identical:');
console.log('  XDG_RUNTIME_DIR=/run/user/0 journalctl --user -u openclaw-gateway -n 50 | grep -i "config\\|react"');
console.log('Then send one real message and watch the marks we place:');
console.log('  journalctl -u olma2-brokerd --since "2 min ago" | grep reactions');
console.log('Expected: exactly one mark from us per message (working|listening|thanks), then its closing mark.');
