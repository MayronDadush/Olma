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
set -euo pipefail

RESTART=0
for arg in "$@"; do
  [ "$arg" = "--restart" ] && RESTART=1
done

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma2"
BACKUP="/opt/olma2-previous"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY"

# Snapshot the currently-deployed release (code + its own node_modules) as a
# complete standalone copy BEFORE the new rsync overwrites anything, so a bad
# deploy has something real to roll back to. Skipped on the very first deploy
# (DEST doesn't exist yet). One snapshot is kept, not a history.
$SSH "$SERVER" "[ -d $DEST ] && rm -rf $BACKUP && cp -a $DEST $BACKUP || true"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '*.log' --exclude run \
  -e "$SSH" \
  "$SRC_DIR/" "$SERVER:$DEST/"

$SSH "$SERVER" "
  set -euo pipefail
  cd $DEST
  set -a; [ -f .env ] && . ./.env; set +a
  npm install --no-audit --no-fund --loglevel=error
  node src/db/migrate.js
  # The droplet has ONE core. Node's default is unlimited file concurrency,
  # which on this box means 11 test processes plus 11 Postgres databases
  # thrashing each other into timeouts that look like real failures.
  node --test --test-concurrency=2 'tests/*.test.js'
"

# Passes iff both services are actually running (catches an instant crash —
# syntax error, missing dep, a migration the app itself trips on that the
# test suite didn't) AND the dashboard's own /health responds — DB
# reachability plus job-heartbeat sanity, see adapters/http/dashboard.js.
# "tests passed in CI" never proves the live process came up; this does.
health_ok() {
  $SSH "$SERVER" '
    systemctl is-active --quiet olma2-brokerd &&
    systemctl is-active --quiet olma2-dashboard &&
    curl -fsS -o /dev/null http://127.0.0.1:8788/health
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
