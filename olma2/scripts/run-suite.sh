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
# WHAT IT MEASURES, AND WHY THAT CHANGED (2026-09-18)
#
# It used to kill an attempt that had not EXITED inside a fixed window. That
# conflates two different things — a suite that is STUCK and a suite that is
# merely SLOW — and on 2026-09-18 it killed a perfectly healthy run: PR #407,
# run 35355870730, job 105635021975. All three attempts were killed and the
# banner said the suite "never produced a result", which was false. Each
# attempt was still printing passing test lines ~5s before it was killed
# (attempt 3's last at 14:32:57, the kill at 14:33:02); individual tests were
# at 3x their usual cost on that runner ("lane watchdog: aborts the wedged
# lane" at 5749/3584/4675ms against a normal <2s); and the same commit passed
# on its push-event run (35355831218) in 1m42s and twice locally, 2081/2081.
#
# The tell was already written in the banner it printed: a wedged child prints
# NOTHING. The runner buffers a file's output into its report until that file
# completes, so a child that never finishes is silent for ever — that is the
# whole reason the 2026-09-04 wedge was invisible. A run still printing test
# lines five seconds before it dies is, by that definition, not wedged. The
# ceiling was tight; the suite had simply grown into it.
#
# So the watchdog measures PROGRESS, not elapsed time. Every byte the child
# writes resets the deadline, and SILENCE is the wedge. A slow-but-talking
# suite now runs to completion, and a genuinely wedged one is still caught —
# caught sooner, in fact, since the silence clock starts at the last write
# rather than at the start of the attempt.
#
# Measured 2026-09-18 on a green 2085/2085 run, and that is where the default
# comes from: 118s of wall clock, p50 gap between writes 2ms, p95 5.8s, p99
# 10.9s, worst gap 11.3s (the slowest single test in the suite is ~12.6s).
# SUITE_SILENCE defaults to 180s — about 16x that worst gap, and still ~5x it
# on a runner as slow as the one that lost #407. Note what the same
# measurement says about the old knob: 118s of healthy run against CI's 180s
# ceiling is 1.5x of headroom, not the "2-4x the observed 45-90s" its comment
# claimed. The suite outgrew the ceiling and nothing announced it.
#
# This assumes the suite talks as it works, which `node --test` does — it
# reports each file as that file completes, across ~105 files. Pointed at a
# single test file slower than SUITE_SILENCE it would call that silence a
# wedge, correctly by its own definition and uselessly by yours.
#
# SUITE_TIMEOUT survives as a second and much looser backstop, with a
# DIFFERENT verdict on purpose: an attempt still talking when it reaches the
# overall cap is reported as a cap, NOT as a wedge, and is not retried. Two
# reasons. Re-rolling a suite that just spent its entire cap buys the same
# wall a second time and eats the job's own timeout-minutes, which kills the
# run as `cancelled` with no banner at all — the exact silent-skip this
# wrapper exists to prevent. And "wedged on all N attempts" has to keep
# meaning what it says, or the next person reads a banner that is as wrong as
# #407's was.
#
# Env knobs: SUITE_ATTEMPTS (3), SUITE_SILENCE seconds (180, 0 disables),
# SUITE_TIMEOUT seconds — the overall per-attempt cap (900, 0 disables),
# SUITE_CONCURRENCY, SUITE_NICE, and SUITE_CMD to override the command
# entirely (the tests use it).
set -uo pipefail

# Job control, so every attempt runs in its own process group and can be killed
# whole. The first version pattern-matched `pkill -f 'tests/.*\.test\.js'`
# instead, which killed the run-suite tests that were driving it — and on a
# shared box would have reached anyone else's test run too. A cleanup that can
# hit a process it did not start is not cleanup.
set -m

ATTEMPTS="${SUITE_ATTEMPTS:-3}"
SILENCE="${SUITE_SILENCE:-180}"
TIMEOUT="${SUITE_TIMEOUT:-900}"
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

# The transcript exists only to be measured — its SIZE is the progress signal.
# Output still goes to the real stdout/stderr as it always did, so nothing
# about the CI log changes.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-suite.XXXXXX")"
PROGRESS="$WORK/transcript"
: > "$PROGRESS"
trap 'rm -rf "$WORK"' EXIT

# Bytes written so far. `wc -c <file` rather than `stat`, whose flags differ
# between macOS and Linux and which this has to run on both of.
written() { wc -c < "$PROGRESS" 2>/dev/null | tr -d ' ' || echo 0; }

wedges=0
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  # Process substitution, not a pipeline: `$!` stays the suite itself, so
  # `wait` still returns the suite's own exit code and `kill -0` still tracks
  # the suite rather than a tee that outlives it by however long some leaked
  # grandchild holds the pipe open.
  eval "$CMD" > >(tee -a "$PROGRESS") 2> >(tee -a "$PROGRESS" >&2) &
  pid=$!

  # Poll instead of `timeout`, for two reasons: `timeout` is not present on
  # every box this runs on, and killing the process group would take the
  # orphaned test children with it before we can count them. The one-second
  # tick doubles as the drain window for the tees above — by the time we
  # notice the child is gone, its last bytes are long written.
  waited=0
  silent=0
  seen="$(written)"
  verdict=exited
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    now="$(written)"
    if [ "$now" != "$seen" ]; then
      seen="$now"
      silent=0
    else
      silent=$((silent + 1))
    fi
    if [ "$SILENCE" -gt 0 ] && [ "$silent" -ge "$SILENCE" ]; then
      verdict=wedged
      break
    fi
    if [ "$TIMEOUT" -gt 0 ] && [ "$waited" -ge "$TIMEOUT" ]; then
      verdict=capped
      break
    fi
  done

  # It may have exited during the tick that tripped a deadline; an exit is the
  # real answer and outranks either.
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"; rc=$?
    if [ "$rc" = "0" ] && [ "$wedges" -gt 0 ]; then
      echo "" >&2
      echo "NOTE: the suite passed, but only on attempt $attempt — node's test runner" >&2
      echo "wedged $wedges time(s) first. See the comment at the top of" >&2
      echo "scripts/run-suite.sh. This is not a test failure, and it is not free:" >&2
      echo "each wedge costs ${SILENCE}s of CI." >&2
    fi
    # Any exit code, including a real failure, is final. Only a hang retries.
    exit "$rc"
  fi

  if [ "$verdict" = "capped" ]; then
    echo "" >&2
    echo "########################################################################" >&2
    echo "# THE OVERALL CAP: still running after ${TIMEOUT}s, and still TALKING —" >&2
    echo "# it wrote output ${silent}s ago, so this is NOT the wedge and is not" >&2
    echo "# retried. The suite is either genuinely slower than the cap allows or" >&2
    echo "# the host is. Compare against a healthy run before raising anything:" >&2
    echo "# SUITE_TIMEOUT is meant to sit well clear of the suite, and a suite" >&2
    echo "# creeping up on it announces itself here rather than as a wedge." >&2
    echo "########################################################################" >&2
    kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    exit 1
  fi

  wedges=$((wedges + 1))
  echo "" >&2
  echo "########################################################################" >&2
  echo "# THE WEDGE: no output for ${SILENCE}s (it had been running ${waited}s)." >&2
  echo "# A test child could not exit — something is still holding its event" >&2
  echo "# loop open, and node --test waits on it for ever, printing nothing." >&2
  echo "# SILENCE is the signal, not slowness: a suite that is merely slow" >&2
  echo "# keeps printing and is left alone (it was not, before 2026-09-18, and" >&2
  echo "# this banner lied about a healthy run on PR #407)." >&2
  echo "# Look at OUR code first: the known instance of this was a test of" >&2
  echo "# ours, not a runner bug. docs/incidents.md, \"A test file poisoned" >&2
  echo "# every other one\", has the diagnosis and how to catch the next one." >&2
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
echo "Every one of them went silent for ${SILENCE}s with the process still alive." >&2
echo "That is worse than the usual rate — check whether the wedge has changed" >&2
echo "shape before assuming it is the known one." >&2
exit 1
