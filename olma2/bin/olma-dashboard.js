#!/usr/bin/env node
// Admin dashboard entry. Binds localhost by default — public exposure (and
// the domain/proxy in front of it) is a deliberate cutover decision, not a
// default. Refuses to start without credentials.
'use strict';
const { createPool } = require('../src/db/pool');
const { createDashboard } = require('../src/adapters/http/dashboard');

const PORT = parseInt(process.env.OLMA_DASH_PORT || '8788', 10);
const HOST = process.env.OLMA_DASH_HOST || '127.0.0.1';
const adminUser = process.env.OLMA_ADMIN_USER;
const adminPass = process.env.OLMA_ADMIN_PASS;

if (!adminUser || !adminPass || adminPass.length < 12) {
  console.error('OLMA_ADMIN_USER and OLMA_ADMIN_PASS (12+ chars) are required');
  process.exit(1);
}

const pool = createPool();
const server = createDashboard({ pool, adminUser, adminPass });
server.listen(PORT, HOST, () => console.log(`[dashboard] http://${HOST}:${PORT}`));

process.on('SIGTERM', () => { server.close(); pool.end().then(() => process.exit(0)); });
