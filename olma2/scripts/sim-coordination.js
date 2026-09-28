#!/usr/bin/env node
// Which room-coordination policy to TRY (owner, 2026-09-28). Runs the current
// policy and a grid of alternatives over the same simulated rooms
// (`src/sim/coordination-sim.js`), scored by the same function as the real
// ones (`domain/coordination-score`). Touches no database and sends nothing.
//
//   node scripts/sim-coordination.js              # 1000 rooms per policy
//   node scripts/sim-coordination.js --rooms 3000
'use strict';
const { CURRENT, runPolicy } = require('../src/sim/coordination-sim');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}
const ROOMS = Number(arg('rooms', 1000)) || 1000;

const grid = [CURRENT];
for (const nudge of [null, 3, 6, 12]) {
  for (const second of [null, 12]) {
    for (const drop of [null, 12, 24]) {
      if (nudge === null && second === null && drop === null) continue;
      grid.push({
        name: `nudge ${nudge ?? '-'} · chase2 ${second ?? '-'} · drop ${drop ?? '-'}`,
        roomChaseAfterH: 1, secondRoomChaseAfterH: second, privateNudgeAfterH: nudge,
        dropOfferAfterQuietH: drop, dropGraceH: 6,
      });
    }
  }
}

const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
const rows = grid.map((p) => ({ p, s: runPolicy(p, { rooms: ROOMS }) }))
  .sort((a, b) => b.s.success - a.s.success || b.s.meanScore - a.s.meanScore);
console.log(`Simulated ${ROOMS} rooms per policy, the same rooms for every one.\n`);
console.log(`${'policy'.padEnd(38)}success confirm graceful wrongdrop expired score irritated msgs  close h`);
for (const { p, s } of rows) {
  console.log(`${(p.name === 'current' ? '▶ current (today)' : p.name).padEnd(38)}${pct(s.success)}   ${pct(s.confirmed)}   ${pct(s.graceful)}   ${pct(s.wrongDrop)}     ${pct(s.expired)}  ${s.meanScore.toFixed(2)}  ${pct(s.irritated)}   ${s.messages.toFixed(1).padStart(4)}  ${s.medianCloseH == null ? '—' : s.medianCloseH.toFixed(1)}`);
}
