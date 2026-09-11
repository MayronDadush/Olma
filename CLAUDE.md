# Olma — architecture reference for Claude Code

Ground truth for the live system, so a fresh session doesn't need several SSH
explorations to get oriented. **If this file and the server disagree, the
server wins** — update the file, and never trust it blindly for something you
are about to act on.

## How this file is organised (read this first)

This file is loaded into **every** session, in full, on every turn. On
2026-09-11 it was 1,757 lines and roughly 30,000 tokens, and most of it was
about one subsystem or another: a session working on the voice bridge paid for
the reminder ladder on every message it sent. So the rules now live beside the
code they govern.

| | |
|---|---|
| **[Rules that break production](#rules-that-break-production)** | Every rule, by its headline, grouped by the file that holds it. The bodies are in `.claude/rules/`. |
| **[Recurring failure shapes](#recurring-failure-shapes)** | The mistakes this project keeps making in new disguises. Cross-cutting, so they stay here. |
| **[What is live](#what-is-live)** · **[Server](#server)** | Orientation and reference. |
| **[Known gaps](#known-gaps)** | Real, open, and not being worked on. |

### How the rules files work, and the one way they fail

`.claude/rules/*.md` carry a `paths:` list in their frontmatter, and Claude
Code loads a file's body when it **Read**s a file matching one of those globs.
The headline of every rule stays here, so you always know a rule exists and
which file to open even when its body has not loaded.

**Measured on 2026-09-11, because it decides whether this split is safe: a
`Read` of a matching file loads the rule, and a `cat`/`sed`/`grep` of the same
file through Bash does NOT.** Both directions were tested with a canary rule.
That is survivable because an `Edit` requires a `Read` of the file first — so
the rules governing a file are in front of you before you may change it — but
it leaves one real hole: **editing a file with `sed` or a heredoc bypasses
both.** If you are about to write to a file that way, `Read` it first, or open
its rules file by hand. Same shape as everything else here: the tool boundary
enforces it, the prose only asks.

Two companion files are **not** auto-loaded — open them when relevant:

- **`olma2/docs/incidents.md`** — the full narrative of every incident,
  grouped by domain behind a linked contents list. Each rule is a compression
  of one of them. **Read the entry before changing the code it describes**:
  the rule stops you repeating a mistake, the narrative stops you arguing with
  the rule when it looks inconvenient.
- **`olma2/docs/v1-reference.md`** — v1's schema, tools and dashboard.
  Retired-in-place; nothing routes there. For reading old code on the box
  only, and actively misleading if applied to v2.
- `olma2/docs/model-experiments.md` — dated model pilots.
- `README.md` — the ops runbook (connect, restart, update).

**Nothing has ever been deleted from this file.** Incident narratives moved to
`incidents.md` on 2026-09-03; rule bodies moved to `.claude/rules/` on
2026-09-11, verbatim, headline left behind. When you fix something, **the rule
goes in the right rules file and the story goes in `incidents.md`** — that
split is the only reason any of this is still readable. A long paragraph in
the root file is a bug.

> **A comment elsewhere in the repo that cites `CLAUDE.md, "<some section>"`
> means whichever file now holds that section — usually `incidents.md`, since
> 2026-09-11 sometimes `.claude/rules/`.** Section titles were carried over
> unchanged, so searching the quoted title still finds it. Those references
> were left alone deliberately rather than rewritten across a dozen files
> mid-flight — grep the title, not the filename.

---

## Rules that break production

Each of these has already cost an outage or a user-visible failure. If one
looks arbitrary or inconvenient, its full story is in `olma2/docs/incidents.md`
— read that before working around it.

**The headline is not the rule.** It is the reminder that a rule is there.
Open the rules file named in each block before you act on anything under it.

### Migrations and deploying

**`.claude/rules/deploying.md`** — migration numbering, what `--restart` guarantees, and the five ways a CI run lies to you.
Loads when you **Read** a file under `migrations/**`, `scripts/deploy.sh`, `scripts/rollback.sh` and 3 more.

- **Pick a migration number above `SELECT max(version) FROM schema_migrations` on the box**
- **Keep migrations additive and backward-compatible.**
- **`bash olma2/scripts/deploy.sh --restart` is a real production deploy**
- **…but only for paths CI watches — `olma2/**` and the workflow file. Anything else merges with NO checks at all, and no checks looks exactly like green.**
- **After a shared-branch merge, verify it actually shipped**
- **A dead CI run arrives under EITHER conclusion, so the conclusion string tells you nothing.**
- **On a PR, a pass on either run is authoritative once the branch contains main**
- **A wedged `test` on `main` skips `deploy` silently and main ships nothing**
- **A merge can produce NO run at all, and that is the one failure with nothing to re-run.**
- **A red `deploy` is EITHER a wedge or a real failure, and they take opposite actions**
- **A red suite inside `deploy.sh` leaves a MIXED box and does not roll back.**
- **The `sha` in `/opt/olma2/RELEASE` is the ONLY unambiguous answer to "is production running what I merged."**
- **The marker's `origin` field is load-bearing**

### Talking to the gateway (and systemd scope)

**`.claude/rules/gateway.md`** — writing openclaw.json, the three model lists, heartbeats, the daily session reset, and which units are user-scope.
Loads when you **Read** a file under `src/intake/openclaw-config.js`, `src/intake/provision.js`, `src/channels/**` and 9 more.

- **Never shell out to `openclaw config set`**
- **An invalid config is IGNORED, not rejected.**
- **A bindings-ONLY write is silently dropped.**
- **After a gateway version bump, diff `openclaw.json` against what `src/intake/openclaw-config.js` expects.**
- **Permission to use a model lives in THREE lists**
- **The live OpenRouter model names its providers in order**
- **The `Conversation info` block is prompt-only: the transcript keeps the bare text.**
- **Never poll `openclaw sessions list` on a timer**
- **The gateway heartbeat stays OFF: `agents.defaults.heartbeat.every: "0m"`.**
- **Every session resets daily: `session.reset: { mode: "daily", atHour: 2 }`**

### Delivering a message

**`.claude/rules/delivering.md`** — the delivery gate, quiet hours and quiet days, batching, merging, styles and what a verbatim sentence may say.
Loads when you **Read** a file under `src/outbox/**`, `src/domain/message-format.js`, `src/domain/message-merge.js` and 9 more.

- **`openclaw agent … --deliver` needs BOTH `--agent <id>` AND an explicit `--session-key`.**
- **Any outbound send via `child_process` must be `spawn(cmd, args, {detached:true, stdio:'ignore'}).unref()`**
- **The raw pipe (`openclaw message send`) needs `agents.defaults.systemAgent.agentId`**
- **The raw pipe goes over the gateway's own WebSocket now, with the CLI behind it**
- **Cancelling a queued message is an UPDATE, never a DELETE.**
- **A STYLE is chosen at delivery, off the recipient's channel, and a channel the table has never heard of gets PLAIN**
- **On the MODEL path a style is granted by a RESULT, never by a description**
- **What is the same every time is DRAWN, and only the sentence about it is a model's**
- **…and since 2026-09-10 the two lists a person ASKS for are drawn the same way**
- **The delivery gate is the chokepoint and a paused user has no exceptions**
- **Quiet HOURS and a quiet DAY draw different lines, and the digest is where they differ.**
- **`DEFAULT_WINDOW` (09:00-21:00) is no longer only a fallback — it is a sentence somebody read.**
- **That rung asks for the COUNTRY, not the city**
- **Only the PERSON writing releases a night-held row.**
- **Only rung 1 of a reminder is a moment THEY chose; every rung after it is one OLMA chose, and quiet hours apply to it.**
- **A reminder rung the GATE held is never chased; a rung OUR pipe lost is redone at once.**
- **Nothing Olma DECIDED to say goes out in front of an introduction she still owes.**
- **Reminders that come due in the same tick go out as ONE message, and the coalescing happens at DELIVERY, never at enqueue.**
- **A `--deliver` that TIMES OUT has very likely gone out, and is never retried.**
- **Anything else due in the same moment is ONE message too, and two rules say what may travel together**

### Turns, and what reaches the person

**`.claude/rules/turns-and-replies.md`** — who opens a turn, the queue mode, self-initiated turns, the reply target, NO_REPLY, repair jobs and the outbound leak gate.
Loads when you **Read** a file under `src/brokerd/**`, `src/domain/turn.js`, `src/domain/self-initiated.js` and 6 more.

- **The turn opens itself, from the gateway's own hook, before the model's first call.**
- **`messages.queue.mode` stays `followup`.**
- **A turn Olma started is not a message from the person.**
- **A WhatsApp reply names ONE message, and only the MODEL is ever told which.**
- **A DECISION to stay quiet is not a reply that got lost.**
- **A repair job fires precisely when the system's belief about itself is already wrong, so it must be the most sceptical thing in the codebase.**
- **A reply that got lost is RE-SENT, never re-answered.**
- **The model's own working-out is stopped in the GATEWAY, not by the doctrine.**

### Reminders, tasks and dates

**`.claude/rules/reminders-and-tasks.md`** — the three different questions about a pending reminder, ladders, duplicate titles, dating a task, and due_at against remind_at.
Loads when you **Read** a file under `src/domain/reminders.js`, `src/domain/tasks.js`, `src/domain/auto-reminder.js` and 10 more.

- **"What is still pending" must ask `attempts = 0`**
- **…and "what is still going to REACH them" is a THIRD question, which `attempts = 0` answers wrongly.**
- **Moving a task's date answers every rung that was chasing the old one.**
- **A task chases through ONE ladder — the one behind the LATEST reminder they asked for.**
- **A meeting negotiates several options (`domain/meeting-options.js`, up to four; a fifth from a non-initiator waits for the initiator). The single-slot columns `meetings.proposed_slot/proposed_start_at` and `meeting_participants.state` are MIRRORS of the newest active option**
- **An explicit reminder replaces the automatic one only on the SAME local day; on another day it stands beside it.**
- **An event is SAID, never only guessed, and it is never told back as a task.**
- **A task already OPEN on somebody's list is never saved a second time.**
- **A model asked to date something must first be told what time it is.**
- **A title need not restate the hour the row now carries, but only the SERVER may take it out.**
- **A day named with ל־ in a title dates the THING, not the task.**
- **`due_at` is when the THING is; `remind_at` is the hour THEY named.**

### People, silence, and data you must not get wrong

**`.claude/rules/people-and-quiet.md`** — the timezone that must never be NULL, the check-in ladder, the once-ever question, deleting a person, and the rename.
Loads when you **Read** a file under `src/jobs/checkin.js`, `src/jobs/onboarding-review.js`, `src/domain/users.js` and 5 more.

- **`users.timezone` must never be NULL**
- **Every time crossing a tool boundary needs an explicit offset.**
- **Nobody is asked a question they have already not answered once.**
- **A day-one step that has not gone out is REPLACED by the NEXT CHECK-IN of any kind, never joined by it.**
- **Somebody who has stopped answering hears nothing Olma decided to say, and nothing on their record is cancelled.**
- **A "once ever" question is stamped on the PERSON, never deduped on the route that asks it.**
- **Deleting a user is not deleting a person until the GATEWAY's intake session goes too.**
- **The ledgers are append-only.**
- **The assistant is עולמה / Allma; the system is still olma2.**

### Writing detectors and alarms

**`.claude/rules/detectors.md`** — what BREAKS_USERS means, ratios that describe one population, unreadable is not broken, and the two review jobs.
Loads when you **Read** a file under `src/jobs/**`, `src/domain/issues.js`, `src/domain/hebrew-quality.js` and 4 more.

- **`BREAKS_USERS` means exactly "their tool calls fail right now."**
- **A hint that fires on ordinary input is worse than no hint**
- **Her voice is checked by code, not by the judge.**
- **An issue title must be deterministic**
- **A ratio's numerator and its denominator must describe the SAME people, and the eval user is in neither.**
- **A thing that could not be READ is never a thing in trouble.**
- **But a check that goes quiet is indistinguishable from one that passes**
- **Stamp "we told them" only after the send confirms.**
- **A joiner nobody has reached is asked about as a PERSON, not a config.**
- **Every check that starts from `users` is blind to the person the gateway dropped**
- **`liveness_watch` repairs before it reports.**
- **A new person's first hours are read back by code TWICE — three hours in, and again after their first day**
- **The onboarding review only ever watches the FRONT DOOR; `promise_watch` watches everyone.**
- **The suite runs again on a schedule, at four hours of the day**
- **`/health` sees the DB, every `job_heartbeats` row, and the gateway — and nothing else.**

### The dashboard and the two hostnames

**`.claude/rules/dashboard-and-domains.md`** — which routes Caddy passes, why /pick/ is matched exactly, and how the admin page is actually structured.
Loads when you **Read** a file under `src/adapters/http/**`, `docs/design/**`.

- **`allma.world` serves an ALLOWLIST, not the admin dashboard.**
- **The admin dashboard lives ONLY on `olmachat.duckdns.org`.**
- **Match `/pick/` on the exact token shape, never `/pick/*`.**
- **Three places hold the domain and none of them are in the repo**
- **`google-oauth.json` is cached at module level**
- **A redirect URI must be registered at Google BEFORE the file points at it**
- **Changing the domain never invalidates an existing Google connection.**

### Doctrine, tools and reactions

**`.claude/rules/doctrine.md`** — the 39,250-char ceiling, the schema budget, the reaction table and markPlaced, Google scopes and links Olma may not invent.
Loads when you **Read** a file under `src/intake/agents-template.md`, `src/intake/provision.js`, `src/adapters/mcp/**` and 8 more.

- **`agents-template.md` reaches existing users only via `scripts/resync-agent-templates.js`.**
- **The doctrine is FULL: 39,229 of the 39,250 chars the gateway will inject (2026-09-05; it was 39,249 the day before).**
- **The tool schemas have a ceiling too: 55k chars of JSON, 700 per description, the identity line under 40**
- **When brokerd has put a 👍 on their message, the result says so (`hints.markPlaced`) and the model answers `NO_REPLY` unless words add something**
- **The owner's rule is that anything which CAN end in a like should**
- **The hint follows the MARK, not the spawn.**
- **A message that is only thanks is answered by a 🙏 and by nothing else.**
- **`markPlaced` is CONDITIONAL, so nothing else on the same result may be an unconditional instruction to write.**
- **One in-flight reaction per message.**
- **The shim's connection outlives the turn, so nothing per-turn may be latched to it.**
- **A model with nothing to relay passes something, not nothing.**
- **The 👀 on a person's message is the GATEWAY's**
- **`placeMark` claims nothing and therefore must SAY something.**
- **Olma never offers a capability without asking the thing that owns it.**
- **A carryover leak is repaired on a schedule, because nothing can name the writer.**
- **An instruction handed to the model may assert what its own columns hold, and not one word more.**
- **Telling the model to call a tool is not telling it what the reader of that tool's write actually checks.**
- **A fixture that writes the state by hand cannot notice the state is only ever reached the other way.**
- **The owner's opening copy is said ONCE, by whichever voice reaches the person first.**
- **A first message is not a hello, and the newest arrivals prove it.**
- **`gmail.readonly` is a RESTRICTED scope and everything else Olma asks for is merely SENSITIVE — the two words are different verification tracks, and one restricted scope prices the whole app onto the paid one**
- **Every NEW Google consent link goes through one door, and it is CLOSED**
- **A display name is not a word to be translated.**
- **Olma never claims a lookup it did not perform.**
- **A `url` in a tool result is delivered by the MODEL or not at all**

### In a group

**`.claude/rules/groups.md`** — the two identity doors, what a room may never be told, NULL as the honest third state, and the group outbox.
Loads when you **Read** a file under `src/domain/group-connections.js`, `src/domain/group-context.js`, `src/domain/groups.js` and 4 more.

- **Two identity doors, routed by the token PREFIX**
- **Nothing a group tool returns may carry the room's own row or anybody's reasons.**
- **NULL is the honest third state and a guess never acts.**
- **Everything a room hears unasked is fixed text on the raw pipe**
- **A sweep DECIDES and the `group_outbox` job SAYS**
- **TWO columns say somebody has written to Olma, because two voices can hear their first message.**
- **Being in the room IS the introduction, and it is not the inferred closeness the old rule forbids.**
- **The room reaches each member's OWN page as a group already made**
- **A member's message in the room opens the gate's fifteen-minute window for that room's coordination — and, since 2026-09-09, the room's own announcement window; nothing else**

### Testing

**`.claude/rules/testing.md`** — the pinned UTC pool, never depending on the hour, the production guard, and why a test child that cannot exit is invisible.
Loads when you **Read** a file under `tests/**`, `scripts/run-suite.sh`.

- **The test pool pins `Etc/UTC`**
- **Never let a test depend on the hour or the weekday it runs.**
- **A moment a test will later assert on is computed ONCE**
- **A test file must never reach the LIVE gateway — not its home, not its roster.**
- **`OLMA_HEARTBEAT: 'off'` does NOT turn the sweeps off**
- **A test file must never write into a directory the other test files read.**
- **A test child that cannot exit is invisible**
- **A green from CI may be a retry.**

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
- **A test that asserts on a replica of a query cannot fail when the original
  drifts.** Hand-copying a `WHERE` clause into the test to check "the dashboard
  would not show this" proves only that you can write the clause twice. Call
  the function production calls, even when that means rendering a page.
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
- The roster has changed repeatedly since — **read it, do not trust a list
  written here**. This line used to say `u-18`..`u-22` were removed on
  2026-09-01, and by 2026-09-06 four of them were back: not because anyone
  re-added them, but because a test-suite sweep provisioned phantoms into the
  live roster (`incidents.md`, "The test suite provisioned into production").
  An id present here is not evidence a person exists, and an id absent is not
  evidence one does not. The `intake` agent exists,
  so the v2 intake sweeps are live, not inert. Each user's DB
  `workspace_path` matches the gateway's configured workspace for their agent
  exactly (`/root/.openclaw/workspaces/u-<id>`) — the schedule-card feature
  below depends on that holding.
- The v1 dashboard is **down** (nothing on :4173, no systemd unit). Caddy
  serves **two** hostnames, both to the **v2** dashboard on `127.0.0.1:8788`,
  and the split between them is load-bearing — see
  [Two hostnames](#two-hostnames-allmaworld-is-public-duckdns-is-admin).

- **Source of truth: `olma2/` in THIS repo** (unlike v1) — ~22k lines src+bin,
  1,263 tests in 105 files as of 2026-09-05. `olma2/README.md` is its map, and
  `npm test` is the only count that is true today.
- **Where things are, since 2026-09-05:** agent tools are `src/adapters/mcp/tools/*.js`,
  one file per domain, and `registry.js` is only their ORDER (the gateway
  lists tools in it). Jobs are data in `src/jobs/registry.js`; `expectations.js`
  is the cadence, and `tests/job-registry.test.js` fails if the two lists
  disagree. `bin/olma-brokerd.js` knows neither by name.
- **Deploying is `bash olma2/scripts/deploy.sh [--restart]`**: rsync →
  `/opt/olma2/` → migrations → the full suite **on the server**. CI runs it
  with `--restart` on every merge to `main`, so **merging is deploying**; a
  local run without `--restart` leaves the restart to you.
- **What `--restart` guarantees** (stories in `incidents.md`: the 2026-08-22
  deadlock, "The rollback was one release deep", "Deploying doctrine no longer
  needs a second command"):
  - the outgoing release is snapshotted to `/opt/olma2-previous` (one deep,
    not a history) **and** archived to `/opt/olma2-releases/<utc-stamp>/`
    (newest 5, `prune-releases.sh`), each carrying a `RELEASE` marker naming
    the sha and subject it holds;
  - after restart it requires both services `active` **and `/ready` 200** —
    "tests passed in CI" never proves the live process came up. **`/ready`,
    never `/health`**: `/health` goes 503 for things a redeploy cannot fix (a
    sweep behind its cadence, a dead gateway) and gating on it deadlocked two
    deploys in a row;
  - a failed check restores `/opt/olma2-previous` and restarts, then still
    exits non-zero on purpose — a silently self-healed run hides the problem;
  - once healthy it resyncs `agents-template.md` into every user's workspace.
- **Rollback is CODE only, never migrations** — keep them additive. For a
  fault found days and several merges later, `/opt/olma2-previous` cannot
  reach back far enough: `scripts/rollback.sh --list`, `--to <stamp>`
  (describes), `--to <stamp> --yes` (acts). It archives what it replaces, so
  it is not a one-way door — but **git still has the bad commit and the next
  merge redeploys it.** Land a revert too.
- Postgres 16 local (`olma2` + `olma2_test` DBs), creds in `/opt/olma2/.env`
  (0600). Daily `pg_dump` 02:15 Asia/Jerusalem → `/root/backups/`, 14-day
  retention (root's crontab, not in the repo). **Off-box copy:**
  `scripts/backup-offbox.sh` (02:40, same crontab) uploads the newest dump to
  a private DigitalOcean Spaces bucket, verifies the size the bucket reports,
  prunes copies older than 30 days, and writes `job_heartbeats.backup_offbox`
  — green on success, `ERR …` on any failure, stale on the health board if it
  stops running. Config is `SPACES_KEY/SECRET/BUCKET/REGION` in the same
  `.env`; the dump holds encrypted credentials, so the bucket stays private.
  Restore drill: download, `gunzip`, `psql olma2_test < file`.
- Services: `olma2-brokerd` (unix-socket daemon: pg pool, flood counters,
  outbox worker + all sweeps, heartbeats in `job_heartbeats`) and
  `olma2-dashboard` (`127.0.0.1:8788`, Basic Auth creds in `/opt/olma2/.env`).
- **Every statement on a `createPool` connection is capped at 20s and a
  checkout waits at most 10s** (`src/db/pool.js`, `OLMA_DB_STATEMENT_TIMEOUT_MS`,
  `OLMA_DB_CONNECT_TIMEOUT_MS`; `0` disables). Both sit under the MCP shim's
  30s call timeout so a runaway query fails inside the tool call, by name.
  `migrate.js` and the test helper build their own clients and are exempt.
- **A sweep inside brokerd reads the gateway's session stores through
  `channels/sessions-async.js`, never `channels/sessions.js` directly.** Every
  export of `sessions.js` is synchronous (readFileSync, a read-only sqlite
  handle) and the daemon answers live users on the same loop; the facade runs
  the identical functions in a worker thread with a deadline. The dashboard
  and the eval harness are separate processes and keep calling `sessions.js`.

## Server

`ssh root@157.230.210.233` (key `~/.ssh/id_ed25519`). Ubuntu 24.04, Node 24,
**2 vCPU / 2GB since 2026-09-06** — the hostname still reads
`ubuntu-s-1vcpu-2gb-nyc1`, so `nproc` is the only honest answer, and older
comments and incident entries that say "one core" were true when written.
OpenClaw global npm package (`openclaw`). No `sqlite3` CLI on the box — use
Node's built-in `node:sqlite` (`DatabaseSync`) for any manual DB query.

This table used to list v1's paths — `/opt/olma/broker/`, the SQLite DB,
`/opt/olma-dashboard/` — as though they were the system. They are **retired**
(`olma2/docs/v1-reference.md`); nothing routes to them, and acting on them
costs a session. What is live:

| Component | Path |
|---|---|
| Code (MCP server, brokerd, dashboard) | `/opt/olma2/` |
| Live DB | Postgres `olma2` (creds in `/opt/olma2/.env`) |
| Schema | `olma2/migrations/` in-repo — never hand-edited on the box |
| Dashboard | `127.0.0.1:8788` → https://allma.world (public routes) + https://olmachat.duckdns.org (admin) |
| Caddy config | `/etc/caddy/Caddyfile` — **not** in the repo, not deployed |
| Google OAuth client | `/opt/olma/google-oauth.json` — v1 path, still live; **not** in the repo |
| Voice bridge | `/opt/olma2-voice-bridge/` — source in `voice-bridge/`, deployed by `voice-bridge/deploy.sh` (its own workflow, never by `olma2/scripts/deploy.sh`) |
| Which release is serving | `/opt/olma2/RELEASE` (sha + subject) |
| Previous release / dated archive | `/opt/olma2-previous`, `/opt/olma2-releases/` |
| OpenClaw config | `/root/.openclaw/openclaw.json` |
| Per-user workspaces | `/root/.openclaw/workspaces/u-<id>/` |
| Legacy/fallback workspace (agent `main`, not DB-tracked) | `/root/.openclaw/workspace/` |

**Standing gotchas** (only the ones that are not already rules above):
- `openclaw sessions list` with no flags shows only the DEFAULT agent — pass
  `--all-agents --json` to see per-user agents. (And never on a timer.)
- `openclaw cron add`, and other elevated gateway RPCs, can require a **device
  scope upgrade** approved via `openclaw devices`. That is a real permission
  gate (up to `admin` role), not a bug — it needs the account owner's explicit
  approval, so do not try to push through it non-interactively.
- The gateway **hot-reloads `openclaw.json` on file change, bindings
  included**, provided the binding is written in the same `saveConfig` as
  another hot change. This line used to say every binding change needed
  `systemctl --user restart openclaw-gateway`; that was measured and is wrong.

The long-form stories for the detached-spawn rule, the `--deliver` flags and
the systemd scope moved to `incidents.md` on 2026-09-04 — the rules for all
three are above, under [Rules that break production](#rules-that-break-production).

## Memory architecture (turned on 2026-08-14)

OpenClaw ships a three-tier memory system; it was previously just never
configured. Now live in every workspace:

- **`USER.md`** — tiny identity card, injected every turn.
- **`memory/YYYY-MM-DD.md`** — raw daily notes, auto-injected for the last 2 days on session start only (`agents.defaults.contextInjection: "continuation-skip"` — full bootstrap files no longer re-inject on every turn within a session, saving ~4-5k tokens/turn).
- **`MEMORY.md`** — curated long-term summary, folded from daily notes weekly in each person's own small hours by `jobs/memory-consolidation.js` (v1's root crontab was left behind by the cutover). **Since 2026-09-10 it is a direct model call and the SERVER writes the file** — the job reads the week's notes and the current file in Node, and the model only returns text. That is what makes the phone-number rule below enforceable: `usableMemory` refuses an answer carrying one, and a refused week is retried, never half-written. `{"changed": false}` is a real answer and still stamps the audit row, because that row is the schedule.
- Deliberately no embedding key / no `active-memory` plugin — `memory_search`/`memory_get` use free keyword (FTS5/BM25) search, on-demand only, to keep steady-state cost near zero.
- **Contact/phone-number facts never belong in memory files** — that's what `connections` + `set_contact_label` are for (structured + tool-backed, not prose the model might mis-recall).

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

## Reading this repo costs tokens, so large reads are blocked (2026-09-10)

`.claude/hooks/shunt.js` is a PreToolUse hook that **denies** a whole-file `Read`
(or a bare `cat`/`less`/`more`) of anything over `SHUNT_MIN_LINES`, default 350.
78 of 464 source files are over that line, and they hold 54,626 of the repo's
101,752 lines: 17% of the files carrying 54% of the mass.

The deny message names the three ways through — delegate to the `bulk-reader`
agent (`.claude/agents/bulk-reader.md`, a cheap model whose context is thrown
away and whose answer carries line numbers), read a targeted slice with
offset+limit, or grep. **Delegate to understand, slice to edit**: an edit needs
real line numbers, so make that read yourself rather than editing off a summary.

Targeted reads, pipelines, subagents and non-text files are never blocked, and
every error path allows the call — a hook that breaks reads is worse than none.
Same argument as `markPlaced` and the reply gate: an instruction in a prompt is
a request, and one at the tool boundary is a rule. Borrowed from
`spotify/portal-ai-plugins`.

## Known gaps

Real, open, and nobody is working on them.

### Monday is the only integration the cutover never got back

**Corrected 2026-09-04 — this entry used to say all of v1's integrations were
gone, and had been false since 2026-08-19.** Google is fully ported and live:
`domain/google-oauth.js`, `calendar.js`, `google-contacts.js`, `mail.js`, the
`/oauth/google/callback` route, and credential columns on `integrations`
(`credential_enc`, `refresh_enc`, `expires_at`). Six real connections on the
box — calendar ×4, contacts, gmail. A gap entry nobody re-checks sends the
next session to rebuild something that already works.

What is genuinely still missing is **Monday.com** (v1 had it read-only for one
user). No tools, no domain module, nobody has asked for it since the cutover.

### The gateway can only ever be watched from OUTSIDE itself — repaired from inside since 2026-09-05

`/health` checks it, and `liveness_watch` (`jobs/liveness-watch.js`) now
RESTARTS a gateway that has been down for two five-minute ticks, then says so
over WhatsApp once the pipe is back. What nothing here can do is report a
gateway that stays dead, a dead brokerd, a dead box or a dead network — every
alarm rides the gateway's own pipe (a Twilio SMS channel was built and removed
the same day at the owner's request). Those need an uptime monitor hitting
`https://allma.world/health` (public, unauthenticated, the hostname that
outlives the duckdns one), which needs the owner's account at a monitoring
service and does not exist yet.
