#!/usr/bin/env bash
# Sync olma2/ to the server, install deps, migrate, run the full test suite.
# Tests run on the server because that's where Postgres and Node 24 live.
# Usage: bash olma2/scripts/deploy.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
DEST="/opt/olma2"

rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '*.log' --exclude run \
  -e "ssh -i $HOME/.ssh/id_ed25519" \
  "$SRC_DIR/" "$SERVER:$DEST/"

ssh -i "$HOME/.ssh/id_ed25519" "$SERVER" "
  set -euo pipefail
  cd $DEST
  set -a; [ -f .env ] && . ./.env; set +a
  npm install --no-audit --no-fund --loglevel=error
  node src/db/migrate.js
  node --test 'tests/*.test.js'
"
