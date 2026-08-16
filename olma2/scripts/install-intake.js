#!/usr/bin/env node
// CUTOVER-ONLY script — installs the intake agent + catch-all binding into
// the live OpenClaw config. NOT run automatically anywhere; Phase G runs it
// deliberately, because activating the catch-all changes who can reach the
// gateway (requires dmPolicy "open" to matter, which is also a cutover step).
//
// Usage: node scripts/install-intake.js [--apply]   (default: dry run)
'use strict';
const occ = require('../src/intake/openclaw-config');
const { syncIntakeWorkspace } = require('../src/intake/intake-workspace');
const path = require('node:path');
const fs = require('node:fs');

const APPLY = process.argv.includes('--apply');
const base = process.env.OLMA_OPENCLAW_HOME || '/root/.openclaw';

const cfg = occ.loadConfig();
const ws = path.join(base, 'workspaces', 'intake');
const agentDir = path.join(base, 'agents', 'intake', 'agent');

const addedAgent = occ.addAgent(cfg, { id: 'intake', workspace: ws, agentDir });
const addedBinding = occ.addCatchAllBinding(cfg, { agentId: 'intake' });

console.log(`agent 'intake': ${addedAgent ? 'will add' : 'already present'}`);
console.log(`catch-all binding: ${addedBinding ? 'will add' : 'already present'}`);
console.log('NOTE: catch-all only matters once dmPolicy is "open" (separate cutover step).');
// This one DOES need a restart: it is a bindings-only change, which hits the
// gateway's noop early-exit and never reaches the state swap. Per-user
// provisioning does not, because it writes an agent in the same save — see
// src/intake/openclaw-config.js.
console.log('NOTE: this catch-all binding is a bindings-only change — restart the gateway once:');
console.log('  systemctl --user restart openclaw-gateway');

if (!APPLY) { console.log('dry run — pass --apply to write'); process.exit(0); }

syncIntakeWorkspace(true, base);
fs.mkdirSync(agentDir, { recursive: true });
occ.saveConfig(cfg);
console.log('written. Restart the gateway to activate the catch-all binding.');
