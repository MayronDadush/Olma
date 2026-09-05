'use strict';
// scripts/backup-offbox.sh is the only copy of the database that leaves the
// droplet, it runs unattended from root's crontab, and its failure modes are
// silent in the way that matters most: an upload that "succeeded" but was
// truncated, or a cron that stopped, both look like a green row until the day
// a restore is needed. So it is driven here as a real script, against a real
// job_heartbeats table and a fake s3cmd that keeps a bucket in a text file —
// the heartbeat is the product, and this is where it is shown to be honest.
//
// Needs `psql` on PATH (the script writes its heartbeat through it). CI's
// ubuntu image ships it; a machine without it skips loudly rather than
// passing vacuously.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshDb } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup-offbox.sh');
const HAVE_PSQL = (() => {
  try { execFileSync('psql', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.teardown(); });

// A stand-in s3cmd. Records every invocation to FAKE_S3_LOG and keeps the
// bucket as `key<TAB>size` lines in FAKE_S3_STATE, answering `ls` in the real
// tool's four-column shape (date time size key) because the script parses
// exactly that. FAKE_S3_CORRUPT=1 makes `put` store one byte short — the
// truncated-upload case the verify step exists for.
const FAKE_S3CMD = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_S3_LOG"
args=()
for a in "$@"; do case "$a" in --*) ;; *) args+=("$a");; esac; done
case "\${args[0]}" in
  put)
    size=$(wc -c < "\${args[1]}" | tr -d ' ')
    [ -n "\${FAKE_S3_CORRUPT:-}" ] && size=$((size - 1))
    printf '%s\\t%s\\n' "\${args[2]}" "$size" >> "$FAKE_S3_STATE" ;;
  ls)
    while IFS=$'\\t' read -r key size; do
      case "$key" in "\${args[1]}"*) printf '2026-01-01 00:00 %10s   %s\\n' "$size" "$key";; esac
    done < "$FAKE_S3_STATE" ;;
  del)
    grep -v "^\${args[1]}	" "$FAKE_S3_STATE" > "$FAKE_S3_STATE.tmp" || true
    mv "$FAKE_S3_STATE.tmp" "$FAKE_S3_STATE" ;;
  *) echo "fake s3cmd: unknown command \${args[0]}" >&2; exit 2 ;;
esac
`;

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

// One isolated world per test: its own env file, dump dir, fake bucket and
// PATH. Nothing here touches a directory another test file reads.
function world({ configured = true, dumps = [today()], bucket = [], corrupt = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olma-offbox-'));
  const bin = path.join(dir, 'bin');
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(bin); fs.mkdirSync(backups);
  fs.writeFileSync(path.join(bin, 's3cmd'), FAKE_S3CMD, { mode: 0o755 });
  const env = [`OLMA_DB_URL=${db.url}`];
  if (configured) env.push('SPACES_KEY=k', 'SPACES_SECRET="s"', "SPACES_BUCKET='olma-backups'", 'SPACES_REGION=fra1');
  fs.writeFileSync(path.join(dir, 'env'), env.join('\n') + '\n');
  for (const d of dumps) fs.writeFileSync(path.join(backups, `olma2-${d}.sql.gz`), `dump-${d}-` + 'x'.repeat(100));
  const state = path.join(dir, 'bucket');
  fs.writeFileSync(state, bucket.map(([k, s]) => `${k}\t${s}`).join('\n') + (bucket.length ? '\n' : ''));
  const log = path.join(dir, 's3.log');
  fs.writeFileSync(log, '');
  return { dir, backups, state, log, corrupt };
}

function run(w, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${path.join(w.dir, 'bin')}:${process.env.PATH}`,
    OLMA_ENV_FILE: path.join(w.dir, 'env'),
    OLMA_BACKUP_DIR: w.backups,
    OLMA_OFFBOX_KEEP_DAYS: '30',
    FAKE_S3_STATE: w.state,
    FAKE_S3_LOG: w.log,
    ...(w.corrupt ? { FAKE_S3_CORRUPT: '1' } : {}),
    ...extraEnv,
  };
  try {
    return { status: 0, out: execFileSync('bash', [SCRIPT], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { status: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
}

const bucketKeys = (w) => fs.readFileSync(w.state, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
const s3calls = (w) => fs.readFileSync(w.log, 'utf8').split('\n').filter(Boolean);

async function heartbeat() {
  const { rows } = await db.pool.query(
    `SELECT last_run_at, last_ok_at, note FROM job_heartbeats WHERE job_name = 'backup_offbox'`);
  return rows[0] || null;
}
const clearBeat = () => db.pool.query(`DELETE FROM job_heartbeats WHERE job_name = 'backup_offbox'`);

test('a fresh dump is uploaded privately, verified, and stamps a green heartbeat', { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const w = world();
  const r = run(w);
  assert.equal(r.status, 0, r.err);

  const key = `s3://olma-backups/olma2/olma2-${today()}.sql.gz`;
  assert.deepEqual(bucketKeys(w), [key]);
  const put = s3calls(w).find((c) => c.includes(' put '));
  assert.ok(put, 'one put happened');
  assert.ok(!put.includes('--acl-public'), 'the object is never made public');
  assert.ok(put.includes('--host=fra1.digitaloceanspaces.com'), 'region decides the host');

  const hb = await heartbeat();
  assert.ok(hb && hb.last_ok_at, 'last_ok_at stamped');
  assert.match(hb.note, /^uploaded olma2-\d{4}-\d{2}-\d{2}\.sql\.gz \d+B/);
});

test('no dump tonight is a red heartbeat, not a quiet exit', { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const w = world({ dumps: [] });
  const r = run(w);
  assert.notEqual(r.status, 0);
  const hb = await heartbeat();
  assert.ok(hb, 'the failure was recorded');
  assert.equal(hb.last_ok_at, null, 'nothing pretends to have succeeded');
  assert.match(hb.note, /^ERR no dump found/);
  assert.deepEqual(bucketKeys(w), [], 'nothing was uploaded');
});

test("yesterday's dump is stale, not tonight's backup", { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const w = world({ dumps: [daysAgo(3)] });
  // The name says three days ago; make the file's mtime agree.
  const old = new Date(Date.now() - 3 * 86400_000);
  fs.utimesSync(path.join(w.backups, `olma2-${daysAgo(3)}.sql.gz`), old, old);
  const r = run(w);
  assert.notEqual(r.status, 0);
  assert.match((await heartbeat()).note, /^ERR newest dump is older/);
});

test('missing SPACES_* keys is an explicit "not configured" red, never a silent skip', { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const w = world({ configured: false });
  const r = run(w);
  assert.notEqual(r.status, 0);
  const hb = await heartbeat();
  assert.match(hb.note, /^ERR not configured: SPACES_KEY/);
  assert.deepEqual(s3calls(w), [], 's3cmd was never called');
});

test('an upload the bucket does not confirm byte-for-byte is a failure', { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const w = world({ corrupt: true });
  const r = run(w);
  assert.notEqual(r.status, 0);
  const hb = await heartbeat();
  assert.equal(hb.last_ok_at, null);
  assert.match(hb.note, /^ERR bucket does not confirm the upload: local \d+B, remote '\d+'/);
});

test('copies older than the retention window are pruned; recent ones and foreign keys are kept', { skip: !HAVE_PSQL && 'psql not on PATH' }, async () => {
  await clearBeat();
  const stale = `s3://olma-backups/olma2/olma2-${daysAgo(45)}.sql.gz`;
  const recent = `s3://olma-backups/olma2/olma2-${daysAgo(5)}.sql.gz`;
  const foreign = 's3://olma-backups/olma2/notes.txt';
  const w = world({ bucket: [[stale, 100], [recent, 100], [foreign, 5]] });
  const r = run(w);
  assert.equal(r.status, 0, r.err);
  const keys = bucketKeys(w);
  assert.ok(!keys.includes(stale), 'the 45-day-old copy is gone');
  assert.ok(keys.includes(recent), 'the 5-day-old copy stays');
  assert.ok(keys.includes(foreign), 'a key that is not a dump is never touched');
  assert.match((await heartbeat()).note, /pruned 1 older than 30d/);
});

test('the job is on the board: a daily cadence, never armed in-process', () => {
  const { JOB_INTERVAL_SECONDS, shouldKickOnStart, isStale } = require('../src/jobs/expectations');
  assert.equal(JOB_INTERVAL_SECONDS.backup_offbox, 86400);
  assert.equal(shouldKickOnStart('backup_offbox'), true, 'the cadence table treats it like any slow job');
  // Three days without a copy is stale on the same rule as every sweep.
  assert.equal(isStale('backup_offbox', new Date(Date.now() - 4 * 86400_000)), true);
  assert.equal(isStale('backup_offbox', new Date(Date.now() - 86400_000)), false);
  // brokerd must never arm it — it would then write a green beat for a copy
  // the daemon never made.
  const brokerd = fs.readFileSync(path.join(__dirname, '..', 'bin', 'olma-brokerd.js'), 'utf8');
  assert.ok(!brokerd.includes("'backup_offbox'"), 'not armed by brokerd');
});
