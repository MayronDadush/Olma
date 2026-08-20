#!/usr/bin/env bash
# Sync olma2/ to the server, install deps, migrate, run the full test suite.
# Tests run on the server because that's where Postgres and Node 24 live.
# Usage: bash olma2/scripts/deploy.sh [--restart]
#   SSH_KEY env var overrides the key path (defaults to ~/.ssh/id_ed25519) —
#   lets CI point at a temp key file instead of a dev machine's own key.
#   --restart additionally restarts olma2-brokerd/olma2-dashboard once the
#   remote test suite passes; omitted by default so local runs keep the
#   existing manual-restart workflow.
set -euo pipefail

RESTART=0
for arg in "$@"; do
  [ "$arg" = "--restart" ] && RESTART=1
done

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma2"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '*.log' --exclude run \
  -e "ssh -i $SSH_KEY" \
  "$SRC_DIR/" "$SERVER:$DEST/"

ssh -i "$SSH_KEY" "$SERVER" "
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

if [ "$RESTART" = "1" ]; then
  ssh -i "$SSH_KEY" "$SERVER" "systemctl restart olma2-brokerd olma2-dashboard"
fi
