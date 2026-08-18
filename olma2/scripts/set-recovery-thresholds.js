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
// 75s was sized around local whisper transcription (~37s wall time, no
// progress events) — aborting a legitimate voice-note run would trade one
// bug for a worse one. Voice-note transcription moved to ElevenLabs Scribe
// v2 on 2026-08-18 (see CLAUDE.md) — measured live at ~4s, and the
// ElevenLabs model entry now carries its own 15s timeoutSeconds, so a hang
// fails over to the local whisper.cpp fallback quickly instead of idling for
// the previous 60s default. Worst-case legitimate run is now bounded by that
// fallback path: ~15s (ElevenLabs timeout) + ~37s (local whisper real run)
// ≈ 52s, so 65s keeps ~13s of margin above it — down from 75s, but still
// short of the naive "measured latency dropped 9x so shrink 9x" move, since
// the fallback path didn't get any faster, only the common path did.
//
// This does NOT fix the underlying lane bug — it caps the damage from 13
// minutes down further still.
//
// Usage: node scripts/set-recovery-thresholds.js [--apply]
'use strict';
const occ = require('../src/intake/openclaw-config');

const WARN_MS = 25_000;
const ABORT_MS = 65_000;
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
