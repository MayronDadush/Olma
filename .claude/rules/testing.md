---
paths:
  - "olma2/tests/**"
  - "olma2/scripts/run-suite.sh"
---

# Testing

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Testing" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

From `olma2/`:

```bash
npm test          # node --test 'tests/*.test.js'
npm run lint      # eslint, dev-only; CI runs it before the suite
```

Real Postgres, one throwaway database per test file (`tests/helpers.freshDb`).
Two things the suite learned the hard way:

- **The test pool pins `Etc/UTC`**, because production does. A suite green only
  where the clocks agree is testing a configuration nobody deploys.

- **Never let a test depend on the hour or the weekday it runs.** Use
  `helpers.daytime()` and `helpers.slotStart()`; a hard-coded "Tuesday 17:00"
  or an unpinned `drainOnce` passes or fails depending on when you run it.
  The suite was green thirteen hours a day and red eleven before this.

- **A moment a test will later assert on is computed ONCE**, into a variable.
  `slotStart`/`at()` are second-precision off the live clock, so computing the
  same moment twice can straddle a second — and a yes must name the exact
  `starts_at` that was proposed. Three deploys died on this, on bytes the PR
  had passed twice: 65ms of gap in CI, 603ms in `deploy.sh`'s niced on-box run
  (`incidents.md`, "Three deploys died on a test that raced the second hand").

- **A test file must never reach the LIVE gateway — not its home, not its
  roster.** `deploy.sh --restart` runs this suite on the box, where the
  defaults ARE production. `tests/helpers.js` points `OLMA_OPENCLAW_HOME` and
  `OLMA_OPENCLAW_CONFIG` at a temp dir, and `intake/production-guard.js` throws
  if a process with `NODE_TEST_CONTEXT` set resolves anything under
  `/root/.openclaw`. Both are needed: isolation travels by environment and is
  gone the moment a test spawns a child with a hand-built `env` instead of
  `{ ...process.env }` — which is how a test brokerd's `intake_sweep` came to
  provision real people out of a throwaway database, overwriting six identity
  files and leaving four agents bound to nothing, three times in two days.
  **Anything resolving one of those paths reads it per call, never captures it
  at module load** — as a constant, whether the isolation took depended on
  require order. (`incidents.md`, "The test suite provisioned into production".)

- **`OLMA_HEARTBEAT: 'off'` does NOT turn the sweeps off** — that is
  `OLMA_WORKER`. Two separate gates in `bin/olma-brokerd.js`, and the first
  reads like it means "quiet".

- **A test file must never write into a directory the other test files read.**
  They are separate processes over one filesystem. A decoy migration dropped
  into the real `migrations/` for a few milliseconds threw in every *other*
  file's `before` hook — and hung rather than failed, because a connected pg
  `Client` left open keeps a child's event loop alive for ever, and a child
  that cannot exit hangs `node --test` silently. Stage fixtures in
  `fs.mkdtempSync()`; `tests/shared-fixture-writes.test.js` enforces it
  (`incidents.md`, "A test file poisoned every other one").

- **A test child that cannot exit is invisible** — the runner waits on it for
  ever and never flushes its output, so the suite dies with no message.
  `freshDb()` therefore closes every client in a `finally`, bounds
  `pool.end()` (a client checked out and never released now fails by name,
  with the checkout's stack), and arms an unref'd exit watchdog.
  **`--test-timeout` does NOT cover this** — measured: it catches a hook or
  test that never *settles*, and does nothing at all for a file whose tests
  pass but which leaves a handle open. `tests/helpers-guards.test.js` proves
  both guards still fire.

- **A green from CI may be a retry.** The wedge above is fixed, but
  `olma2/scripts/run-suite.sh` stays as the backstop for the next child that
  cannot exit. CI and `deploy.sh` go through it; it retries a **hang** and
  never a failure:
  any non-zero exit is final and is reported as-is. **Do not widen that** — a
  wrapper that re-rolls a genuine red is how a flaky-test culture starts. It
  prints a banner on every wedge and names the attempt it passed on. **Seeing
  that banner now means a NEW hang** — diagnose it, do not bank the retry or
  raise `SUITE_ATTEMPTS`. A wedged child prints nothing, so make it report on
  itself: `NODE_OPTIONS=--require` a preload with an **unref'd** interval that
  dumps `process.getActiveResourcesInfo()` to a file.

CI (`.github/workflows/olma2-tests.yml`) runs the same suite plus a
`migrations` collision check, serialized on `main` so two merges cannot race
the same rollback snapshot.
