#!/usr/bin/env bash
# ONE-TIME setup of gamesd on the box, run by a person from a laptop:
#   bash games/scripts/setup-box.sh
# Creates the olma_games database and its own role (never Olma's), writes
# /opt/olma-games/.env with a password generated ON the box and never
# printed, installs and enables the unit. Idempotent: a second run changes
# nothing that exists. It does NOT touch Caddy; games/README.md has the route,
# added by hand once gamesd answers on 127.0.0.1:8794.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="root@157.230.210.233"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY"

$SSH "$SERVER" 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /opt/olma-games
if [ ! -f /opt/olma-games/.env ]; then
  PW="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  [ ${#PW} -eq 32 ] || { echo "password generation failed" >&2; exit 1; }
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'olma_games') THEN
    CREATE ROLE olma_games LOGIN PASSWORD '$PW';
  ELSE
    ALTER ROLE olma_games PASSWORD '$PW';
  END IF;
END \$\$;
SQL
  sudo -u postgres psql -Atc "SELECT 1 FROM pg_database WHERE datname = 'olma_games'" | grep -q 1 \
    || sudo -u postgres createdb -O olma_games olma_games
  umask 077
  cat > /opt/olma-games/.env <<ENV
GAMES_DB_URL=postgres://olma_games:$PW@127.0.0.1:5432/olma_games
GAMES_PORT=8794
GAMES_PUBLIC_BASE=https://allma.world
ENV
  unset PW
  echo "database, role and .env created"
else
  echo ".env already there; database and role left as they are"
fi

# Backups: the nightly dump beside olma2's (same folder, same 14 days), and
# the off-box copy through olma2's own script, which writes its OWN heartbeat
# row (backup_offbox_games) on the dashboard's health board. Added once,
# found again by the marker comment at the end of each line.
if ! crontab -l 2>/dev/null | grep -q '# olma_games-backup$'; then
  { crontab -l 2>/dev/null || true
    echo '20 2 * * * sudo -u postgres pg_dump olma_games | gzip > /root/backups/olma_games-$(date +\%F).sql.gz && find /root/backups -name "olma_games-*.sql.gz" -mtime +14 -delete # olma_games-backup'
    echo '45 2 * * * bash /opt/olma2/scripts/backup-offbox.sh olma_games >> /var/log/olma2-backup-offbox.log 2>&1 # olma_games-backup-offbox'
  } | crontab -
  echo "nightly dump and off-box copy added to root's crontab"
fi
# One copy now, so the heartbeat row exists from tonight: a backup that has
# never run has no row, and no row is never red.
if grep -q 'olma_games' /opt/olma2/scripts/backup-offbox.sh; then
  mkdir -p /root/backups
  sudo -u postgres pg_dump olma_games | gzip > "/root/backups/olma_games-$(date +%F).sql.gz"
  bash /opt/olma2/scripts/backup-offbox.sh olma_games && echo "first off-box copy made"
else
  echo "WARNING: /opt/olma2 does not have the olma_games backup yet; merge and deploy olma2 first, then run this again" >&2
fi
REMOTE

scp -i "$SSH_KEY" "$SRC_DIR/olma-games.service" "$SERVER:/etc/systemd/system/olma-games.service"
$SSH "$SERVER" "systemctl daemon-reload && systemctl enable olma-games >/dev/null && echo 'unit installed and enabled (starts on the first deploy)'"
