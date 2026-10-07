#!/usr/bin/env bash
# ONE-TIME setup of foodd on the box, run by a person from a laptop:
#   bash food/scripts/setup-box.sh
# Creates the olma_food database and its own role (never Olma's), writes
# /opt/olma-food/.env with a password generated ON the box and never
# printed, installs and enables the unit. Idempotent: a second run changes
# nothing that exists. It does NOT touch Caddy; food/README.md has the route,
# added by hand once foodd answers on 127.0.0.1:8795.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY"

$SSH "$SERVER" 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /opt/olma-food
if [ ! -f /opt/olma-food/.env ]; then
  PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  [ ${#PW} -eq 32 ] || { echo "password generation failed" >&2; exit 1; }
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'olma_food') THEN
    CREATE ROLE olma_food LOGIN PASSWORD '$PW';
  ELSE
    ALTER ROLE olma_food PASSWORD '$PW';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname = 'olma_food'" | grep -q 1 \
    || sudo -u postgres createdb -O olma_food olma_food
  umask 077
  cat > /opt/olma-food/.env <<ENV
FOOD_DB_URL=postgres://olma_food:$PW@127.0.0.1:5432/olma_food
FOOD_PORT=8795
FOOD_PUBLIC_BASE=https://allma.world
ENV
  unset PW
  echo "database, role and .env created"
else
  echo ".env already there; database and role left as they are"
fi
# The vision step's own OpenRouter key (with its own spending limit). Left
# EMPTY here on purpose: a person pastes it on the box, never through the repo.
grep -q '^FOOD_OPENROUTER_KEY=' /opt/olma-food/.env || echo 'FOOD_OPENROUTER_KEY=' >> /opt/olma-food/.env
grep -q '^FOOD_OPENROUTER_KEY=.' /opt/olma-food/.env || echo "NOTE: FOOD_OPENROUTER_KEY is empty in /opt/olma-food/.env; photos stay off until it is set"

# Backups: the nightly dump beside olma2's (same folder, same 14 days), and
# the off-box copy through olma2's own script, which writes its OWN heartbeat
# row (backup_offbox_food) on the dashboard's health board. Added once,
# found again by the marker comment at the end of each line.
if ! crontab -l 2>/dev/null | grep -q '# olma_food-backup$'; then
  { crontab -l 2>/dev/null || true
    echo '25 2 * * * sudo -u postgres pg_dump olma_food | gzip > /root/backups/olma_food-$(date +\%F).sql.gz && find /root/backups -name "olma_food-*.sql.gz" -mtime +14 -delete # olma_food-backup'
    echo '50 2 * * * bash /opt/olma2/scripts/backup-offbox.sh olma_food >> /var/log/olma2-backup-offbox.log 2>&1 # olma_food-backup-offbox'
  } | crontab -
  echo "nightly dump and off-box copy added to root's crontab"
fi
# One copy now, so the heartbeat row exists from tonight: a backup that has
# never run has no row, and no row is never red.
if grep -q 'olma_food' /opt/olma2/scripts/backup-offbox.sh; then
  mkdir -p /root/backups
  sudo -u postgres pg_dump olma_food | gzip > "/root/backups/olma_food-$(date +%F).sql.gz"
  bash /opt/olma2/scripts/backup-offbox.sh olma_food && echo "first off-box copy made"
else
  echo "WARNING: /opt/olma2 does not have the olma_food backup yet; merge and deploy olma2 first, then run this again" >&2
fi
REMOTE

scp -i "$SSH_KEY" "$SRC_DIR/olma-food.service" "$SERVER:/etc/systemd/system/olma-food.service"
$SSH "$SERVER" "systemctl daemon-reload && systemctl enable olma-food >/dev/null && echo 'unit installed and enabled (starts on the first deploy)'"
