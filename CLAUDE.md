# Olma — architecture reference for Claude Code

Ground truth for the live system, so a fresh session doesn't need several SSH
explorations to get oriented. **If this file and the server disagree, the
server wins** — update the file, and never trust it blindly for something you
are about to act on.

## How this file is organised (read this first)

This file is loaded into **every** session, so it holds only what you need
*before* you know which part of the system you are touching:

| | |
|---|---|
| **[Rules that break production](#rules-that-break-production)** | The short list. Violating one of these has already caused an outage. |
| **[Recurring failure shapes](#recurring-failure-shapes)** | The mistakes this project keeps making in new disguises. |
| **[What is live](#what-is-live)** · **[Server](#server)** · **[Dashboard](#the-live-dashboard-is-v2s-olma2srcadaptershttpdashboardjs)** | Orientation and reference. |
| **[Known gaps](#known-gaps)** | Real, open, and not being worked on. |

Two companion files are **not** auto-loaded — open them when relevant:

- **`olma2/docs/incidents.md`** — the full narrative of every incident, 65
  entries grouped by domain behind a linked contents list. Each rule below is
  a compression of one of them. **Read the entry before changing the code it
  describes**: the rule stops you repeating a mistake, the narrative stops you
  arguing with the rule when it looks inconvenient.
- **`olma2/docs/v1-reference.md`** — v1's schema, tools and dashboard.
  Retired-in-place; nothing routes there. For reading old code on the box
  only, and actively misleading if applied to v2.
- `olma2/docs/model-experiments.md` — dated model pilots.
- `README.md` — the ops runbook (connect, restart, update).

Both companions were split out of this file on 2026-09-03, verbatim. Nothing
was deleted. When you fix something, **the rule goes here and the story goes
in `incidents.md`** — that split is what keeps this file readable.

> **A comment elsewhere in the repo that cites `CLAUDE.md, "<some section>"`
> and is not here means `olma2/docs/incidents.md`.** Section titles were
> carried over unchanged, so searching the quoted title still finds it. Those
> references were left alone deliberately rather than rewritten across a dozen
> files mid-flight — grep the title, not the filename.

---

## Rules that break production

Each of these has already cost an outage or a user-visible failure. If one
looks arbitrary or inconvenient, its full story is in `olma2/docs/incidents.md`
— read that before working around it.

### Migrations and deploying

- **Pick a migration number above `SELECT max(version) FROM schema_migrations`
  on the box** — never `ls migrations/`. Two branches in flight cannot see
  each other's files; this collided three times in two days. CI's `migrations`
  job catches it in seconds. Never renumber one already applied anywhere.
- **Keep migrations additive and backward-compatible.** `deploy.sh --restart`
  rolls back **code only** — an applied migration stays applied.
- **`bash olma2/scripts/deploy.sh --restart` is a real production deploy**, and
  CI runs it on every merge to `main`. Merging is deploying.
- **After a shared-branch merge, verify it actually shipped**:
  `git merge-base --is-ancestor <sha> origin/main`. A concurrent session can
  merge at a head that predates your commit.
- **A pending CI check is not "not yet" — it may be dead.** Compare the `push`
  and `pull_request` runs on the same SHA; if `--is-ancestor` says your branch
  contains main, both compile identical bytes and any difference is the host.

### Talking to the gateway

- **Never shell out to `openclaw config set`** — it can hang forever *after* a
  successful write. Read → modify → `JSON.stringify(cfg, null, 2)` → write.
- **An invalid config is IGNORED, not rejected.** The gateway logs one line and
  keeps serving the last valid config, so everything looks healthy while your
  change was never loaded. **After any config write, verify the gateway applied
  it** — not that the file says what you meant.
- **A bindings-ONLY write is silently dropped.** Bundle it with another hot
  change (provisioning writes agent + binding in one `saveConfig`).
- **After a gateway version bump, diff `openclaw.json` against what
  `src/intake/openclaw-config.js` expects.** Diffing catches a key that changed
  shape; it does not catch a NEW key that quietly became load-bearing. Only
  exercising the capability end-to-end catches that.
- **Permission to use a model lives in THREE lists** — `agents.defaults.models`,
  `models.providers.openrouter.models[]`, and
  `agents.defaults.modelPolicy.allow`. Two of three is registered-and-unusable,
  and invisible until an override is tried.
- **Never poll `openclaw sessions list` on a timer** — 2.9s of CPU per call on
  a 1-vCPU box, which directly slows every user's reply.

### Delivering a message

- **`openclaw agent … --deliver` needs BOTH `--agent <id>` AND an explicit
  `--session-key`.** Neither alone works: `--to` alone runs the turn on the
  DEFAULT agent, outside the user's real session, so their next reply has no
  context.
- **Any outbound send via `child_process` must be
  `spawn(cmd, args, {detached:true, stdio:'ignore'}).unref()`** — never bare
  `execFile`. The MCP process is torn down the moment the tool returns, and a
  child in its process group dies with it while reporting success.
- **The raw pipe (`openclaw message send`) needs
  `agents.defaults.systemAgent.agentId`** on a multi-agent roster, or every
  agent-less send refuses. Verify the pipe, never the file:
  `openclaw message send … --dry-run --json`.
- **Cancelling a queued message is an UPDATE, never a DELETE.** The row carries
  the `idempotency_key` that stops the sweep re-creating it.
- **The delivery gate is the chokepoint and a paused user has no exceptions** —
  not reminders, not urgent, not another user's fan-out.

### Data you must not get wrong

- **`users.timezone` must never be NULL** — NULL falls back to UTC in both the
  delivery gate and the digest sweep, running an Israeli user's quiet hours
  three hours off.
- **Every time crossing a tool boundary needs an explicit offset.** A bare
  local time is read as UTC. A phone number's country is not a location, and a
  well-formed-but-wrong time still needs a semantic cross-check.
- **"What is still pending" must ask `attempts = 0`**, not `sent_at IS NULL` —
  since the escalation ladder, a delivered row sits with `sent_at` NULL for up
  to a day.
- **The ledgers are append-only.** Rows already written stay as written, even
  when the pricing that produced them was wrong.

### Writing detectors and alarms

- **`BREAKS_USERS` means exactly "their tool calls fail right now."** Anything
  else is a dashboard row. Widening it makes the alert list mean two things,
  which is how an alert list dies.
- **An issue title must be deterministic** — it is the dedup key. A title built
  from unordered query results makes the guard file and close the same
  condition on alternating ticks.
- **A thing that could not be READ is never a thing in trouble.** An unreadable
  config, a failed billing API, a missing log: report it in the heartbeat, file
  nothing, alert nobody.
- **But a check that goes quiet is indistinguishable from one that passes** —
  so every path that declines to judge must say so somewhere.
- **Stamp "we told them" only after the send confirms.** Stamping first makes
  an outage swallow the alert for exactly the outage it exists to report.

### Editing the dashboard or domain

- **Admin edits go through the domain functions, never raw SQL**, so an
  operator's change is validated and audited like the agent's own.
- **After any preference/fact edit, call `refreshUserCard(pool, userId)` —
  after the transaction commits, never inside it.** USER.md is what the agent
  reads every turn.
- **Validate any `back` parameter through `safeBack()`**, or the admin becomes
  an open redirect.

### Doctrine

- **`agents-template.md` reaches existing users only via
  `scripts/resync-agent-templates.js`.** `deploy.sh --restart` now runs it
  automatically after the health check passes — a manual local deploy does not.
- **Olma never claims a lookup it did not perform.** No price, no stock level,
  no "מצאתי לך", no link to a RESULT — all of it asserts a fetch that never
  happened. `search_link` is the one exception and only because a link to a
  *search* claims nothing: the model supplies WORDS, `domain/search-link.js`
  builds the URL. A model that writes URLs eventually writes a fabricated one.

### systemd scope

- **Only `openclaw-gateway` is a user-level unit** (`systemctl --user`, needs
  `XDG_RUNTIME_DIR=/run/user/0`). `olma2-brokerd`, `olma2-dashboard` and
  `olma-voice-bridge` are **system-scope** — plain `systemctl`. Checking the
  wrong scope reads as a false "service is down".

---

## Recurring failure shapes

Not rules — the shapes this project keeps rediscovering. When something is
confusing, check whether it is one of these before theorising.

- **The detection layer nobody trusts.** Recorded five separate times: a
  detector that flags a *working* system, or files the same row for ever, or
  sits unread on a dashboard. Detection was almost never the missing piece —
  escalation and precision were. **A detector that can no longer fail is not a
  detector**; when you fix one, prove it still goes red for the real case.
- **Absence of evidence scored as evidence.** A silent agent read as "the fix
  worked" when it simply had nothing to say. A clean grep of a log file that
  turned out not to exist. `null` (could not read) and `[]` (read, found
  nothing) must never collapse into the same value.
- **We were a second writer to someone else's file.** The gateway's own
  migration was correct and still broke us, because our code wrote
  `openclaw.json` with the old schema in mind. Go through the running service
  (its CLI, its API) rather than its store.
- **A failure named after the wrong culprit costs a morning.** Our own 60s
  timeout was blamed on the provider, twice. Before naming a cause, check
  whether the thing you are blaming is even in the path.
- **A rollback cannot reach a file or a config.** Whatever wrote them has to
  put them back — `withTx` will not.
- **An alarm that overstates is spent the first time someone checks it.** This
  is why yellows wait for a second night, why the runway warning climbs tiers
  instead of repeating, and why alert wording is checked against reality at
  send time rather than at queue time.
- **The agent understood, and the outcome had nowhere to go.** A stop request,
  a goal said out loud, a name in front of us every turn. When the model does
  the right thing and nothing happens, **look for the missing tool, not the bad
  prompt.**
- **A flag the writer sets and the reader ignores is worse than no flag,
  because it is a promise.**
- **A number nobody reconciles drifts in silence.** Cost was wrong in both
  directions for a month while every page looked healthy. Show the gap always,
  not only when it breaks.

---

## What is live

**Olma 2.0 serves users; v1 is retired in place** — its code still sits in
`/opt/olma/broker/` but nothing routes to it (`olma2/docs/v1-reference.md`).
Verified on the box at the cutover, 2026-08-17:

- `openclaw.json` `mcp.servers` has exactly ONE entry, `/opt/olma2/bin/olma-mcp.js`.
  v1's `olma-mcp.js` is not registered, so **every v1-only tool is dead** —
  Google Calendar and Monday included (see [Known gaps](#known-gaps)).
- The roster has changed repeatedly since (`u-18`..`u-22` were removed
  2026-09-01) — **read it, do not trust a list written here**; the `intake`
  agent exists,
  so the v2 intake sweeps are live, not inert. Each user's DB
  `workspace_path` matches the gateway's configured workspace for their agent
  exactly (`/root/.openclaw/workspaces/u-<id>`) — the schedule-card feature
  below depends on that holding.
- The v1 dashboard is **down** (nothing on :4173, no systemd unit). Caddy
  serves `olmachat.duckdns.org → 127.0.0.1:8788`, i.e. the **v2** dashboard.

- **Source of truth: `olma2/` in THIS repo** (unlike v1). ~4.9k lines src+bin,
  116 tests. `olma2/README.md` is its map. Deploy+test:
  `bash olma2/scripts/deploy.sh` (rsync → `/opt/olma2/` → migrations → full
  suite on the server). **CI auto-deploys on every merge to `main`**
  (`.github/workflows/olma2-tests.yml`, `deploy` job — runs the same script
  with `--restart`, so `olma2-brokerd`/`olma2-dashboard` restart automatically
  once the remote suite passes). A manual local run of `deploy.sh` still
  leaves restart to you unless you also pass `--restart`.
  **`--restart` also carries a rollback safeguard** (added 2026-08-20): before
  the new code is synced, the currently-deployed release (code + its own
  `node_modules`) is snapshotted whole to `/opt/olma2-previous` (one snapshot,
  not a history). After restart, `deploy.sh` waits 5s and checks both services
  are actually `active` AND the dashboard's own `/health` (DB + job-heartbeat
  sanity, `adapters/http/dashboard.js`) returns 200 — "tests passed in CI"
  never proves the live process came up. If that check fails, it restores
  `/opt/olma2-previous` over `/opt/olma2` and restarts again, then the CI run
  still exits non-zero on purpose (a silently self-healed run hides the
  problem). Once healthy, `--restart` also resyncs `agents-template.md` into
  every existing user's workspace (`incidents.md`, "Deploying doctrine no
  longer needs a second command"). **This rolls back CODE only — never DB
  migrations.** A
  migration that already ran stays applied even after a code rollback, so keep
  migrations additive/backward-compatible rather than relying on this to
  undo one.
- Postgres 16 local (`olma2` + `olma2_test` DBs), creds in `/opt/olma2/.env`
  (0600). Daily `pg_dump` 02:15 → `/root/backups/`, 14-day retention.
  **The dump lands on the same droplet it backs up — no off-box copy yet.**
- Services: `olma2-brokerd` (unix-socket daemon: pg pool, flood counters,
  outbox worker + all sweeps, heartbeats in `job_heartbeats`) and
  `olma2-dashboard` (`127.0.0.1:8788`, Basic Auth creds in `/opt/olma2/.env`).

## The live dashboard is v2's (`olma2/src/adapters/http/dashboard.js`)

`olma2/docs/v1-reference.md` describes **v1's** dashboard, which is dead — its
"5 edits with a positional param on `renderPage(...)`" recipe does not apply
here and following it wastes a session. This is the one that serves
https://olmachat.duckdns.org.

Same house style — zero deps, Basic auth, server-rendered HTML + form POSTs,
no JS — but structured differently:

- **Sections are a named array, not positional args.** `const SECTIONS = [{ id,
  title, hint, render }]`, rendered in order by the `GET /` handler. Adding one
  is a single entry plus its `render*(client, csrf)` function; the `hint` is
  required by convention, because this is a tool someone reads daily and an
  unlabelled table is a puzzle. Current order: health, users, issues, cost,
  metrics, planned, outbox, flags, waitlist, audit.
- **`/user?id=N` is a separate page**, not a section — the per-person
  drill-down (tasks, conversation, what is planned for them, preferences,
  facts, delete panel). `renderUserPage` builds it; sections are skipped
  entirely for that path.
- **Routing is `url.pathname`**, the opposite of v1's exact-`req.url` rule.
  Only `/health` (unauthenticated) still matches `req.url` exactly, and the
  Google OAuth callback matches on its own parsed pathname before auth.
- Every POST is CSRF-checked against a cookie, runs inside one `withTx`, and
  redirects 303. A per-user form carries a `back` field — validate it through
  `safeBack()`, never trust it, or the admin becomes an open redirect.
- **Admin edits go through the domain functions**, never raw SQL, so an
  operator's change is validated and audited exactly like the agent's own
  (`preferences.remember/forget`, `facts.rememberFact/forgetFact`). On top of
  the domain's own audit row, each writes an `admin.*` event so the trail shows
  where the change came from.
- **After any preference/fact edit, call `refreshUserCard(pool, userId)` —
  after the transaction commits, never inside it.** USER.md is what the agent
  reads every turn; skipping this puts the card out of sync with the DB, which
  is the exact bug fixed on 2026-08-19.
- **Cancelling a queued message is an UPDATE, never a DELETE**
  (`sent_at = now(), hold_reason = 'cancelled_by_admin'`). The row carries the
  `idempotency_key` that stops the sweep which produced it from producing it
  again — delete it and the message comes back on the next tick. Cancelled rows
  are excluded from the daily-budget count in `outbox/worker.js`, since nothing
  was ever delivered.
- Times shown and accepted per user are in **that person's** timezone; the
  conversion happens in Postgres (`AT TIME ZONE`) in both directions, so there
  is no offset arithmetic here to break at a DST boundary.

## Server

`ssh root@157.230.210.233` (key `~/.ssh/id_ed25519`). Ubuntu 24.04, Node 24,
OpenClaw global npm package (`openclaw`). No `sqlite3` CLI on the box — use
Node's built-in `node:sqlite` (`DatabaseSync`) for any manual DB query.

| Component | Path |
|---|---|
| Broker (MCP server + scripts) | `/opt/olma/broker/` |
| Live DB | `/opt/olma/olma.sqlite` |
| Schema (source of truth for NEW tables; drifted for old ones — see below) | `/opt/olma/schema.sql` |
| Dashboard | `/opt/olma-dashboard/server.js` → https://olmachat.duckdns.org |
| OpenClaw config | `/root/.openclaw/openclaw.json` |
| Per-user workspaces | `/root/.openclaw/workspaces/u-<id>/` |
| Legacy/fallback workspace (agent `main`, not DB-tracked) | `/root/.openclaw/workspace/` |

**Standing gotchas:**
- `openclaw config set` can hang forever after a successful write — never shell out to it. Edit `openclaw.json` directly (read → modify → `JSON.stringify(cfg, null, 2)` → write); the gateway hot-reloads config on file change, but **routing binding changes need `systemctl --user restart openclaw-gateway`** to take effect.
- `openclaw sessions list` (no flags) only shows the default agent — pass `--all-agents --json` to see per-user agents.
- `schema.sql` was stale for the original tables (`users`, `tasks`, `roundup_participants`, etc. all have live-only `ALTER TABLE` columns not in the file) — every broker test hand-applies the same ALTERs in its own `setupDb()`. A new column on an EXISTING table needs the same ALTER added to all 8 test files. A brand-new table (like `connections`) can just go straight into `schema.sql` — tests load it from there automatically.
- `openclaw cron add` (and other elevated gateway RPCs) can require a **device scope upgrade** approved via `openclaw devices` — this is a real permission gate (up to `admin` role), not a bug. Don't push through it non-interactively; it needs the account owner's explicit approval.
- **Any outbound send via `child_process` must be a genuinely detached spawn.** `olma-mcp.js` is a fresh process per turn (verified: no `olma-mcp.js` process persists between calls) and the gateway tears it down right after the tool response returns — a plain `execFile(...)` child shares that process group and dies with it before the send completes, even though the call reports success. Always `spawn(cmd, args, {detached:true, stdio:'ignore'}).unref()`, never bare `execFile`, for anything that must survive past the current turn (confirmed root cause of a real notification never arriving, 2026-08-14).
- **Any `openclaw agent ... --deliver` call needs BOTH `--agent <id>` AND an explicit `--session-key "agent:<id>:whatsapp:direct:<phone>"`.** Neither flag alone is enough — verified the hard way, 2026-08-14: `--agent <id>` alone leaves `--deliver` to guess a channel/target via best-effort inference, which fails outright for an established multi-session user (gateway log: `Delivering to WhatsApp requires target <E.164|...>`, no message ever sent). `--to <phone>` alone *does* deliver, but runs the turn on the DEFAULT agent (`main`), not the person's own isolated agent — the message lands outside their real, continuing WhatsApp session, so when they reply normally (routed via bindings, back to their real per-user agent) that agent has no memory of what they're replying to and improvises incorrect context. Only `--agent <id> --session-key "agent:<id>:whatsapp:direct:<phone>"` together puts the turn in the exact session their real replies continue in — confirmed end-to-end (delivered + correct session). Session-key shape matches `session.dmScope: "per-channel-peer"`; revisit if that config changes. Affects `fanout.js`, `welcome.js`, `checkin.js` — all three fixed 2026-08-14.
- **`openclaw-gateway` is the ONLY user-level systemd unit here — everything else is plain `systemctl`.** `olma2-brokerd.service`, `olma2-dashboard.service`, and `olma-voice-bridge.service` all live in `/etc/systemd/system/` and are checked/restarted without `--user`, no `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` needed. Confirmed 2026-09-01 after `systemctl --user is-active olma2-brokerd` (and `--user list-units`, even with the bus env vars set correctly for root's real, months-old session) reported it as not found/inactive while it was genuinely healthy — `/root/.config/systemd/user/` holds only `openclaw-gateway.service`. Checking the wrong scope on any of the other three reads as a false "service is down."

## Memory architecture (turned on 2026-08-14)

OpenClaw ships a three-tier memory system; it was previously just never
configured. Now live in every workspace:

- **`USER.md`** — tiny identity card, injected every turn.
- **`memory/YYYY-MM-DD.md`** — raw daily notes, auto-injected for the last 2 days on session start only (`agents.defaults.contextInjection: "continuation-skip"` — full bootstrap files no longer re-inject on every turn within a session, saving ~4-5k tokens/turn).
- **`MEMORY.md`** — curated long-term summary, folded from daily notes by a weekly root-crontab sweep (`memory-consolidation-sweep.js`, Sunday 03:00 — deliberately not `openclaw cron add`, see gotcha above).
- Deliberately no embedding key / no `active-memory` plugin — `memory_search`/`memory_get` use free keyword (FTS5/BM25) search, on-demand only, to keep steady-state cost near zero.
- **Contact/phone-number facts never belong in memory files** — that's what `connections` + `set_contact_label` are for (structured + tool-backed, not prose the model might mis-recall).

## Testing

From `olma2/`:

```bash
npm test          # node --test 'tests/*.test.js'
```

Real Postgres, one throwaway database per test file (`tests/helpers.freshDb`).
Two things the suite learned the hard way:

- **The test pool pins `Etc/UTC`**, because production does. A suite green only
  where the clocks agree is testing a configuration nobody deploys.
- **Never let a test depend on the hour or the weekday it runs.** Use
  `helpers.daytime()` and `helpers.slotStart()`; a hard-coded "Tuesday 17:00"
  or an unpinned `drainOnce` passes or fails depending on when you run it.
  The suite was green thirteen hours a day and red eleven before this.

CI (`.github/workflows/olma2-tests.yml`) runs the same suite plus a
`migrations` collision check, serialized on `main` so two merges cannot race
the same rollback snapshot.


## Exploring this repo: graphify — measured, not assumed (2026-08-28)

A `/graphify` skill is installed at the Claude Code user level
(`~/.claude/skills/graphify/`, CLI via `uv tool install "graphifyy[sql]"`) —
it builds a local knowledge graph of `olma2/` (AST-only, no LLM, nothing
leaves the machine) and answers architecture questions via
`graphify query "<question>" --graph olma2/graphify-out/graph.json`. Before
trusting the vendor's claims, this was A/B measured head-to-head in fresh
contexts, same question, with vs without:

- **Narrow question** (one specific enforcement point): graph cost *more*
  tokens (+1.6%) — no benefit, and the no-graph answer was more detailed
  because it read real code instead of graph metadata.
- **Broad question** (inventory across ~18 files): graph saved **16% fewer
  tokens, 60% fewer tool calls, 27% faster**. Real, but nowhere near
  marketing's advertised "49x" — this repo (149 code files) is plausibly too
  small for that multiple to show up.

**How to use it here:** reach for `graphify query`/`graphify explain` on
broad "where is X used across the system" or "inventory of every Y" style
questions; skip it for a narrow lookup where the file is already known —
plain grep is cheaper there. Treat graph output as a map to target real file
reads, never as a substitute for reading the actual code the answer depends
on.

**Three sharp edges:**
- The graph is a snapshot — it will confidently describe code that no longer
  exists if not refreshed. Run `graphify update olma2 --force` after
  meaningful changes (or `graphify extract olma2 --force` +
  `graphify cluster-only olma2 --no-label` for a full rebuild, needed once
  after adding `.sql` support).
- **Each git worktree needs its own `olma2/graphify-out/`** — it does not
  exist in a fresh worktree/clone; build it locally before relying on it.
  Keep it out of commits: it is excluded via `.git/info/exclude`, which is
  **per-clone and not shared**, so a new clone must add that line itself
  (the directory is ~2.5MB of generated JSON/HTML and belongs in no commit).
- The bundled `graph.html` visualization loads `vis-network` from `unpkg.com`
  — a sandboxed file-preview pane with no outbound network access will show
  it blank with `vis is not defined`; open the file directly in a real
  browser instead.

## Known gaps

Real, open, and nobody is working on them.

### Integrations were left behind by the cutover

v1 had per-user Google Calendar + Monday (`/opt/olma/broker/google-oauth.js`,
`crypto-store.js`, tools in v1's `olma-mcp.js`). v2 has an `integrations`
table but no credential columns, no `oauth_states`, no tools, and no
`/oauth/google/callback` route — and since the public host now points at the
v2 dashboard, the callback Google redirects to **404s**. One real connection
exists in the v1 SQLite DB (user `+972526269826`: calendar `read_write` +
Monday `read_only`). Porting it back is a restore, not a migration task; the
v1 tokens stay decryptable if v2 reuses `/opt/olma/.enc-key`.

### A reminder whose first rung died on the wire never climbs (2026-09-01)

The rent reminder above is still, hours later, the thing that did not happen —
and the escalation ladder cannot recover it. `dueForSending`'s rung-2 clause
requires the previous rung's outbox row to carry `sent_at IS NOT NULL AND
hold_reason IS NULL`. Row 5873 has `hold_reason = 'expired'`, so the EXISTS
never matches; `task_reminders#27` sits at `attempts = 1, sent_at NULL` for
ever, reads in `list_my_reminders` as one that never fired, and the ladder's
own retirement rule closes it two days later. The person is told nothing at
any point.

That check is right about the case it was written for — a rung the GATE held
or dropped (quiet hours, pause, budget) must not be chased, which is the
check-in ladder's documented bug refusing to repeat itself. What it cannot
see is **whose fault the non-delivery was**. `expired` covers both "we could
not reach them inside their own window" and "our pipe was broken for twelve
hours", and only the second deserves a retry. A fix has to split those —
plausibly on `last_error` being a delivery/transport failure rather than a
gate decision — and rung 1 cannot simply be re-enqueued under its own key
(`reminder:<id>` is already spent on the dead row, which is exactly the
guard that stops a duplicate reminder, the one outcome worse than a missed
one). Not built; recorded so the next reminder lost to an outage is
recognised as this and not re-diagnosed from scratch.

### Nothing detects "somebody joined and never became reachable"

We have a detector for an agent with no user (`checkOrphanAgents`) and none
for a user with no working agent — the half that was built is the half that
costs nobody anything. The buildable form asks about the PERSON, not the
config: `users.onboarded_at` set, no `outbox` row with `sent_at IS NOT NULL
AND hold_reason IS NULL`, and a few hours' grace (a 02:00 joiner is
quiet-hours-held, not broken). That catches a dead-from-birth agent, a
stuck-config agent, and every future failure of the same shape without
needing to know why.

### A dead gateway reads green on `/health` (2026-09-03)

`/health` measures the DB and the job heartbeats. **Nothing measures the
gateway** — the process every user's WhatsApp message goes through, in both
directions. So the page that exists to say "is Olma up" cannot see the one
component whose death is total: every inbound message dropped, every reply
undeliverable, and a solid 200 the whole time.

Found by accident, which is the point: a raw `message send` came back
`ECONNREFUSED` while `/health` was green. That instance was a concurrent
session's deliberate restart and lasted thirteen seconds, so it cost nothing
— but nothing about the page would have looked different at hour three. The
brokerd already knows how to reach the gateway (`runOpenclaw`), and the
gateway's own port is in the config, so this is one connect check away.

Same shape as the credit outage that ran thirteen hours behind a green board
and the workspace-seal failure that dropped 126 messages with `/health`
honestly reporting everything it measures. Detection that cannot see the
failure is not detection.
