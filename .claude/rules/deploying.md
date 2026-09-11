---
paths:
  - "olma2/migrations/**"
  - "olma2/scripts/deploy.sh"
  - "olma2/scripts/rollback.sh"
  - "olma2/scripts/run-suite.sh"
  - "olma2/scripts/prune-releases.sh"
  - ".github/workflows/**"
---

# Migrations and deploying

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Migrations and deploying" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **Pick a migration number above `SELECT max(version) FROM schema_migrations`
  on the box** — never `ls migrations/`. Two branches in flight cannot see
  each other's files; this collided three times in two days. CI's `migrations`
  job catches it in seconds. Never renumber one already applied anywhere.

- **Keep migrations additive and backward-compatible.** `deploy.sh --restart`
  rolls back **code only** — an applied migration stays applied.

- **`bash olma2/scripts/deploy.sh --restart` is a real production deploy**, and
  CI runs it on every merge to `main`. Merging is deploying.

- **…but only for paths CI watches — `olma2/**` and the workflow file. Anything
  else merges with NO checks at all, and no checks looks exactly like green.**
  A `CLAUDE.md`-only change gets neither `test` nor a deploy; `olma2/docs/
  incidents.md` matches the filter, so a pure prose edit there runs the full
  suite AND redeploys production. Both are "docs" — which side of `olma2/` the
  file sits on decides the blast radius, and nothing in the filename says so.
  A new top-level directory is unchecked until someone notices; give it its
  own light job rather than adding it here, which would redeploy `olma2` for
  a change that cannot affect it — `voice-bridge/` has one
  (`.github/workflows/voice-bridge.yml`, which also deploys it on `main`).

- **After a shared-branch merge, verify it actually shipped**:
  `git merge-base --is-ancestor <sha> origin/main`. A concurrent session can
  merge at a head that predates your commit.

- **A dead CI run arrives under EITHER conclusion, so the conclusion string
  tells you nothing.** The job timeout reports `cancelled`; `run-suite.sh`
  exhausting its retries exits 1 and reports `failure`; and on `main` a
  *queued* run is cancelled outright when a later merge displaces it (the
  concurrency group holds only one pending run) — that last one is benign, the
  displacing sha being a descendant and `deploy.sh` rsyncing the whole tree.
  The wedge banner in the log is the tell, and
  `git merge-base --is-ancestor <my-sha> <deployed-sha>` settles whether your
  commit shipped regardless of how the run ended.

- **On a PR, a pass on either run is authoritative once the branch contains
  main** (`--is-ancestor origin/main origin/<branch>`) — both then compile
  identical bytes, so any difference is the host.

- **A wedged `test` on `main` skips `deploy` silently and main ships nothing**
  — `deploy` is `needs: test`, and `main` has no `pull_request` run to fall
  back on. Re-run it; if it wedges again, deploy the merged sha yourself with
  `deploy.sh --restart` (same suite, on the box, at `--test-concurrency=2`,
  where it does not wedge). The `deploy_drift` dashboard row
  (`jobs/deploy-drift.js`) reports this gap hourly — a row and never an alert,
  since being a few commits behind breaks nobody.

- **A merge can produce NO run at all, and that is the one failure with
  nothing to re-run.** On 2026-09-08 the merge of PR #285 to `main` created no
  workflow run and no check suite — `gh run list` showed the branch's own
  green runs and nothing for the merge commit — so `main` held code the box had
  never seen and everything looked finished. **`gh api repos/<o>/<r>/commits/
  <sha>/check-suites --jq .total_count` returning `0` is the tell**, and the
  `RELEASE` sha is what proves it. The recovery is `gh workflow run
  olma2-tests.yml --ref main` (the `workflow_dispatch` trigger exists for this
  and deploys exactly as a push does). **A laptop `deploy.sh` is NOT the
  fallback on a Mac** — Apple's rsync has no `--chown`, so it aborts after
  archiving the outgoing release and before touching anything
  (`incidents.md`, "The merge that never ran").

- **A red `deploy` is EITHER a wedge or a real failure, and they take opposite
  actions** — `run-suite.sh`'s banner is what tells them apart, so read it
  before deciding a re-run means anything. A solo on-box suite runs ~234s
  against `SUITE_TIMEOUT=420` (measured 2026-09-06), so a second thing holding
  the CPU pushes both past the cap and both report as wedges.

- **A red suite inside `deploy.sh` leaves a MIXED box and does not roll back.**
  The order is rsync → RELEASE marker → `npm install` → migrations → suite →
  restart, so a failure aborts before the restart and `roll_back` never runs —
  correctly, nothing was replaced. New code and applied migrations on disk, old
  code in memory, `/ready` 200, users served as before. `RELEASE` and
  `ActiveEnterTimestamp` disagreeing is this state. Whether it is harmless
  depends on which files moved: `bin/olma-brokerd.js` is long-lived and holds
  the old ones, while the MCP shim re-execs per tool call — check, do not
  assume.

- **The `sha` in `/opt/olma2/RELEASE` is the ONLY unambiguous answer to "is
  production running what I merged."** Everything else is inference about how
  it got there. Timestamps lie in BOTH directions: the marker is written
  before the on-box suite and long before the restart, so on a healthy deploy
  it leads both units by up to ~14 minutes — the identical signature to a
  deploy that died before restarting — while a manual `systemctl restart`
  inverts it just as misleadingly. `pgrep` separates them only if you **read
  what it matched**: the obvious patterns also match your own monitoring
  shell, and a wait-loop built on one never exits. For "did THIS deploy
  restart it", take a baseline before starting. (`incidents.md`, "The deploy
  marker leads the restart".)

- **The marker's `origin` field is load-bearing** — `github-actions run <id>`
  gives you a run to go and read; `local <user>@<host>` is a laptop deploy
  that left no CI record anywhere.
