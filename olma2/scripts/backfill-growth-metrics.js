#!/usr/bin/env node
// The weekly-active and by-channel metrics (jobs/metrics.js, 2026-09-30) are
// written by the hourly rollup for today and yesterday only, so the admin
// page's "a week ago" and "joined in 30 days" have nothing to read until a
// month has passed. This writes those metrics — and ONLY those — for the days
// before that.
//
// Only the new ones, deliberately: every other metric is also rebuilt from
// audit_log, and routine audit rows are pruned after a few months, so
// recomputing an old day of `tasks_created` would overwrite a true count with
// a smaller one. The new metrics read `message.received` and `dashboard.*`
// rows, which are recent enough for the default window to still hold them.
//
// Usage:
//   node scripts/backfill-growth-metrics.js              # report what would be written
//   node scripts/backfill-growth-metrics.js --apply [--days 60]
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const { METRIC_QUERIES, JOIN_CHANNELS } = require('../src/jobs/metrics');

const APPLY = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const DAYS = di > 0 ? Math.max(1, Math.min(180, Number(process.argv[di + 1]) || 60)) : 60;
const METRICS = ['weekly_active_users', 'referral_clicks', ...JOIN_CHANNELS.flatMap((v) => [`joined_${v}`, `wau_${v}`])];

(async () => {
  const pool = createPool();
  try {
    await withTx(pool, async (client) => {
      const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      for (let age = DAYS; age >= 0; age--) {
        const date = new Date(today - age * 86400_000).toISOString().slice(0, 10);
        const vals = {};
        for (const m of METRICS) {
          const { rows } = await client.query(METRIC_QUERIES[m], [date]);
          vals[m] = Number(Object.values(rows[0])[0]) || 0;
          if (APPLY) {
            await client.query(
              `INSERT INTO product_metrics_daily (date, metric, value) VALUES ($1, $2, $3)
               ON CONFLICT (date, metric) DO UPDATE SET value = $3`, [date, m, vals[m]]);
          }
        }
        console.log(date, `wau=${vals.weekly_active_users}`,
          JOIN_CHANNELS.map((v) => `${v}:${vals[`joined_${v}`]}/${vals[`wau_${v}`]}`).join(' '));
      }
    });
    console.log(APPLY ? `written: ${METRICS.length} metrics × ${DAYS + 1} days` : 'dry run — pass --apply to write');
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
