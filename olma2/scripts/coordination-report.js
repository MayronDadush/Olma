#!/usr/bin/env node
// Every coordination scored by `coordination-score`, and every touch of ours
// read against what came after it — the baseline the room-coordination policy
// is measured against, and the count toward the owner's ten (2026-09-28).
// Read-only: one READ ONLY transaction, and it prints no name, number or
// message — ids and counts only.
//
//   node scripts/coordination-report.js                 # rooms only
//   node scripts/coordination-report.js --all            # private coordinations too
//   node scripts/coordination-report.js --since 2026-09-28   # the experiment's count
//
// `--since` splits the table: what closed before it is the BASELINE, what
// closed on or after it counts toward the ten. Only a room counts.
'use strict';
const { createPool } = require('../src/db/pool');
const { timelineFor, coordinationIds } = require('../src/domain/coordination-timeline');
const { scoreCoordination, touchEffects } = require('../src/domain/coordination-score');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const ALL = process.argv.includes('--all');
const SINCE = new Date(arg('since', '2026-09-28T00:00:00+03:00')).getTime();
const GOAL = 10;

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const f1 = (x) => (x == null ? '—' : Number(x).toFixed(1));
const pad = (s, n) => String(s).padEnd(n);

(async () => {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const ids = await coordinationIds(client, { roomsOnly: !ALL });
    const rows = [];
    for (const id of ids) {
      const tl = await timelineFor(client, id);
      if (tl) rows.push({ tl, s: scoreCoordination(tl), fx: touchEffects(tl) });
    }
    await client.query('ROLLBACK');

    console.log(`Coordinations — ${ALL ? 'all' : 'rooms only'} · ${rows.length} scored · experiment from ${arg('since', '2026-09-28')}\n`);
    console.log(`${pad('id', 5)}${pad('room', 6)}${pad('outcome', 15)}${pad('score', 7)}${pad('ok', 4)}${pad('close h', 9)}${pad('lead h', 8)}${pad('yes/of', 12)}${pad('ans/of', 8)}${pad('touch', 7)}${pad('cost', 6)}irritated`);
    for (const { tl, s } of rows) {
      const yes = `${s.breadth.yes}/${s.breadth.of}${s.breadth.breadthFrom === 'room_talk' ? '*' : ''}`;
      console.log(`${pad(s.meetingId, 5)}${pad(s.room ? tl.groupId : '-', 6)}${pad(s.outcome + (s.dropOffered ? '+' : ''), 15)}${pad(s.total ?? '—', 7)}${pad(s.success ? '✓' : '', 4)}${pad(f1(s.speed.closeHours), 9)}${pad(f1(s.speed.leadHours), 8)}${pad(yes, 12)}${pad(`${s.answerRate.answered}/${s.answerRate.of}`, 8)}${pad(s.touches, 7)}${pad(s.cost, 6)}${s.irritation.length || ''}`);
    }
    console.log('\n  * yes counted from the room talking it through (hand-settle in a room)   + a drop offer came first');

    const closed = rows.filter((r) => r.s.outcome !== 'open');
    const summary = (label, set) => {
      if (!set.length) { console.log(`${label}: none`); return; }
      const by = (o) => set.filter((r) => r.s.outcome === o).length;
      console.log(`${label}: ${set.length} closed · confirmed ${by('confirmed')} · graceful ${by('graceful_exit')} · cancelled ${by('cancelled')} · expired ${by('expired')}`
        + ` · success ${set.filter((r) => r.s.success).length} · median score ${f1(median(set.map((r) => r.s.total)))}`
        + ` · median close ${f1(median(set.filter((r) => r.s.outcome === 'confirmed').map((r) => r.s.speed.closeHours)))}h`
        + ` · median answer rate ${f1(median(set.map((r) => 100 * r.s.answerRate.value)))}%`);
    };
    const closedAt = (r) => (r.tl.closedAt ? new Date(r.tl.closedAt).getTime() : 0);
    console.log('');
    summary('Baseline (closed before)', closed.filter((r) => closedAt(r) < SINCE));
    summary('Experiment (closed since)', closed.filter((r) => closedAt(r) >= SINCE));
    const counted = closed.filter((r) => r.s.room && r.s.success && closedAt(r) >= SINCE);
    console.log(`\nToward the goal: ${counted.length} of ${GOAL} — ${counted.map((r) => `#${r.s.meetingId}`).join(', ') || 'none yet'}`);

    // What each kind of touch was followed by, within the credit window.
    const fx = rows.flatMap((r) => r.fx);
    const kinds = new Map();
    for (const t of fx) {
      const k = `${t.channel}:${t.kind}`;
      if (!kinds.has(k)) kinds.set(k, []);
      kinds.get(k).push(t);
    }
    console.log('\nTouches — answered within 2h of it (room: anybody; private: the one it reached)');
    console.log(`${pad('channel:kind', 36)}${pad('n', 5)}${pad('moved', 8)}${pad('people', 8)}median min to first answer`);
    for (const [k, ts] of [...kinds].sort((a, b) => b[1].length - a[1].length)) {
      const moved = ts.filter((t) => t.answeredBy > 0).length;
      console.log(`${pad(k, 36)}${pad(ts.length, 5)}${pad(`${Math.round((100 * moved) / ts.length)}%`, 8)}${pad(ts.reduce((a, t) => a + t.answeredBy, 0), 8)}${f1(median(ts.filter((t) => t.answeredBy > 0).map((t) => t.firstAnswerMinutes)))}`);
    }

    // When a touch lands (Israel clock) against whether it moved anybody.
    const bucket = (iso) => {
      const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;
      return h < 9 ? '00-09' : h < 13 ? '09-13' : h < 17 ? '13-17' : h < 21 ? '17-21' : '21-24';
    };
    const hours = new Map();
    for (const t of fx) {
      const b = bucket(t.at);
      if (!hours.has(b)) hours.set(b, { n: 0, moved: 0 });
      hours.get(b).n += 1;
      if (t.answeredBy > 0) hours.get(b).moved += 1;
    }
    console.log('\nBy hour it landed (Israel)');
    for (const b of ['00-09', '09-13', '13-17', '17-21', '21-24']) {
      const h = hours.get(b);
      if (h) console.log(`${pad(b, 8)}${pad(h.n, 5)}${Math.round((100 * h.moved) / h.n)}% moved somebody`);
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
