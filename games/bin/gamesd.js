#!/usr/bin/env node
'use strict';
// gamesd: game nights, on 127.0.0.1 only. Caddy is the only way in from
// outside (games/README.md has the exact route). Migrates on start, so a
// deploy that ships a migration applies it before the first request.
const { createPool, migrate } = require('../src/db');
const { createServer } = require('../src/server');

const PORT = parseInt(process.env.GAMES_PORT || '8794', 10);
const PUBLIC_BASE = process.env.GAMES_PUBLIC_BASE || 'https://allma.world';

(async () => {
  const pool = createPool();
  const applied = await migrate(pool);
  if (applied.length) console.log('[gamesd] migrations applied:', applied.join(', '));
  const server = createServer({ pool, publicBase: PUBLIC_BASE });
  server.listen(PORT, '127.0.0.1', () => console.log(`[gamesd] listening on 127.0.0.1:${PORT}`));
  const stop = () => { server.closeListeners(); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(e => { console.error('[gamesd] failed to start:', e); process.exit(1); });
