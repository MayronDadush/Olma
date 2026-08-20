'use strict';
// The guard between import_contacts_file's `path` tool argument and the
// filesystem. No DB needed — this is pure filesystem policy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const INBOUND = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-inbound-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-outside-'));
process.env.OLMA_INBOUND_MEDIA_DIR = INBOUND;

// Required after the env var above, since the module reads it lazily via a
// function (not at require time) — but set it first regardless, to match the
// pattern the rest of the suite uses for path-dependent modules.
const { readInboundVcf } = require('../src/domain/contact-file');

const VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dana\r\nTEL:0541111111\r\nEND:VCARD\r\n';

after(() => {
  fs.rmSync(INBOUND, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

test('a real .vcf inside the inbound directory is read', () => {
  const p = path.join(INBOUND, 'a.vcf');
  fs.writeFileSync(p, VCARD);
  const res = readInboundVcf(p);
  assert.ok(res.ok);
  assert.match(res.data.text, /BEGIN:VCARD/);
});

test('a path outside the inbound directory is refused', () => {
  const p = path.join(OUTSIDE, 'b.vcf');
  fs.writeFileSync(p, VCARD);
  const res = readInboundVcf(p);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'forbidden');
});

test('a traversal attempt ("../") is refused', () => {
  const res = readInboundVcf(path.join(INBOUND, '..', path.basename(OUTSIDE), 'nonexistent.vcf'));
  assert.equal(res.ok, false);
});

test('a symlink inside the inbound dir pointing outside it is refused — realpath sees through it', () => {
  const target = path.join(OUTSIDE, 'secret.vcf');
  fs.writeFileSync(target, VCARD);
  const link = path.join(INBOUND, 'looks-local.vcf');
  fs.symlinkSync(target, link);
  const res = readInboundVcf(link);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'forbidden');
});

test('non-vCard content is refused even inside the inbound dir', () => {
  const p = path.join(INBOUND, 'not-a-card.txt');
  fs.writeFileSync(p, 'just some ordinary text, not a card');
  const res = readInboundVcf(p);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid');
});

test('an oversize file is refused', () => {
  const p = path.join(INBOUND, 'huge.vcf');
  fs.writeFileSync(p, 'BEGIN:VCARD\r\n' + 'X'.repeat(3 * 1024 * 1024));
  const res = readInboundVcf(p);
  assert.equal(res.ok, false);
});

test('a missing file is reported as not_found, not a crash', () => {
  const res = readInboundVcf(path.join(INBOUND, 'does-not-exist.vcf'));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'not_found');
});

test('no path at all is refused cleanly', () => {
  assert.equal(readInboundVcf('').ok, false);
  assert.equal(readInboundVcf(undefined).ok, false);
});
