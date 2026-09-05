#!/usr/bin/env bash
# Deploy the voice bridge to /opt/olma2-voice-bridge on the box, or roll it
# back. Deliberately NOT a flag on olma2/scripts/deploy.sh: the bridge is its
# own unit with its own blast radius, and a voice change must not redeploy
# olma2 (nor the other way round). Same shape as that script where it matters:
# snapshot first, sync, install, restart, PROVE it came up, restore on failure.
#
# Usage:
#   bash voice-bridge/deploy.sh              # deploy the checked-out tree
#   bash voice-bridge/deploy.sh --rollback   # put the previous tree back
#
# SSH_KEY overrides the key path (CI points it at a temp file). The unit is
# system-scope (plain systemctl — CLAUDE.md, "systemd scope"). What is never
# synced: .env, twilio.env, transcripts/ and node_modules (the box's own).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma2-voice-bridge"
PREV="/opt/olma2-voice-bridge-previous"
UNIT="olma-voice-bridge"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY -o ServerAliveInterval=15 -o ServerAliveCountMax=6"

# The dial API (127.0.0.1:8792) answers every non-POST with a JSON 404. That
# 404 is the proof: the process is up, the port is bound, and it is OUR server
# answering — a dead unit refuses the connection, a stranger would not answer
# with this body. The unit must also be active, or a crash loop reads as up.
bridge_ok() {
  $SSH "$SERVER" "
    systemctl is-active --quiet $UNIT &&
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8792/dial | grep -q '^404\$'
  "
}

restart_and_check() {
  $SSH "$SERVER" "cd $DEST && npm install --omit=dev --no-audit --no-fund --loglevel=error && systemctl restart $UNIT"
  # A restart takes a moment to bind; give it a few seconds, not one.
  for _ in 1 2 3 4 5 6; do
    if bridge_ok; then return 0; fi
    sleep 2
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  $SSH "$SERVER" "[ -d $PREV ] || { echo 'no previous bridge tree to roll back to' >&2; exit 1; }"
  $SSH "$SERVER" "rm -rf $DEST.failed && mv $DEST $DEST.failed && cp -a $PREV $DEST"
  if restart_and_check; then
    echo "rolled the voice bridge back to the previous tree; the failed one is at $DEST.failed"
    exit 0
  fi
  echo "ROLLBACK FAILED — the bridge is down. Inspect: journalctl -u $UNIT -n 100" >&2
  exit 1
fi

# Snapshot the running tree (its node_modules and .env included) before the
# sync touches anything. One deep, overwritten every deploy.
$SSH "$SERVER" "[ -d $DEST ] && rm -rf $PREV && cp -a $DEST $PREV || true"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude twilio.env --exclude 'transcripts/' \
  --exclude 'clips/' --exclude 'phrase-candidates/' --exclude 'voice-tour.wav' --exclude '*.bak-*' \
  -e "$SSH" \
  "$SRC_DIR/" "$SERVER:$DEST/"

if restart_and_check; then
  echo "voice bridge deployed and answering on 127.0.0.1:8792"
  exit 0
fi

echo "Post-restart check FAILED — restoring the previous bridge tree." >&2
$SSH "$SERVER" "[ -d $PREV ] && rm -rf $DEST && cp -a $PREV $DEST" || true
if restart_and_check; then
  echo "previous bridge restored and answering; the deploy did NOT ship." >&2
else
  echo "previous bridge did NOT come back either — the bridge is down: journalctl -u $UNIT -n 100" >&2
fi
exit 1
