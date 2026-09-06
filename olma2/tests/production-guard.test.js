'use strict';
// The suite writing into production is not a hypothetical: it happened three
// times in two days and cost six users their identity files. These tests hold
// both locks open — the isolation that keeps a test process away from the live
// paths, and the guard that catches it if the isolation is ever lost.
//
// "A detector that can no longer fail is not a detector" (CLAUDE.md): every
// case below drives the guard at a REAL production path, so a future refactor
// that quietly stops checking turns this file red rather than green.
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../src/intake/production-guard');
const occ = require('../src/intake/openclaw-config');
const provision = require('../src/intake/provision');

test('the suite is isolated from the live gateway', () => {
  // If this fails, nothing else in this file matters: the whole suite is
  // pointed at production and every other test is one sweep away from it.
  assert.ok(process.env.OLMA_OPENCLAW_HOME, 'OLMA_OPENCLAW_HOME must be set by helpers.js');
  assert.ok(process.env.OLMA_OPENCLAW_CONFIG, 'OLMA_OPENCLAW_CONFIG must be set by helpers.js');
  assert.ok(!guard.isProductionPath(process.env.OLMA_OPENCLAW_HOME),
    `test home must not be under production: ${process.env.OLMA_OPENCLAW_HOME}`);
  assert.ok(!guard.isProductionPath(occ.defaultPath()),
    `test config must not be production: ${occ.defaultPath()}`);
});

test('we really are running in a process the guard can recognise', () => {
  // The guard keys on NODE_TEST_CONTEXT. If a future Node stopped setting it,
  // the guard would silently pass everything — so assert the premise itself
  // rather than trusting it.
  assert.ok(guard.inTestProcess(),
    'NODE_TEST_CONTEXT is not set, so the production guard cannot fire at all');
});

test('production paths are recognised, neighbours are not', () => {
  assert.ok(guard.isProductionPath('/root/.openclaw'));
  assert.ok(guard.isProductionPath('/root/.openclaw/openclaw.json'));
  assert.ok(guard.isProductionPath('/root/.openclaw/workspaces/u-13'));
  // A path that merely starts with the same characters is a different tree.
  assert.ok(!guard.isProductionPath('/root/.openclaw-backup/openclaw.json'));
  assert.ok(!guard.isProductionPath('/tmp/olma2-test-home-abc/openclaw.json'));
});

test('reading or writing the live roster from a test throws', () => {
  assert.throws(() => occ.loadConfig('/root/.openclaw/openclaw.json'),
    /refusing to touch the live gateway/);
  assert.throws(() => occ.saveConfig({ agents: { entries: {} } }, '/root/.openclaw/openclaw.json'),
    /refusing to touch the live gateway/);
});

test('resolving a live workspace path from a test throws', () => {
  const home = process.env.OLMA_OPENCLAW_HOME;
  try {
    delete process.env.OLMA_OPENCLAW_HOME; // exactly what a lost env looks like
    assert.throws(() => provision.defaultPaths('u-13'), /refusing to touch the live gateway/);
  } finally {
    process.env.OLMA_OPENCLAW_HOME = home;
  }
});

test('a temp home is still allowed while the guard is armed', () => {
  // The guard must block production and NOTHING else — one that blocked every
  // path would take the suite down with it and get switched off.
  const paths = provision.defaultPaths('u-13');
  assert.ok(paths.workspace.startsWith(process.env.OLMA_OPENCLAW_HOME));
  assert.doesNotThrow(() => occ.loadConfig());
});

test('provisioning evicts a directory left by an earlier occupant', () => {
  // The reissue hazard: agent ids are u-<serial>, a Postgres sequence never
  // reissues one, so a directory already sitting on our id belongs to somebody
  // else. What matters is the file seedWorkspace does NOT overwrite — a daily
  // memory note, which the gateway injects at session start.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-stale-ws-'));
  fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'memory', '2026-09-05.md'), 'previous occupant, private\n');
  fs.writeFileSync(path.join(ws, 'USER.md'), '# User\n\nFirst name: somebody else\n');

  provision.seedWorkspace(ws, { firstName: 'New', identityToken: 'olma_tok_new' });
  // Without eviction the daily note survives into the new person's workspace.
  assert.ok(fs.existsSync(path.join(ws, 'memory', '2026-09-05.md')),
    'precondition: seedWorkspace does not clear memory/, which is why eviction exists');

  const parked = provision.evictStaleWorkspace(ws);
  assert.ok(parked, 'a directory with a previous occupant must be moved aside');
  assert.ok(!fs.existsSync(ws), 'the id must be left clean for the new user');
  assert.ok(fs.existsSync(path.join(parked, 'memory', '2026-09-05.md')),
    'the previous occupant’s files are preserved, never deleted');

  fs.rmSync(parked, { recursive: true, force: true });
});

test('a freshly seeded workspace is not mistaken for an inherited one', () => {
  // Provisioning retries and re-runs are ordinary; only foreign content counts.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'olma2-fresh-ws-'));
  provision.seedWorkspace(ws, { firstName: 'Fresh', identityToken: 'olma_tok_fresh' });
  assert.equal(provision.evictStaleWorkspace(ws), null,
    'only files seedWorkspace does not own should trigger an eviction');
  fs.rmSync(ws, { recursive: true, force: true });
});
