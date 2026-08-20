'use strict';
// The guard between the import_contacts_file tool's `path` argument and the
// filesystem. A tool taking a bare path string is normally an instant
// traversal hole; this exists to make that argument safe by construction —
// same philosophy as card-store.js's assertLocalMediaAllowed for OUTBOUND
// media, pointed the other way, inbound.
//
// The path is untrusted twice over: it is a tool argument the model could be
// prompt-injected into mis-supplying, AND its existence assumes something
// about the gateway's inbound-media layout that nothing here gets to assume
// without checking on disk.
const fs = require('node:fs');
const path = require('node:path');
const { ok, err } = require('./results');

// Overridable so tests point this at a tmpdir instead of the live gateway's
// media directory — same pattern as OLMA_GOOGLE_OAUTH_PATH.
const inboundDir = () => process.env.OLMA_INBOUND_MEDIA_DIR || '/root/.openclaw/media/inbound';
const MAX_BYTES = 2 * 1024 * 1024; // an address book of a few thousand contacts sits well under this

function readInboundVcf(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return err('invalid', 'no path given');
  let real;
  try {
    real = fs.realpathSync(rawPath);
  } catch {
    return err('not_found', 'no such file');
  }
  let dir;
  try {
    dir = fs.realpathSync(inboundDir());
  } catch {
    return err('not_found', 'no such file');
  }
  // realpath on BOTH sides resolves symlinks before this check, so a symlink
  // planted inside the inbound directory that points elsewhere cannot be used
  // to escape it — the check runs against where the link actually leads, not
  // where it sits.
  if (real !== dir && !real.startsWith(dir + path.sep)) {
    return err('forbidden', 'that path is not a file Olma received in this conversation');
  }
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return err('not_found', 'no such file');
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) {
    return err('invalid', 'not a readable contact file');
  }
  const text = fs.readFileSync(real, 'utf8');
  // Content sniff, not extension — the gateway's saved filename for an
  // inbound document is not something this module gets to assume.
  if (!/^﻿?\s*BEGIN:VCARD/i.test(text)) {
    return err('invalid', 'that file does not look like a contact card (.vcf)');
  }
  return ok({ text });
}

module.exports = { readInboundVcf };
