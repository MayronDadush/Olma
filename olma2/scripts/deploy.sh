#!/usr/bin/env bash
# Sync olma2/ to the server, install deps, migrate, run the full test suite.
# Tests run on the server because that's where Postgres and Node 24 live.
# Usage: bash olma2/scripts/deploy.sh [--restart]
#   SSH_KEY env var overrides the key path (defaults to ~/.ssh/id_ed25519) —
#   lets CI point at a temp key file instead of a dev machine's own key.
#   --restart additionally restarts olma2-brokerd/olma2-dashboard once the
#   remote test suite passes, then pushes the deployed agents-template.md into
#   every existing user's workspace (see resync_templates below); omitted by
#   default so local runs keep the existing manual-restart workflow. With
#   --restart, a failed post-restart health check automatically rolls the CODE
#   back to the previous release (see roll_back below) — this does NOT undo DB
#   migrations; keep them additive/backward-compatible, since a migration that
#   already ran stays applied even after a code rollback.
#
# Every deploy also archives the outgoing release to /opt/olma2-releases/<utc
# stamp>/ and keeps the newest 5 (OLMA_RELEASES_KEEP). That archive is for the
# case the automatic rollback cannot serve — a fault noticed days and several
# merges later. Use scripts/rollback.sh to list it and to go back to one.
set -euo pipefail

RESTART=0
for arg in "$@"; do
  [ "$arg" = "--restart" ] && RESTART=1
done

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma2"
BACKUP="/opt/olma2-previous"
ARCHIVE="${OLMA_RELEASES_DIR:-/opt/olma2-releases}"
KEEP="${OLMA_RELEASES_KEEP:-5}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# ServerAlive is load-bearing, not hygiene. The remote suite goes SILENT for
# minutes when node's test runner wedges (scripts/run-suite.sh documents the
# deadlock), and a silent connection through the runner's NAT is dropped at a
# fixed ~4m20s — measured twice on 2026-09-04, both deploys dying with
# `client_loop: send disconnect: Broken pipe` and exit 255 after exactly that
# gap. run-suite.sh is built to kill and retry a wedge at SUITE_TIMEOUT=420,
# but it never got the chance: the pipe died first, so the retry logic was
# unreachable and the deploy failed on a wedge it was designed to survive.
#
# 30s x 20 tolerates ten minutes of silence — comfortably past SUITE_TIMEOUT,
# so the wrapper's own timeout is what fires, which is the design. Raise this
# if SUITE_TIMEOUT ever goes above ten minutes; the two numbers are a pair.
SSH="ssh -i $SSH_KEY -o ServerAliveInterval=30 -o ServerAliveCountMax=20"

# Snapshot the currently-deployed release (code + its own node_modules) as a
# complete standalone copy BEFORE the new rsync overwrites anything, so a bad
# deploy has something real to roll back to. Skipped on the very first deploy
# (DEST doesn't exist yet). One snapshot is kept, not a history.
#
# This line is deliberately UNCHANGED by the release archive below. It is the
# path the automatic post-restart rollback takes, at the worst possible moment,
# with nobody watching — so it stays the simplest thing that works, with no
# dependency on a stamp being parseable or an archive directory existing.
# The archive is strictly additive: a second copy, for the case the automatic
# one cannot serve.
$SSH "$SERVER" "[ -d $DEST ] && rm -rf $BACKUP && cp -a $DEST $BACKUP || true"

# ...and the same snapshot, kept by date this time.
#
# `/opt/olma2-previous` is exactly one release deep and is overwritten by every
# deploy, so it answers "undo the deploy that just happened" and nothing else.
# On a day with five merges it holds the fourth — a fault noticed the next
# morning has no fast way back, and the operator is left doing `git revert`,
# which first requires knowing WHICH merge to revert. Going back to a release
# that is known to have worked does not require that diagnosis, which is the
# whole point: the fast path should work when you do not yet know what broke.
#
# Stamped from the SERVER's clock, in UTC, because deploys come from both a Mac
# and a GitHub runner and a release archive sorted by two different clocks is
# worse than no archive. ISO-8601 with `-` for `:` (a colon is legal in a
# Linux path but a menace in every tool that touches one), so lexicographic
# order IS chronological order — see prune-releases.sh.
STAMP=$($SSH "$SERVER" "date -u +%Y-%m-%dT%H-%M-%SZ")
$SSH "$SERVER" "
  set -euo pipefail
  if [ -d $DEST ]; then
    mkdir -p $ARCHIVE
    dir=$ARCHIVE/$STAMP
    # Two deploys inside one second is not a thing that happens on a serialized
    # main queue, but a suffix costs nothing and a silent overwrite of the last
    # known-good release costs everything.
    n=1; while [ -e \"\$dir\" ]; do dir=$ARCHIVE/$STAMP-\$n; n=\$((n + 1)); done
    cp -a $DEST \"\$dir\"
    echo \"archived the outgoing release to \$dir\"
  fi
"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '*.log' --exclude run \
  -e "$SSH" \
  "$SRC_DIR/" "$SERVER:$DEST/"

# What that snapshot actually CONTAINS, written into the live tree right after
# the sync. It rides into the archive on the next deploy, which is the only way
# a dated directory becomes an identifiable release rather than a timestamp.
#
# Deliberately NOT rsync-excluded: --delete removes it and this rewrites it. A
# marker that survives a failed deploy would describe the wrong code, and a
# marker that describes the wrong code is worse than none — the reader would
# roll back to something other than what they read. Missing reads as "unknown",
# which is honest and which rollback.sh prints as such.
#
# base64 so a commit subject containing quotes, backticks or a newline cannot
# reach the remote shell as anything but data.
SHA=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
SUBJECT=$(git -C "$SRC_DIR" log -1 --format=%s 2>/dev/null || echo unknown)
ORIGIN="${GITHUB_RUN_ID:+github-actions run $GITHUB_RUN_ID}"
MARKER=$(printf 'sha=%s\nsubject=%s\ndeployed_at=%s\norigin=%s\n' \
  "$SHA" "$SUBJECT" "$STAMP" "${ORIGIN:-local $(whoami)@$(hostname)}" | base64 | tr -d '\n')
$SSH "$SERVER" "printf %s '$MARKER' | base64 -d > $DEST/RELEASE"

# Prune AFTER the rsync, because the rsync is what puts the current
# prune-releases.sh on the box — the deploy prunes with the retention logic it
# is deploying, not with whatever version happened to be there. Never fatal: a
# full archive is a disk problem, and failing a healthy deploy over one would
# be the alarm overstating itself. Loud either way, including on success,
# because a prune that goes quiet is indistinguishable from a prune that never
# ran.
$SSH "$SERVER" "bash $DEST/scripts/prune-releases.sh $ARCHIVE $KEEP" \
  || echo "WARNING: release-archive prune failed — check disk on $ARCHIVE." >&2

$SSH "$SERVER" "
  set -euo pipefail
  cd $DEST
  set -a; [ -f .env ] && . ./.env; set +a
  npm install --no-audit --no-fund --loglevel=error
  node src/db/migrate.js
  # The droplet has ONE core. Node's default is unlimited file concurrency,
  # which on this box means 11 test processes plus 11 Postgres databases
  # thrashing each other into timeouts that look like real failures.
  # nice: the same core is serving live agent turns; the suite yields to them.
  # (Observed 2026-08-27: an unniced run during a busy drain starved live
  # turns until the gateway texted users raw error strings.)
  # Via run-suite.sh so a wedged runner retries instead of hanging the deploy
  # until the job timeout. Two attempts, not three: a retry here costs the live
  # box seven more minutes of a shared single core, so the third roll of the
  # dice is not worth what it takes from users.
  SUITE_NICE=19 SUITE_CONCURRENCY=2 SUITE_ATTEMPTS=2 SUITE_TIMEOUT=420 bash scripts/run-suite.sh
"

# Passes iff both services are actually running (catches an instant crash —
# syntax error, missing dep, a migration the app itself trips on that the
# test suite didn't) AND the dashboard's /ready responds — DB reachability
# plus a fresh brokerd heartbeat, see adapters/http/dashboard.js.
# "tests passed in CI" never proves the live process came up; this does.
#
# Deliberately /ready and NOT /health. /health also goes 503 when any sweep is
# behind its cadence — a fact about the process that was just replaced, which
# no amount of restarting or rolling back can change within the five seconds
# this gate allows. Gating on it turned one late sweep into "every deploy
# fails, rolls back, and reports the rollback as broken too" (2026-08-22, two
# consecutive merges to main). /health stays as the monitoring endpoint.
health_ok() {
  $SSH "$SERVER" '
    systemctl is-active --quiet olma2-brokerd &&
    systemctl is-active --quiet olma2-dashboard &&
    curl -fsS -o /dev/null http://127.0.0.1:8788/ready
  '
}

# AGENTS.md is written into a workspace once, at provisioning, so every
# doctrine change reaches NEW users only — the people already using Olma keep
# whatever text existed on the day they joined. That made every doctrine fix
# depend on somebody remembering a second manual command, and a step that is
# only ever remembered is a step that is eventually forgotten. It is part of
# the deploy now.
#
# Safe to run every time: the script compares content and skips workspaces
# already current, and it rewrites AGENTS.md only — never USER.md or MEMORY.md,
# which hold real accumulated content about the person.
#
# It derives what to write from the template in the CURRENTLY DEPLOYED tree, so
# calling it after a rollback puts the OLD doctrine back just as readily — which
# is why roll_back calls it too. The invariant is: what the workspaces say
# matches the code that is actually running.
resync_templates() {
  $SSH "$SERVER" "
    set -euo pipefail
    cd $DEST
    set -a; [ -f .env ] && . ./.env; set +a
    node scripts/resync-agent-templates.js --apply
  "
}

roll_back() {
  if ! $SSH "$SERVER" "[ -d $BACKUP ]"; then
    echo "No previous release snapshot to roll back to — manual intervention required." >&2
    return 1
  fi
  $SSH "$SERVER" "rsync -a --delete $BACKUP/ $DEST/ && systemctl restart olma2-brokerd olma2-dashboard" || true
  sleep 5
  if health_ok; then
    echo "Rolled back to the previous release successfully." >&2
  else
    echo "ROLLBACK ITSELF IS UNHEALTHY — manual intervention required immediately." >&2
  fi
  # Best-effort, and loud when it fails: leaving the new doctrine in workspaces
  # while the old code runs is exactly the mismatch this function exists to undo.
  resync_templates >&2 || echo "WARNING: workspaces still carry the ROLLED-BACK release's AGENTS.md — run scripts/resync-agent-templates.js --apply by hand." >&2
}

if [ "$RESTART" = "1" ]; then
  $SSH "$SERVER" "systemctl restart olma2-brokerd olma2-dashboard"
  sleep 5
  if ! health_ok; then
    echo "Post-restart health check FAILED — rolling back to the previous release." >&2
    roll_back || true
    echo "Deploy failed (auto-rolled-back where possible) — this run stays red on purpose; go fix the code." >&2
    exit 1
  fi
  # Only once the release is live AND healthy: a workspace must never be given
  # doctrine from a release that is about to be rolled back out from under it.
  # A failure here does NOT roll anything back — the service is up and fine —
  # but it does fail the run, because doctrine that silently reaches nobody is
  # the exact failure this step was added to end.
  if ! resync_templates; then
    echo "Deployed and healthy, but the AGENTS.md resync FAILED — existing users are still on the previous doctrine. Run scripts/resync-agent-templates.js --apply on the server." >&2
    exit 1
  fi
else
  echo "Note: no --restart, so nothing was restarted and AGENTS.md was NOT resynced — existing users keep their current doctrine until you do both." >&2
fi
