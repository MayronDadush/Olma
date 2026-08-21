#!/usr/bin/env node
// Go back for someone whose stated goal was dropped before the fixes landed.
//
// Re-opens the conversation read-back so the goal is captured in their own
// words, and queues ONE message asking Olma to pick it up with them. The
// delivery gate holds that message until their own waking window opens, so it
// is safe to run this at any hour.
//
// Usage:
//   node scripts/repair-missed-goal.js --phone 0505404255 --note "למכור 3 מהרכבים" [--apply]
//
// Dry run by default. Re-running on the same day is a no-op.
'use strict';
const { createPool, withTx } = require('../src/db/pool');
const repair = require('../src/domain/repair');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
}

const phone = arg('phone');
const note = arg('note');
const APPLY = process.argv.includes('--apply');

if (!phone || !note) {
  console.error('usage: repair-missed-goal.js --phone <number> --note "<the goal, in their words>" [--apply]');
  process.exit(1);
}

(async () => {
  const pool = createPool();
  const preview = await withTx(pool, (c) => repair.previewGoalRepair(c, phone));
  if (!preview.ok) {
    console.error(`${preview.error.code}: ${preview.error.message}`);
    if (preview.error.candidates) console.error('  candidates:', preview.error.candidates.join(', '));
    await pool.end();
    process.exit(1);
  }

  const { user, openTasks } = preview.data;
  console.log(`user ${user.id} ${user.phone} (${user.first_name || 'no name'}) status=${user.status}`);
  console.log(`  timezone=${user.timezone || 'NULL'} open tasks=${openTasks} checkin_misses=${user.checkin_misses}`);
  console.log(`  last inbound: ${user.last_inbound_at || 'never'}`);
  console.log(`  last read-back: ${user.last_fact_extraction_at || 'never'}`);
  console.log('\nwould:');
  console.log('  1. clear last_fact_extraction_at → the next read-back tick re-reads their');
  console.log('     recent conversation and saves the goal in their own words');
  console.log('  2. queue one check-in, held by the gate until their window opens:\n');
  console.log(repair.buildInstruction(note).split('\n').map((l) => `     ${l}`).join('\n'));

  if (!APPLY) {
    console.log('\ndry run — pass --apply to write');
    await pool.end();
    return;
  }

  const res = await withTx(pool, (c) => repair.repairMissedGoal(c, user.id, { note }));
  if (!res.ok) {
    console.error(`\n${res.error.code}: ${res.error.message}`);
    await pool.end();
    process.exit(1);
  }
  console.log(res.data.enqueued
    ? `\ndone — outbox #${res.data.outboxId}, eligible from ${res.data.releaseAfter} and then held until their window opens`
    : '\nalready repaired today — nothing queued twice');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
