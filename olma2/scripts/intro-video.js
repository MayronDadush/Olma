#!/usr/bin/env node
// Send the intro video to everybody Olma serves, and read back how it landed
// (domain/intro-video.js holds the why).
//
// Usage (on the box, from /opt/olma2):
//   node scripts/intro-video.js                     # preview: who would get it — counts only
//   node scripts/intro-video.js --enqueue --yes     # queue it; the gate sends it in their hours
//   node scripts/intro-video.js --stats             # how it landed so far
//   add --video v2 to name another clip (v2 is the default and the only one)
//
// Queuing is idempotent per person per clip, so running --enqueue twice
// queues nothing the second time. Nothing here prints a name or a number.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const intro = require('../src/domain/intro-video');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}
const video = arg('video') || 'v2';
const ENQUEUE = process.argv.includes('--enqueue');
const YES = process.argv.includes('--yes');
const STATS = process.argv.includes('--stats');

function pct(n, d) { return d ? `${Math.round((100 * n) / d)}%` : '—'; }

(async () => {
  if (!intro.VIDEOS[video]) { console.error(`unknown video: ${video}`); process.exit(2); }
  const pool = createPool();
  try {
    if (STATS) {
      const s = await withTx(pool, (c) => intro.stats(c, video));
      const lines = [
        `intro video ${video} — ${s.rows} queued in total`,
        `  reached them:        ${s.delivered}  (he ${s.deliveredHe}, en ${s.deliveredEn}${s.unconfirmed ? `, ${s.unconfirmed} timed out and very likely went` : ''})`,
        `  still waiting:       ${s.waiting}  ${JSON.stringify(s.waitingReasons)}`,
        `  failing to send:     ${s.failing}`,
        `  will never go:       ${s.dropped}  ${JSON.stringify(s.droppedReasons)}`,
        `  wrote within ${intro.REPLY_WINDOW_MIN}m:    ${s.repliedWithin30m}  (${pct(s.repliedWithin30m, s.delivered)} of reached)`,
        `  wrote within ${intro.IGNORE_WINDOW_HOURS}h:    ${s.repliedWithin24h}  (${pct(s.repliedWithin24h, s.delivered)})`,
        `  no word in ${intro.IGNORE_WINDOW_HOURS}h:     ${s.ignored24h}  (${pct(s.ignored24h, s.delivered)})`,
        `  under ${intro.IGNORE_WINDOW_HOURS}h, no word yet: ${s.tooEarlyToTell}`,
        '  watched:             unknown — the send pipe reports no read receipts to us',
      ];
      console.log(lines.join('\n'));
      return;
    }
    const a = await withTx(pool, (c) => intro.audience(c));
    console.log(`intro video ${video}: ${a.eligible} would get it (he ${a.he}, en ${a.en}); `
      + `${a.paused} paused are left out; ${a.silent} of the ${a.eligible} have stopped answering and get it anyway (owner's call).`);
    if (!ENQUEUE) { console.log('preview only — add --enqueue --yes to queue it'); return; }
    if (!YES) { console.error('refusing without --yes'); process.exit(2); }
    const r = await withTx(pool, (c) => intro.enqueueAll(c, video));
    console.log(`queued ${r.queued} of ${r.candidates} (the rest were already queued)`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
