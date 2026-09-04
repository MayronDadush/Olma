#!/usr/bin/env bash
# Run the test suite, and survive node's test runner deadlocking on itself.
#
# WHY THIS EXISTS — the wedge, diagnosed 2026-09-04
#
# `node --test` intermittently stops dead: a few files report, then total
# silence for as long as you let it run. It cost most of an evening and three
# re-runs of a single merge before anyone looked at it properly.
#
# It is NOT our code and NOT Postgres. Reproduced 4 times under a probe
# workflow that dumped the machine's state while it was still hung:
#
#   * The runner starts N files. All of them emit EVERY one of their tests.
#     Then one child stays alive forever and no further file is ever started.
#   * That child holds one TCP connection to Postgres, and Postgres has the
#     matching session `idle` in `ClientRead` — the server waiting for the
#     client to speak. The socket is readable, writable, `writeQueueSize: 0`.
#     Nothing is in flight and no lock is held anywhere (`pg_blocking_pids`
#     was empty every time).
#   * Both the runner and the child sit in `State: S (sleeping)`, `wchan:
#     ep_poll` — parked in the event loop, not blocked in a syscall. Node's
#     own diagnostic report shows an EMPTY JavaScript stack in both.
#   * The child's stdio are socketpairs to the runner, and its output never
#     arrives: a preload that writes to fd 2 before any test code runs
#     produced no line at all, though the child had demonstrably run queries.
#     The runner has simply stopped reading it.
#
# So: the runner and one child stop talking to each other, and both then wait
# for the other forever. Ruled out along the way, each by experiment rather
# than by argument:
#
#   * pipe backpressure  — the stdio are sockets, and the runner's own output
#                          goes to a plain file, which cannot block
#   * DB/connection pressure — `--test-concurrency=2` wedged on attempt 1
#   * our timeouts       — connectionTimeoutMillis / query_timeout /
#                          statement_timeout never fire, because nothing is
#                          pending in pg at all
#   * a slow machine     — a healthy run of the same suite is 30-45s
#
# Rate: roughly 1 run in 8-25, on a 4-core GitHub runner, node 24.19/24.20.
#
# WHAT THIS DOES ABOUT IT
#
# Retries, but only a HANG, and never quietly. A suite that EXITS non-zero is
# a real failure and is reported immediately — retrying that would be how a
# flaky-test culture starts. A suite that stops producing output and never
# exits is the upstream bug, and re-running is exactly what a human does.
#
# It is loud on purpose. Every wedge prints a banner, and the summary at the
# end says how many attempts it took even when it eventually passed — because
# a workaround that hides its own frequency is how this ends up costing
# another evening in six months when it gets worse.
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
  CMD="node --test"
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
