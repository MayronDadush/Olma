#!/usr/bin/env bash
# Keep the newest N release snapshots in an archive directory, delete the rest.
#
# Split out of deploy.sh for one reason: it is the only part of the release
# archive that DELETES, it runs unattended on the production box after every
# merge, and `rm -rf` built from a shell variable is how a deploy script erases
# something it was never asked to touch. As its own file it is testable —
# tests/prune-releases.test.js drives this exact script against real temp
# directories, including the empty, missing and already-under-the-limit cases
# that a one-liner inside an ssh heredoc could only be hoped to handle.
#
# Usage: prune-releases.sh <archive-dir> [keep]
#   keep defaults to 5, or $OLMA_RELEASES_KEEP if set.
#
# Snapshot names are ISO-8601 UTC stamps (2026-09-03T18-21-04Z), so a plain
# lexicographic sort IS chronological order and no date parsing is needed.
set -euo pipefail

ARCHIVE="${1:-}"
KEEP="${2:-${OLMA_RELEASES_KEEP:-5}}"

if [ -z "$ARCHIVE" ]; then
  echo "prune-releases: no archive directory given" >&2
  exit 2
fi

# A keep of 0 would empty the archive, which is precisely the state this whole
# feature exists to prevent — an outage with nothing to roll back to. Refused
# rather than obeyed, and refused loudly: a typo in a deploy variable must not
# quietly turn the safety net off.
case "$KEEP" in
  ''|*[!0-9]*) echo "prune-releases: keep must be a whole number, got '$KEEP'" >&2; exit 2 ;;
esac
if [ "$KEEP" -lt 1 ]; then
  echo "prune-releases: refusing to keep $KEEP releases — the archive would be empty" >&2
  exit 2
fi

# A missing archive is not a fault: the first deploy after this landed has not
# created one yet. Say so and exit clean — a deploy must not fail because
# there was nothing to tidy. (Absence of an archive and an empty archive are
# different facts, so they get different lines.)
if [ ! -d "$ARCHIVE" ]; then
  echo "prune-releases: no archive at $ARCHIVE yet — nothing to prune"
  exit 0
fi

# Directories only. A stray file in the archive (a README someone dropped, a
# half-written marker) is neither counted toward the limit nor deleted.
snapshots=()
while IFS= read -r name; do
  [ -n "$name" ] && snapshots+=("$name")
done < <(cd "$ARCHIVE" && ls -1 2>/dev/null | while IFS= read -r n; do [ -d "$n" ] && printf '%s\n' "$n"; done | sort)

total=${#snapshots[@]}
if [ "$total" -le "$KEEP" ]; then
  echo "prune-releases: $total release(s) archived, keeping $KEEP — nothing to delete"
  exit 0
fi

drop=$((total - KEEP))
echo "prune-releases: $total archived, keeping newest $KEEP, deleting $drop"

i=0
while [ "$i" -lt "$drop" ]; do
  name="${snapshots[$i]}"
  # Belt and braces around the one destructive line in the deploy path: the
  # name must be non-empty, must not be a path, and must resolve to a real
  # directory inside the archive. Any of those failing means the list this
  # loop is walking is not what it thinks it is — say so and stop.
  case "$name" in
    ''|.|..|*/*) echo "prune-releases: refusing to delete suspicious entry '$name'" >&2; exit 1 ;;
  esac
  target="$ARCHIVE/$name"
  if [ ! -d "$target" ]; then
    echo "prune-releases: '$name' vanished before deletion — skipping" >&2
    i=$((i + 1))
    continue
  fi
  rm -rf -- "$target"
  echo "prune-releases: deleted $name"
  i=$((i + 1))
done

i="$drop"
while [ "$i" -lt "$total" ]; do
  echo "prune-releases: kept ${snapshots[$i]}"
  i=$((i + 1))
done
