#!/usr/bin/env node
// Shrink the gateway's stuck-lane recovery window.
//
// When a run finishes without releasing its session lane (observed three times
// on live users — a reply is generated and then never dispatched), every later
// message from that person queues behind it. The gateway's watchdog is what
// frees it, and its defaults are:
//
//   warn  = 120s
//   abort = max(5min, warn * 3) = 360s
//
// So a person who wrote three messages in a row waited 13 minutes and then got
// them answered out of order. The abort floor of 5 minutes is only applied when
// stuckSessionAbortMs is UNSET — set explicitly, the resolver returns
// max(warnMs, value), so we can go well below it:
//
//   resolveStuckSessionAbortMs(config, warnMs):
//     raw = config.diagnostics.stuckSessionAbortMs
//     if (!number || <= 0) return max(5min, warnMs * 3)
//     return max(warnMs, floor(raw))
//
// 75s, not lower: local whisper transcription takes ~37s of wall time with no
// progress events, and aborting a legitimate voice-note run would trade one
// bug for a worse one. If transcription moves to an API this can drop to ~30s.
//
// This does NOT fix the underlying lane bug — it caps the damage from 13
// minutes to about a minute.
//
// Usage: node scripts/set-recovery-thresholds.js [--apply]
'use strict';
const occ = require('../src/intake/openclaw-config');

const WARN_MS = 30_000;
const ABORT_MS = 75_000;
const APPLY = process.argv.includes('--apply');

const cfg = occ.loadConfig();
cfg.diagnostics = cfg.diagnostics || {};
const before = {
  warn: cfg.diagnostics.stuckSessionWarnMs ?? '(default 120000)',
  abort: cfg.diagnostics.stuckSessionAbortMs ?? '(default 360000)',
};
cfg.diagnostics.stuckSessionWarnMs = WARN_MS;
cfg.diagnostics.stuckSessionAbortMs = ABORT_MS;

console.log('stuckSessionWarnMs :', before.warn, '->', WARN_MS);
console.log('stuckSessionAbortMs:', before.abort, '->', ABORT_MS);

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(0);
}
occ.saveConfig(cfg);
console.log('\nwritten. diagnostics is not a hot-reload path — restart the gateway:');
console.log('  systemctl --user restart openclaw-gateway');
