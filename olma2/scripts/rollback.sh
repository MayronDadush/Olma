#!/usr/bin/env bash
# Put a previously-deployed release back on the box, by date.
#
# deploy.sh already rolls back BY ITSELF when a deploy comes up unhealthy, and
# that path needs no human. This script is for the other case, the one that had
# no answer before: something is wrong, it has been wrong for a while, several
# merges have landed since, and nobody yet knows which one did it.
# `/opt/olma2-previous` is one release deep and cannot reach back that far;
# `git revert` can, but only once you have finished the diagnosis. Going back
# to a release that was known to work does not require the diagnosis first.
#
# Usage:
#   bash olma2/scripts/rollback.sh --list
#   bash olma2/scripts/rollback.sh --to 2026-09-03T18-21-04Z            # dry run
#   bash olma2/scripts/rollback.sh --to 2026-09-03T18-21-04Z --yes      # do it
#
#   SSH_KEY overrides the key path, same as deploy.sh.
#
# WHAT THIS DOES NOT UNDO — read before using it:
#   * DB migrations. A migration that ran stays applied. This script prints the
#     gap between what the database has and what the target release ships, and
#     refuses to pretend that gap is fine.
#   * Anything already delivered — a WhatsApp message, an audit row, a written
#     workspace file. Code going backwards does not unsend them.
#
# It is deliberately two steps: --to alone only describes. Restarting
# production onto older code is not something to do by typo.
set -euo pipefail

SERVER="root@157.230.210.233"
# Both overridable so the listing and the dry run can be rehearsed against
# throwaway paths on the box, rather than first exercised on the day something
# is actually broken.
DEST="${OLMA_DEST_DIR:-/opt/olma2}"
ARCHIVE="${OLMA_RELEASES_DIR:-/opt/olma2-releases}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH="ssh -i $SSH_KEY"

MODE=""
TARGET=""
CONFIRMED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --to) MODE="to"; TARGET="${2:-}"; shift ;;
    --yes) CONFIRMED=1 ;;
    *) echo "rollback: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

# No arguments lists rather than acts. The default behaviour of a rollback tool
# should be to tell you what your options are, never to guess one.
[ -z "$MODE" ] && MODE="list"

# Reads a `key=` out of a RELEASE marker, or prints a placeholder. A release
# deployed before markers existed has none, and "unknown" is the correct answer
# for it — not a blank that reads as though the field were empty.
read_marker() {
  $SSH "$SERVER" "
    f='$1/RELEASE'
    if [ -f \"\$f\" ]; then
      v=\$(grep -m1 '^$2=' \"\$f\" 2>/dev/null | cut -d= -f2-)
      [ -n \"\$v\" ] && printf '%s' \"\$v\" || printf 'unknown'
    else
      printf 'unmarked'
    fi
  "
}

# Deliberately ONE ssh round trip for the whole listing, not one per release
# per field. Each connection to this box costs about a second; the obvious
# shape (call read_marker in a loop) made `--list` take twelve, and a status
# command slow enough to be annoying is a status command nobody runs before
# deciding.
list_releases() {
  $SSH "$SERVER" "
    ARCHIVE=$ARCHIVE
    DEST=$DEST
    marker() {
      f=\"\$1/RELEASE\"
      if [ ! -f \"\$f\" ]; then printf 'unmarked'; return; fi
      v=\$(grep -m1 \"^\$2=\" \"\$f\" 2>/dev/null | cut -d= -f2-)
      [ -n \"\$v\" ] && printf '%s' \"\$v\" || printf 'unknown'
    }
    row() { printf '  %-24s %-9s %s\n' \"\$1\" \"\$(marker \"\$2\" sha | cut -c1-8)\" \"\$(marker \"\$2\" subject)\"; }

    echo 'Currently deployed:'
    row '(live)' \"\$DEST\"
    echo

    if [ ! -d \"\$ARCHIVE\" ]; then
      echo \"No release archive at \$ARCHIVE yet.\"
      echo 'It is created by the first deploy after the archive landed; until then the'
      echo 'only snapshot is /opt/olma2-previous, which is one release deep.'
      exit 0
    fi
    stamps=\$(cd \"\$ARCHIVE\" && ls -1 2>/dev/null | while IFS= read -r n; do [ -d \"\$n\" ] && printf '%s\n' \"\$n\"; done | sort -r)
    if [ -z \"\$stamps\" ]; then
      echo \"Release archive \$ARCHIVE exists but is empty.\"
      exit 0
    fi
    echo 'Archived releases, newest first — each is a release that was REPLACED:'
    printf '%s\n' \"\$stamps\" | while IFS= read -r s; do
      [ -n \"\$s\" ] && row \"\$s\" \"\$ARCHIVE/\$s\"
    done
    echo
    echo 'Roll back with:  bash olma2/scripts/rollback.sh --to <stamp> --yes'
  "
}

# The migration gap, stated as a fact rather than as a general warning. The
# database's applied max version against the highest migration the target
# release actually ships: if the DB is ahead, that difference is what the code
# rollback will NOT undo, named by file so it can be checked for real.
migration_gap() {
  local target_dir="$1"
  $SSH "$SERVER" "
    set -euo pipefail
    cd $DEST
    set -a; [ -f .env ] && . ./.env; set +a
    applied=\$(node -e '
      const {createPool} = require(\"./src/db/pool\");
      (async () => {
        const p = createPool();
        try {
          const r = await p.query(\"select coalesce(max(version), 0) v from schema_migrations\");
          console.log(r.rows[0].v);
        } finally { await p.end(); }
      })().catch(() => { console.log(\"?\"); });
    ')
    # '|| true' is load-bearing: a target release with no migrations/*.sql
    # makes ls fail, and under 'pipefail' that would abort the whole
    # description with no explanation. An unknown high-water mark is a fact to
    # print, not a reason to refuse to describe the rollback.
    ships=\$( (ls -1 $target_dir/migrations/*.sql 2>/dev/null || true) | sed 's#.*/##' | cut -d- -f1 | sed 's/^0*//' | sort -n | tail -1)
    [ -z \"\$ships\" ] && ships='?'
    echo \"applied=\$applied ships=\$ships\"
    if [ \"\$applied\" != '?' ] && [ \"\$ships\" != '?' ] && [ \"\$applied\" -gt \"\$ships\" ]; then
      echo 'AHEAD'
      ls -1 $target_dir/migrations/ >/dev/null 2>&1 || true
    fi
  "
}

health_ok() {
  $SSH "$SERVER" '
    systemctl is-active --quiet olma2-brokerd &&
    systemctl is-active --quiet olma2-dashboard &&
    curl -fsS -o /dev/null http://127.0.0.1:8788/ready
  '
}

roll_to() {
  local stamp="$1"
  case "$stamp" in
    ''|*/*|.|..) echo "rollback: '--to' needs an archived stamp, e.g. 2026-09-03T18-21-04Z" >&2; exit 2 ;;
  esac
  local dir="$ARCHIVE/$stamp"
  if ! $SSH "$SERVER" "[ -d $dir ]"; then
    echo "rollback: no archived release '$stamp'. Run --list to see what there is." >&2
    exit 1
  fi

  local live_sha target_sha target_subject
  live_sha=$(read_marker "$DEST" sha)
  target_sha=$(read_marker "$dir" sha)
  target_subject=$(read_marker "$dir" subject)

  # Rolling back onto the code that is already running restarts production for
  # no reason and, worse, leaves the operator believing they changed something.
  if [ "$live_sha" != "unknown" ] && [ "$live_sha" != "unmarked" ] && [ "$live_sha" = "$target_sha" ]; then
    echo "rollback: $stamp is the same commit ($live_sha) as what is already live — nothing to do." >&2
    exit 1
  fi

  echo "Rolling back $DEST"
  echo "  from: $(printf '%s' "$live_sha" | cut -c1-8)  $(read_marker "$DEST" subject)"
  echo "  to:   $(printf '%s' "$target_sha" | cut -c1-8)  $target_subject   ($stamp)"
  echo

  local gap
  gap=$(migration_gap "$dir")
  echo "Database: $(printf '%s' "$gap" | head -1)"
  if printf '%s' "$gap" | grep -q AHEAD; then
    echo "  ** The database is AHEAD of this release's migrations. Rolling back CODE"
    echo "     does not roll those back. This is safe only if they were additive."
    echo "     Check the extra migration files before continuing."
  fi
  echo

  if [ "$CONFIRMED" != "1" ]; then
    echo "Dry run — nothing changed. Re-run with --yes to actually do it."
    exit 0
  fi

  # Archive what is running now, or the rollback is a one-way door: without
  # this there is no way to roll FORWARD again after discovering the older
  # release was not the fix either.
  local now
  now=$($SSH "$SERVER" "date -u +%Y-%m-%dT%H-%M-%SZ")
  $SSH "$SERVER" "
    set -euo pipefail
    mkdir -p $ARCHIVE
    d=$ARCHIVE/$now; n=1
    while [ -e \"\$d\" ]; do d=$ARCHIVE/$now-\$n; n=\$((n + 1)); done
    cp -a $DEST \"\$d\"
    echo \"archived the release being replaced to \$d\"
  "

  $SSH "$SERVER" "rsync -a --delete $dir/ $DEST/ && systemctl restart olma2-brokerd olma2-dashboard"
  sleep 5
  if health_ok; then
    echo "Rolled back to $stamp and the services are healthy."
  else
    echo "ROLLED BACK, BUT THE SERVICE IS NOT HEALTHY — this release is not the fix." >&2
    echo "Check: journalctl -u olma2-brokerd -n 50 --no-pager" >&2
  fi

  # Same invariant deploy.sh keeps: what the workspaces say matches the code
  # that is actually running. resync derives the text from the deployed tree,
  # so after a rollback it puts the older doctrine back.
  $SSH "$SERVER" "
    set -euo pipefail
    cd $DEST
    set -a; [ -f .env ] && . ./.env; set +a
    node scripts/resync-agent-templates.js --apply
  " || echo "WARNING: workspaces still carry the ROLLED-FORWARD release's AGENTS.md — run scripts/resync-agent-templates.js --apply by hand." >&2

  echo
  echo "Note: this changed the code on the box only. The git history still has"
  echo "the bad commit on main, so the NEXT merge will deploy it again. Land a"
  echo "revert or a fix before then."
}

case "$MODE" in
  list) list_releases ;;
  to) roll_to "$TARGET" ;;
esac
