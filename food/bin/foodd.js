#!/usr/bin/env node
'use strict';
// foodd: what people ate, on 127.0.0.1 only. Caddy is the only way in from
// outside (food/README.md has the exact route). Migrates on start, so a
// deploy that ships a migration applies it before the first request.
//
// It also writes the meals people asked to log themselves (store.runAuto),
// once a minute: a restart in the middle is safe, because each one is
// claimed for its day before it is written.
const { createPool, migrate } = require('../src/db');
const { createServer } = require('../src/server');
const { runAuto } = require('../src/store');
const foods = require('../src/foods');

const PORT = parseInt(process.env.FOOD_PORT || '8795', 10);
const PUBLIC_BASE = process.env.FOOD_PUBLIC_BASE || 'https://allma.world';

(async () => {
  const pool = createPool();
  const applied = await migrate(pool);
  if (applied.length) console.log('[foodd] migrations applied:', applied.join(', '));
  // The table the values come from (data/). Idempotent: on most starts it
  // counts the rows, finds them all there, and only adds new seed names.
  const seeded = await foods.seed(pool);
  if (seeded.loaded || seeded.named) console.log('[foodd] food table:', seeded.loaded, 'rows,', seeded.named, 'new names');
  if (!process.env.FOOD_OPENROUTER_KEY) console.warn('[foodd] FOOD_OPENROUTER_KEY is not set: photos cannot be read and new food names cannot be matched');
  const server = createServer({ pool, publicBase: PUBLIC_BASE });
  server.listen(PORT, '127.0.0.1', () => console.log(`[foodd] listening on 127.0.0.1:${PORT}`));
  const tick = setInterval(() => {
    runAuto(pool).then(w => { if (w.length) console.log('[foodd] auto meals written:', w.length); })
      .catch(e => console.error('[foodd] auto meals failed:', e && e.message || e));
  }, 60_000);
  const stop = () => { clearInterval(tick); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(e => { console.error('[foodd] failed to start:', e); process.exit(1); });
