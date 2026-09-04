#!/usr/bin/env bash
# Run the test suite, and survive a hang instead of losing the whole run to it.
#
# WHY THIS EXISTS
#
# `node --test` intermittently stopped dead: a few files reported, then total
# silence for as long as you let it run. Roughly 1 run in 8-25, on a 4-core
# GitHub runner, node 24.19/24.20. It cost two evenings and four dead `main`
# runs — and since a timeout-killed job reports as `cancelled`, not `failure`,
# the `deploy` job that `needs: test` was silently SKIPPED each time.
#
# THE CAUSE WAS OURS, and is fixed (2026-09-04). Two tests staged a
# duplicate-migration collision by writing a decoy .sql into the REAL
# migrations/ directory for a few milliseconds; test files are separate
# processes over one filesystem, so any other file calling freshDb() in that
# window threw in its `before` hook — with a pg Client connected and now never
# closed, which kept its event loop alive for ever. The child never exited,
# the runner waited on `once(child, "exit")` for ever, and nothing was ever
# printed (the runner buffers a file's stderr into its report until the file
# completes). See docs/incidents.md, "A test file poisoned every other one".
#
# An earlier header here blamed an upstream runner bug. It was wrong, and
# saying so is the point: the evidence it called decisive — a silent child —
# was the expected behaviour of a child that never finishes.
#
# WHAT THIS DOES, AND WHY IT STAYS
#
# The specific bug is gone, but "a test child that cannot exit hangs the whole
# suite with no output" is a shape, not a one-off, and the next one will look
# identical from outside. So this stays as the backstop.
#
# It retries only a HANG, and never quietly. A suite that EXITS non-zero is a
# real failure and is reported immediately — retrying that is how a flaky-test
# culture starts. It is loud on purpose: every wedge prints a banner, and the
# summary says how many attempts it took even when it eventually passed,
# because a workaround that hides its own frequency is how this comes back in
# six months as somebody else's evening. If you see that banner now, the fix
# above did not cover your case — go and diagnose it, do not bank the retry.
#
# Diagnosing the next one: a wedged child prints nothing, so make it report on
# ITSELF. NODE_OPTIONS=--require a preload into every child with an UNREF'd
# interval that appends process.getActiveResourcesInfo() to a file. Unref'd is
# the trick — a parked event loop still runs timers, and an unref'd timer
# cannot be what is holding the process open. That named this bug on the first
# reproduction, after 70 runs of guessing found nothing.
#
# Env knobs: SUITE_ATTEMPTS (3), SUITE_TIMEOUT seconds (300), SUITE_CONCURRENCY,
# SUITE_NICE, and SUITE_CMD to override the command entirely (the tests use it).
set -uo pipefail

# Job control, so every attempt runs in its own process group and can be killed
# whole. The first version pattern-matched `pkill -f 'tests/.*\.test\.js'`
# instead, which killed the run-suite tests that were driving it — and on a
# shared box would have reached anyone else's test run too. A cleanup that can
# hit a process it did not start is not cleanup.
set -m

ATTEMPTS="${SUITE_ATTEMPTS:-3}"
TIMEOUT="${SUITE_TIMEOUT:-300}"
CONCURRENCY="${SUITE_CONCURRENCY:-}"
NICE="${SUITE_NICE:-}"

if [ -n "${SUITE_CMD:-}" ]; then
  CMD="$SUITE_CMD"
else
  # --test-timeout: node's default is 0, i.e. a test or hook that never settles
  # waits for ever. 60s is >2x the whole suite's healthy runtime, so nothing
  # legitimate reaches it. Measured caveat, so nobody mistakes this for full
  # cover: it catches a hook/test that never SETTLES, and does nothing at all
  # for a file whose tests pass but which leaves a handle open — that one is
  # caught by the exit watchdog in tests/helpers.js.
  CMD="node --test --test-timeout=60000"
  [ -n "$CONCURRENCY" ] && CMD="$CMD --test-concurrency=$CONCURRENCY"
  CMD="$CMD 'tests/*.test.js'"
  [ -n "$NICE" ] && CMD="nice -n $NICE $CMD"
fi

wedges=0
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  eval "$CMD" &
  pid=$!

  # Poll instead of `timeout`, for two reasons: `timeout` is not present on
  # every box this runs on, and killing the process group would take the
  # orphaned test children with it before we can count them.
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$TIMEOUT" ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"; rc=$?
    if [ "$rc" = "0" ] && [ "$wedges" -gt 0 ]; then
      echo "" >&2
      echo "NOTE: the suite passed, but only on attempt $attempt — node's test runner" >&2
      echo "wedged $wedges time(s) first. See the comment at the top of" >&2
      echo "scripts/run-suite.sh. This is not a test failure, and it is not free:" >&2
      echo "each wedge costs ${TIMEOUT}s of CI." >&2
    fi
    # Any exit code, including a real failure, is final. Only a hang retries.
    exit "$rc"
  fi

  wedges=$((wedges + 1))
  echo "" >&2
  echo "########################################################################" >&2
  echo "# THE WEDGE: no exit after ${TIMEOUT}s (a healthy run is 30-45s)." >&2
  echo "# node's test runner and one of its children have stopped talking to" >&2
  echo "# each other; both are parked in the event loop. Not a test failure." >&2
  echo "# Attempt $attempt of $ATTEMPTS — killing and retrying." >&2
  echo "########################################################################" >&2
  # The runner will not reap its children once it is in this state, so the
  # whole group goes — negative pid is the group, which `set -m` above made
  # this job's own and nobody else's.
  kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  attempt=$((attempt + 1))
done

echo "" >&2
echo "The suite wedged on all $ATTEMPTS attempts and never produced a result." >&2
echo "That is worse than the usual rate — check whether the wedge has changed" >&2
echo "shape before assuming it is the known one." >&2
exit 1
