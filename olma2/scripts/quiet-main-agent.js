#!/usr/bin/env node
// Stop the `main` agent from talking to real people.
//
// 2026-09-01: main emitted the literal text `NO_REPLY`, and its own auth
// failures, into a user's WhatsApp — twice in one minute, and on a ~30-minute
// cadence all night before that. Two conditions had to hold at once:
//
//   1. something WOKE main — the 2026.8.1 upgrade auto-created 36 cron jobs
//      (a `heartbeat` and a `skillCollectionReview` per agent in the roster,
//      all with sessionTarget `main`).
//   2. main could DELIVER to a person — six leftover WhatsApp sessions from
//      the v1 era, when `--to <phone>` alone ran the turn on the default
//      agent.
//
// ONLY THE SECOND IS ACTIONABLE, and that was established by trying the
// first. `openclaw cron disable <id>` refuses every one of the 36:
//
//     "system-owned monitor jobs cannot be edited by cron clients"
//
// They are the gateway's own monitors, not ours to switch off, and a future
// upgrade can add more of them. So the session is not merely the better
// lever — it is the only one, which is also why it is the right one: it
// bounds anything that wakes main, including whatever comes next.
//
// Archiving goes through `openclaw sessions archive`, i.e. through the
// RUNNING GATEWAY, never by writing to its sqlite ourselves. Being a second
// writer to that store with the old schema in mind is what `agents.list`
// already cost a night for.
//
// Usage:
//   node scripts/quiet-main-agent.js              # report + archive dry-run
//   node scripts/quiet-main-agent.js --apply      # archive for real
'use strict';
const { execFile } = require('node:child_process');
const { createPool } = require('../src/db/pool');
const { deliverableInfraSessions } = require('../src/domain/infra-agent');

const APPLY = process.argv.includes('--apply');
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

async function reportCron() {
  const r = await openclaw(['cron', 'list', '--json', '--timeout', String(CLI_TIMEOUT_MS)]);
  if (!r.ok) return console.log(`cron: could not be read (${r.error || r.stderr.trim()})`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { return console.log('cron: unparseable JSON'); }
  const jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || parsed.data || []);
  const auto = jobs.filter((j) => j.sessionTarget === 'main' && j.enabled !== false
    && AUTO_KINDS.has((j.payload || {}).kind));
  console.log(`cron: ${auto.length} gateway-owned wakeups target main`);
  console.log('  (not disableable — the gateway refuses: "system-owned monitor');
  console.log('   jobs cannot be edited by cron clients". Context only.)');
}

(async () => {
  const pool = createPool();
  await reportCron();

  const found = await deliverableInfraSessions(pool, {});
  console.log(`\nsessions: main holds ${found.length} delivery-capable session(s) to active users`);
  for (const f of found) console.log(`  ! ${f.channel}:${f.peer} (user ${f.userId}) — ${f.key}`);

  if (found.length) {
    // One call, all keys: the CLI takes several, and archiving them as a set
    // means a partial failure is visible per key rather than leaving the job
    // half done across separate invocations.
    const args = ['sessions', 'archive', ...found.map((f) => f.key),
      '--agent', 'main', '--json', '--timeout', String(CLI_TIMEOUT_MS)];
    if (!APPLY) args.push('--dry-run');
    const r = await openclaw(args);
    console.log(`\n${APPLY ? 'archiving' : 'dry run'}: ${r.ok ? 'ok' : 'FAILED'}`);
    console.log((r.stdout || r.stderr || r.error || '').trim().slice(0, 1500));
    if (!APPLY) console.log('\npass --apply to archive for real');
  }

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
