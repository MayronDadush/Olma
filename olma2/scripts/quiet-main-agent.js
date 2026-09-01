#!/usr/bin/env node
// Stop the `main` agent from talking to real people.
//
// 2026-09-01: main emitted the literal text `NO_REPLY`, and its own auth
// failures, into a user's WhatsApp — twice in one minute, and on a ~30-minute
// cadence all night before that. Two conditions had to hold at once:
//
//   1. something WOKE main — the 2026.8.1 upgrade auto-created 36 cron jobs
//      (a `heartbeat` and a `skillCollectionReview` for every agent in the
//      roster, all with sessionTarget `main`). Nobody asked for them, and
//      Olma schedules everything in brokerd; the gateway `cron` tool is
//      denied to agents for exactly this reason.
//   2. main could DELIVER to a person — six leftover WhatsApp sessions from
//      the v1 era, when `--to <phone>` alone ran the turn on the default
//      agent.
//
// This script reports both and, with --disable-cron, removes the first. It
// deliberately does NOT delete sessions: dropping rows out of the gateway's
// own session store is the "second writer with the old schema in its head"
// mistake that cost a night already (see CLAUDE.md, agents.list). The
// sessions are reported so a person can decide.
//
// Usage:
//   node scripts/quiet-main-agent.js                 # report only
//   node scripts/quiet-main-agent.js --disable-cron  # disable main's wakeups
'use strict';
const { execFile } = require('node:child_process');
const { createPool } = require('../src/db/pool');
const { deliverableInfraSessions } = require('../src/domain/infra-agent');

const DISABLE = process.argv.includes('--disable-cron');
// Payload kinds the gateway creates for itself. An `agentTurn` job is
// something a person set up on purpose and is never touched here.
const AUTO_KINDS = new Set(['heartbeat', 'skillCollectionReview']);
const CLI_TIMEOUT_MS = 30_000;

// Bounded on purpose: `openclaw config set` is documented to hang forever
// after a successful write, and a script that wedges is worse than one that
// reports a timeout and moves on.
function openclaw(args) {
  return new Promise((resolve) => {
    execFile('openclaw', args, { timeout: CLI_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({
        ok: !err, stdout: stdout || '', stderr: stderr || '', error: err ? err.message : null,
      }));
  });
}

async function listCron() {
  const r = await openclaw(['cron', 'list', '--json', '--timeout', String(CLI_TIMEOUT_MS)]);
  if (!r.ok) return { error: r.error || r.stderr.trim() };
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return { error: 'cron list returned unparseable JSON' }; }
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || parsed.data || []);
  return { jobs: Array.isArray(jobs) ? jobs : [] };
}

(async () => {
  const pool = createPool();

  const { jobs, error } = await listCron();
  if (error) {
    console.log(`cron: could not be read (${error})`);
  } else {
    const targeting = jobs.filter((j) => j.sessionTarget === 'main' && j.enabled !== false);
    const auto = targeting.filter((j) => AUTO_KINDS.has((j.payload || {}).kind));
    const other = targeting.filter((j) => !AUTO_KINDS.has((j.payload || {}).kind));

    console.log(`cron: ${jobs.length} automations, ${targeting.length} enabled and targeting main`);
    for (const j of other) {
      console.log(`  · leaving alone (not gateway-auto): ${j.name || j.id} [${(j.payload || {}).kind}]`);
    }
    console.log(`  ${DISABLE ? '→' : '·'} ${auto.length} auto-created wakeups`
      + (DISABLE ? '' : ' — pass --disable-cron to disable them'));

    if (DISABLE) {
      let done = 0; const failed = [];
      for (const j of auto) {
        const r = await openclaw(['cron', 'disable', j.id, '--timeout', String(CLI_TIMEOUT_MS)]);
        if (r.ok) done++;
        else failed.push(`${j.name || j.id}: ${r.error || r.stderr.trim()}`);
      }
      console.log(`     disabled ${done}/${auto.length}`);
      for (const f of failed) console.log(`     ! ${f}`);
    }
  }

  // The half that bounds everything else, reported either way.
  const found = await deliverableInfraSessions(pool, {});
  console.log(`\nsessions: main holds ${found.length} delivery-capable session(s) to active users`);
  for (const f of found) console.log(`  ! ${f.channel}:${f.peer} (user ${f.userId}) — ${f.key}`);
  if (found.length) {
    console.log('  these are not removed here — dropping rows from the gateway session store');
    console.log('  needs a person deciding, not a script (see the header).');
  }

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
