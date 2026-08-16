#!/usr/bin/env node
// Phase G cutover, step 2: point the gateway at v2 and start fresh.
//  - v1 per-user agents (u-2, u-4, u-9) and their bindings removed — the
//    user decided on a clean start, no data carried over.
//  - mcp.servers.olma now runs the v2 shim.
//  - dmPolicy "open": strangers reach the intake agent (the catch-all
//    installed by install-intake.js) — quota + flood counter + the intake
//    circuit breaker are the guards on that door now.
// Usage: node scripts/cutover-config.js --apply   (dry run without flag)
'use strict';
const fs = require('node:fs');

const APPLY = process.argv.includes('--apply');
const p = process.env.OLMA_OPENCLAW_CONFIG || '/root/.openclaw/openclaw.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));

const V1_AGENTS = ['u-2', 'u-4', 'u-9'];
c.agents.list = c.agents.list.filter((a) => !V1_AGENTS.includes(a.id));
c.bindings = c.bindings.filter((b) => !V1_AGENTS.includes(b.agentId));
c.mcp.servers.olma = { command: 'node', args: ['/opt/olma2/bin/olma-mcp.js'] };
c.channels.whatsapp.accounts.default.dmPolicy = 'open';
// Under "open", allowFrom must be "*" — the gateway audit warns that a stale
// number list drops DMs otherwise. Authorization lives in OUR layer now
// (quota, flood counter, intake breaker), not in a phone allowlist.
c.channels.whatsapp.accounts.default.allowFrom = ['*'];

console.log('agents:', c.agents.list.map((a) => a.id).join(', '));
console.log('bindings:', c.bindings.map((b) => `${b.agentId} <- ${b.match.peer.id}`).join(' | '));
console.log('dmPolicy:', c.channels.whatsapp.accounts.default.dmPolicy);
console.log('mcp olma →', c.mcp.servers.olma.args[0]);

if (!APPLY) { console.log('dry run — pass --apply to write'); process.exit(0); }
fs.writeFileSync(p + '.tmp', JSON.stringify(c, null, 2), { mode: 0o600 });
fs.renameSync(p + '.tmp', p);
console.log('written.');
