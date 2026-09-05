#!/usr/bin/env bash
# Copy the newest nightly pg_dump OFF the droplet, into a DigitalOcean Spaces
# bucket, and say so in job_heartbeats.
#
# The dump itself is root's crontab (02:15 Asia/Jerusalem, `pg_dump olma2 |
# gzip > /root/backups/olma2-<date>.sql.gz`, 14-day local retention). Until
# this script existed every copy of the database lived on the one disk it
# backs up, so a lost droplet was a lost database. This runs a few minutes
# after the dump and is the only off-box copy there is.
#
# Reporting is the point, not the upload. A backup that silently stops is
# worse than none — it is a promise. So every outcome lands in job_heartbeats
# under `backup_offbox`: success stamps last_ok_at, any failure writes an
# `ERR …` note (which /health and the dashboard already treat as red), and
# jobs/expectations.js lists this job at a daily cadence so a copy that
# simply never runs goes stale on the same board as every sweep.
#
# Fails LOUDLY on: unreadable env, missing s3cmd, missing SPACES_* keys, no
# fresh dump, an upload the bucket does not confirm byte-for-byte. Pruning
# old copies is best-effort and never fails the run — a full bucket is a cost
# problem, and failing a healthy backup over it would be the alarm
# overstating itself (same rule as prune-releases.sh in deploy.sh).
#
# Config, all read from the env file (never from the environment, so a stray
# shell variable cannot point a cron job at the wrong bucket):
#   OLMA_DB_URL       — where the heartbeat is written (already present)
#   SPACES_KEY        — Spaces access key
#   SPACES_SECRET     — Spaces secret
#   SPACES_BUCKET     — bucket name, must be PRIVATE (the dump holds encrypted
#                       credentials; see domain/crypto-store.js)
#   SPACES_REGION     — e.g. fra1 (the host is <region>.digitaloceanspaces.com)
#
# Overrides, for the test suite only:
#   OLMA_ENV_FILE, OLMA_BACKUP_DIR, OLMA_OFFBOX_KEEP_DAYS, OLMA_OFFBOX_PREFIX
#
# Cron line (root, after the dump):
#   40 2 * * * bash /opt/olma2/scripts/backup-offbox.sh >> /var/log/olma2-backup-offbox.log 2>&1
set -euo pipefail

ENV_FILE="${OLMA_ENV_FILE:-/opt/olma2/.env}"
BACKUP_DIR="${OLMA_BACKUP_DIR:-/root/backups}"
KEEP_DAYS="${OLMA_OFFBOX_KEEP_DAYS:-30}"
PREFIX="${OLMA_OFFBOX_PREFIX:-olma2}"
# A dump older than this is yesterday's: uploading it again would report a
# backup that did not happen tonight.
MAX_DUMP_AGE_MIN=$((36 * 60))
JOB=backup_offbox

log() { echo "[backup-offbox] $*"; }

# KEY → value from ENV_FILE. Tolerates `export KEY=`, and one layer of quotes.
envget() {
  local line
  line=$(grep -E "^(export )?$1=" "$ENV_FILE" 2>/dev/null | tail -1 || true)
  line=${line#export }
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

# ---- heartbeat ---------------------------------------------------------------
# psql's :'var' does the quoting, so a note can hold anything. The note is cut
# to 200 chars because that is what the column's readers expect (dashboard).
DB_URL=""
[ -r "$ENV_FILE" ] && DB_URL=$(envget OLMA_DB_URL)

beat() { # beat ok|err "<note>"
  local kind=$1 note=${2:0:200}
  if [ -z "$DB_URL" ]; then
    log "no OLMA_DB_URL in $ENV_FILE — heartbeat not written"
    return 0
  fi
  local sql
  if [ "$kind" = ok ]; then
    sql="INSERT INTO job_heartbeats (job_name, last_run_at, last_ok_at, note)
         VALUES ('$JOB', now(), now(), :'note')
         ON CONFLICT (job_name) DO UPDATE SET last_run_at = now(), last_ok_at = now(), note = EXCLUDED.note"
  else
    sql="INSERT INTO job_heartbeats (job_name, last_run_at, note)
         VALUES ('$JOB', now(), :'note')
         ON CONFLICT (job_name) DO UPDATE SET last_run_at = now(), note = EXCLUDED.note"
  fi
  # Over stdin, not `-c`: psql does not interpolate :'var' inside -c strings
  # (measured: "syntax error at or near :"), it only does so for script input.
  printf '%s\n' "$sql" | psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -v note="$note" \
    || log "heartbeat write failed"
}

FAIL_NOTE=""
fail() {
  FAIL_NOTE="ERR $1"
  log "$FAIL_NOTE" >&2
  exit 1
}
# Any non-zero exit — a fail() above or an unexpected error under `set -e` —
# becomes an ERR note, so the dashboard never shows a stale green for a run
# that died halfway.
trap 'rc=$?; if [ $rc -ne 0 ]; then beat err "${FAIL_NOTE:-ERR exited $rc}"; fi' EXIT

# ---- preconditions -------------------------------------------------------------
[ -r "$ENV_FILE" ] || fail "env file unreadable: $ENV_FILE"
command -v s3cmd >/dev/null 2>&1 || fail "s3cmd not installed (apt install s3cmd)"
command -v psql >/dev/null 2>&1 || fail "psql not installed"

KEY=$(envget SPACES_KEY)
SECRET=$(envget SPACES_SECRET)
BUCKET=$(envget SPACES_BUCKET)
REGION=$(envget SPACES_REGION)
[ -n "$KEY" ] && [ -n "$SECRET" ] && [ -n "$BUCKET" ] && [ -n "$REGION" ] \
  || fail "not configured: SPACES_KEY/SPACES_SECRET/SPACES_BUCKET/SPACES_REGION missing in $ENV_FILE"
HOST="$REGION.digitaloceanspaces.com"

# ---- the dump to copy ------------------------------------------------------------
# Names carry the date (olma2-YYYY-MM-DD.sql.gz), so lexicographic order is
# chronological order — the same trick prune-releases.sh relies on.
DUMP=$(ls -1 "$BACKUP_DIR"/olma2-*.sql.gz 2>/dev/null | sort | tail -1 || true)
[ -n "$DUMP" ] || fail "no dump found in $BACKUP_DIR"
[ -s "$DUMP" ] || fail "dump is empty: $DUMP"
[ -n "$(find "$DUMP" -mmin "-$MAX_DUMP_AGE_MIN" 2>/dev/null)" ] \
  || fail "newest dump is older than ${MAX_DUMP_AGE_MIN}m, tonight's did not run: $DUMP"
NAME=$(basename "$DUMP")
SIZE=$(wc -c < "$DUMP" | tr -d ' ')

# ---- upload + verify -----------------------------------------------------------
# No --acl-public, ever: the default is private and the bucket must stay so.
s3() {
  s3cmd --access_key="$KEY" --secret_key="$SECRET" \
        --host="$HOST" --host-bucket="%(bucket)s.$HOST" --no-progress "$@"
}
DEST="s3://$BUCKET/$PREFIX/$NAME"
s3 put "$DUMP" "$DEST" >/dev/null || fail "upload failed: $NAME"

# `s3cmd ls` prints: <date> <time> <size> <key>. Trust the bucket's own
# answer, never the put's exit code: a truncated object is the one failure
# that looks like success until the day it is restored.
REMOTE_SIZE=$(s3 ls "$DEST" | awk -v k="$DEST" '$NF == k { print $3 }' | tail -1)
[ "$REMOTE_SIZE" = "$SIZE" ] \
  || fail "bucket does not confirm the upload: local ${SIZE}B, remote '${REMOTE_SIZE:-missing}' for $NAME"
log "uploaded $NAME (${SIZE}B) to $DEST"

# ---- prune old copies (best effort) ------------------------------------------------
# Cutoff as a YYYY-MM-DD string, compared against the date in each key's
# name. GNU date first, BSD date second, so the suite can run on a Mac.
CUTOFF=$(date -u -d "-${KEEP_DAYS} days" +%F 2>/dev/null || date -u -v-"${KEEP_DAYS}"d +%F 2>/dev/null || true)
PRUNED=0
if [ -n "$CUTOFF" ]; then
  while read -r key; do
    [ -n "$key" ] || continue
    day=$(basename "$key" | sed -nE 's/^olma2-([0-9]{4}-[0-9]{2}-[0-9]{2})\.sql\.gz$/\1/p')
    [ -n "$day" ] || continue
    if [[ "$day" < "$CUTOFF" ]]; then
      if s3 del "$key" >/dev/null; then PRUNED=$((PRUNED + 1)); else log "warn: could not delete $key"; fi
    fi
  done < <(s3 ls "s3://$BUCKET/$PREFIX/" 2>/dev/null | awk '{ print $NF }' || true)
else
  log "warn: could not compute a prune cutoff on this system; nothing pruned"
fi
log "pruned $PRUNED copies older than ${KEEP_DAYS} days"

beat ok "uploaded $NAME ${SIZE}B; pruned $PRUNED older than ${KEEP_DAYS}d"
