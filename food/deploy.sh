#!/usr/bin/env bash
# Deploy foodd to /opt/olma-food on the box, or roll it back. Its own unit,
# its own database, its own blast radius: never touches /opt/olma2, and an
# olma2 deploy never touches this. Same shape as voice-bridge/deploy.sh:
# snapshot, sync, install, restart, PROVE it answers, restore on failure.
#
# Usage:
#   bash food/deploy.sh              # deploy the checked-out tree
#   bash food/deploy.sh --rollback   # put the previous tree back
#
# Needs the one-time setup first (food/scripts/setup-box.sh): the database,
# the .env and the unit. Without it this refuses rather than half-deploying.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma-food"
PREV="/opt/olma-food-previous"
UNIT="olma-food"
PORT=8795
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY -o ServerAliveInterval=15 -o ServerAliveCountMax=6"

# /health answers 200 only on 127.0.0.1 and only after a query reached the
# database, so a 200 is the process, the port and Postgres at once. The unit
# must also be active, or a crash loop between two probes reads as up.
food_ok() {
  $SSH "$SERVER" "
    systemctl is-active --quiet $UNIT &&
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/health | grep -q '^200\$'
  "
}

restart_and_check() {
  $SSH "$SERVER" "cd $DEST && npm install --omit=dev --no-audit --no-fund --loglevel=error && systemctl restart $UNIT"
  for _ in 1 2 3 4 5 6 7 8; do
    if food_ok; then return 0; fi
    sleep 2
  done
  return 1
}

$SSH "$SERVER" "[ -f $DEST/.env ] && [ -f /etc/systemd/system/$UNIT.service ]" || {
  echo "foodd is not set up on the box yet: run food/scripts/setup-box.sh once first" >&2
  exit 1
}

if [ "${1:-}" = "--rollback" ]; then
  $SSH "$SERVER" "[ -d $PREV ] || { echo 'no previous food tree to roll back to' >&2; exit 1; }"
  $SSH "$SERVER" "rm -rf $DEST.failed && mv $DEST $DEST.failed && cp -a $PREV $DEST"
  if restart_and_check; then
    echo "rolled foodd back to the previous tree; the failed one is at $DEST.failed"
    exit 0
  fi
  echo "ROLLBACK FAILED: foodd is down. Inspect: journalctl -u $UNIT -n 100" >&2
  exit 1
fi

$SSH "$SERVER" "[ -d $DEST/bin ] && rm -rf $PREV && cp -a $DEST $PREV || true"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude tests --exclude bench --exclude design \
  -e "$SSH" \
  "$SRC_DIR/" "$SERVER:$DEST/"

if restart_and_check; then
  echo "foodd deployed and answering on 127.0.0.1:$PORT"
  exit 0
fi

echo "Post-restart check FAILED: restoring the previous food tree." >&2
$SSH "$SERVER" "[ -d $PREV/bin ] && rm -rf $DEST && cp -a $PREV $DEST" || true
if restart_and_check; then
  echo "previous foodd restored and answering; the deploy did NOT ship." >&2
else
  echo "previous foodd did NOT come back either: journalctl -u $UNIT -n 100" >&2
fi
exit 1
