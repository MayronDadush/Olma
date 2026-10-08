#!/usr/bin/env node
// Patch the gateway's WhatsApp plugin so a CIPHERTEXT stub cannot swallow the
// real message that follows it under the same id. What and why:
// src/intake/whatsapp-stub-patch.js, and docs/incidents.md, "The first message
// that reached nobody".
//
// Dry run by default: says, per installed copy, whether it is patched, would
// be patched, or is a bundle this patch was not written against (left alone).
// --apply writes the patched file beside the original first, proves it parses
// (`node --check`, in the same directory so the package's module type holds),
// keeps the original once as `<file>.olma-orig`, and renames it into place.
// Idempotent: a patched copy is not touched again.
// --revert puts `<file>.olma-orig` back.
//
// The plugin loads at gateway STARTUP: nothing changes until
//   XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway
// and every plugin or gateway update takes the patch out again —
// config_guard (checkWhatsAppStubPatch) turns red when it has.
//
// Usage: node scripts/patch-whatsapp-stub.js [--apply | --revert]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const stubPatch = require('../src/intake/whatsapp-stub-patch');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const home = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';

const files = stubPatch.findMonitorFiles(home);
if (files === null) { console.error(`no plugin directory under ${home}/npm/projects`); process.exit(1); }
if (!files.length) { console.error('no WhatsApp plugin monitor holding handleMessagesUpsert was found'); process.exit(1); }

let failed = false;
for (const file of files) {
  const orig = `${file}.olma-orig`;
  if (REVERT) {
    if (!fs.existsSync(orig)) { console.log(`${file}: no ${path.basename(orig)} to restore`); continue; }
    fs.copyFileSync(orig, file);
    console.log(`${file}: restored from ${path.basename(orig)}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const res = stubPatch.patchSource(src);
  if (res.state === 'patched') { console.log(`${file}: already patched`); continue; }
  if (res.state === 'unknown') {
    console.log(`${file}: NOT RECOGNISED — the anchor is missing or not unique; left alone. `
      + 'The plugin changed: read its handleMessagesUpsert before updating ANCHOR.');
    failed = true;
    continue;
  }
  if (!APPLY) { console.log(`${file}: would patch`); continue; }
  const tmp = path.join(path.dirname(file), `.olma-stub-patch-${process.pid}.js`);
  try {
    fs.writeFileSync(tmp, res.source, { mode: fs.statSync(file).mode });
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
    fs.renameSync(tmp, file);
    console.log(`${file}: patched (original kept as ${path.basename(orig)})`);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    console.error(`${file}: NOT patched — ${String((e.stderr && e.stderr.toString()) || e.message).slice(0, 400)}`);
    failed = true;
  }
}
if (!APPLY && !REVERT) console.log('\ndry run — pass --apply to write');
else console.log('\nrestart the gateway for it to load: XDG_RUNTIME_DIR=/run/user/0 systemctl --user restart openclaw-gateway');
process.exit(failed ? 1 : 0);
