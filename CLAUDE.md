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

- **`olma2/docs/incidents.md`** — the full narrative of every incident,
  grouped by domain behind a linked contents list. Each rule below is
  a compression of one of them. **Read the entry before changing the code it
  describes**: the rule stops you repeating a mistake, the narrative stops you
  arguing with the rule when it looks inconvenient.
- **`olma2/docs/v1-reference.md`** — v1's schema, tools and dashboard.
  Retired-in-place; nothing routes there. For reading old code on the box
  only, and actively misleading if applied to v2.
- `olma2/docs/model-experiments.md` — dated model pilots.
- `README.md` — the ops runbook (connect, restart, update).

Both companions were split out of this file on 2026-09-03, verbatim, and more
has moved across since. **Nothing has ever been deleted** — when a passage
leaves this file it lands in one of those two. When you fix something, **the
rule goes here and the story goes in `incidents.md`**; that split is the only
reason this file is still readable, and it only holds if you keep doing it.
A long paragraph here is a bug: check whether the rule is already stated
above, and if it is, the paragraph belongs in `incidents.md`.

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
- **The gateway heartbeat stays OFF: `agents.defaults.heartbeat.every: "0m"`.**
  `target: "none"` only suppresses delivery; the 30-minute NO_REPLY turn
  still runs for every agent, and it was 82% of the model bill (2026-09-05,
  `incidents.md`, "The heartbeat was the bill"). Nothing of ours rides on it.
  `config_guard` goes red if it comes back; `scripts/disable-heartbeats.js
  --apply` turns it off again.

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
- **A reminder rung the GATE held is never chased; a rung OUR pipe lost is
  redone at once.** The discriminator is on the expired outbox row: the gate
  leaves `attempts = 0` and no `last_error`, a dead pipe leaves both. The
  redo goes out under the next rung's key with the plain wording, keeps the
  urgency of the rung it replaces, and still spends a rung so a broken pipe
  cannot loop (`incidents.md`, "The reminder that could not climb").

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
- **The turn opens itself, from the gateway's own hook, before the model's
  first call.** `gateway-hooks/olma-turn-open` (synced by `deploy.sh` to
  `/root/.openclaw/hooks/`, enabled by `hooks.internal.entries`, loaded at
  gateway STARTUP) sends brokerd `turn_open` on every accepted inbound
  message; brokerd counts the message, wakes the person, puts the 👀 on, and
  holds the open for the shim connection to adopt on its first tool call —
  nothing counted twice, every mark on the real message id (`incidents.md`,
  "The reply's first six seconds were bookkeeping"). `turn_start` still works
  and is now a no-op on the record when the gateway got there first.
- **A turn Olma started is not a message from the person.** `--deliver` reaches
  the agent on the person's own agent and session key, so nothing in the MCP
  call distinguishes it from typing — `domain/self-initiated.js` marks it and
  `turn_start` must honour that mark. Unmarked, it moved `last_inbound_at`
  (killing `isDeafOnDayOne`), reset `checkin_misses` (killing the check-in
  backoff), wrote `message.received` (the response-rate numerator counted our
  own sends as replies) and spent the once-per-life first-turn signal.
  **The mark outlives the delivery CLI by a minute** (`self-initiated.js`,
  `OLMA_SELF_INITIATED_GRACE_MS`): the agent's turn keeps running after
  `--deliver` returns, and its late `turn_start` was counted as the person
  writing — five times for one silent user (`incidents.md`, "Four good
  mornings to a man who had stopped answering").
- **Nobody is asked a question they have already not answered once.** The
  check-in ladder after one miss: three days of quiet, then a one-liner with
  no question mark; two misses → weekly; three → nothing until they write
  (`jobs/checkin.js`, `requiredGapMs`, `pickRung(…, misses)`). What is
  THEIRS — a meeting waiting on them, a deadline tomorrow — still outranks
  the quiet.
- **A WhatsApp reply names ONE message, and only the MODEL is ever told which.**
  The gateway carries it end to end — `reply_to_id` in `Conversation info`, the
  quoted text in a `Reply target of current user message` block — and nothing
  server-side receives either, so there is no fix available outside the prompt.
  Measured 2026-09-05: the block alone changes nothing. The same conversation
  with it and without it produced the same answer, because nothing had told the
  model it meant anything. `turn_start`'s `reply_to_id` (the model has to look
  for it) plus `hints.replyTarget` (arrives mid-turn, says to answer the quoted
  message) is what makes it land; `tests/reply-target.test.js` and eval
  `reply-to-older-message` hold both halves open.
- **The ledgers are append-only.** Rows already written stay as written, even
  when the pricing that produced them was wrong.
- **A meeting negotiates several options (`domain/meeting-options.js`, up to
  four; a fifth from a non-initiator waits for the initiator). The single-slot
  columns `meetings.proposed_slot/proposed_start_at` and
  `meeting_participants.state` are MIRRORS of the newest active option** —
  read them if you like, but write only through the options module
  (`add/answer/approve/reject/swap`), which re-mirrors after every change.
  A yes must name one of the options on the table; the meeting confirms the
  moment one option is unanimous among the people still in it.
- **The assistant is עולמה / Allma; the system is still olma2.** The rename
  (2026-09-04) covers user- and operator-facing text only — repo, `/opt/olma2`,
  the services, the MCP tool prefix and `olma_identity` keep the old name.
  `docs/incidents.md` keeps the old spelling too: it quotes real messages, and
  correcting them would falsify the record. Two readers must answer to BOTH
  spellings and say so — `facts.SYSTEM_NOUN_RE` (old facts are still in the
  table) and the voice bridge's name check and Deepgram keyterms.
- **`due_at` is when the THING is; `remind_at` is the hour THEY named.** A task
  saved with a `due_at` arms its own reminder — an hour before a timed one,
  08:00 that morning for a day-shaped one (local midnight in THEIR zone is the
  discriminator) — and "תזכיר לי מחר ב-19:00" is not that: pass 19:00 as
  `add_task`'s `remind_at` and it replaces the automatic row rather than
  joining it. **Olma states the hour she will remind them, so the ARMED moment
  rides the result** (`remindersAt`, in their zone) and no other time is
  available to say. Yahav was told 19:00 for a reminder set to 18:00 while the
  identical request beside it came out right, because that one the model
  happened to correct by hand (`incidents.md`, "Yahav's first evening"). `domain/auto-reminder.js` decides when,
  `reminders.attachAutoReminder` is the only writer of `auto = true`, and an
  explicit `set_task_reminder` cancels the pending auto row rather than joining
  it. This REVERSED "never set one unasked" (2026-09-04, same day it was
  added): the half that was right — a calendar ask is one thing, not a task and
  a reminder as well — moved to `create_calendar_event`'s own description,
  where the model reads it at the moment it would make that mistake.

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
- **A joiner nobody has reached is asked about as a PERSON, not a config.**
  `config_guard.checkUnreachableJoiners`: onboarded a day ago or more,
  nothing ever delivered to them (a `sent_at` row with no `hold_reason`) and
  nothing ever received. That catches a dead-from-birth agent, a dropped
  binding and the next silent failure of the same shape alike. Dashboard row,
  not `BREAKS_USERS`. It is the opposite of `isDeafOnDayOne`, which needs two
  onboarding messages to have LANDED and then sends less.
- **`liveness_watch` repairs before it reports.** Every five minutes: gateway
  probe and delivery queue; two bad ticks before a word; a gateway down for
  two ticks is restarted (`intake/gateway-restart.js`, once per half hour) and
  probed again; the news goes over WhatsApp — healed, stuck deliveries, or
  recovered — and a message that could not go out is `alertFailed` on the
  heartbeat. State in the `liveness_state` flag so a restart mid-outage does
  not re-alert. It speaks over the gateway's own pipe (owner's choice, no
  SMS), so a gateway that stays dead is repaired from here but reported only
  by the external monitor.
- **A new person's first three hours are read back by code, once, three hours
  in** (`jobs/onboarding-review.js`; the checks are pure, in
  `domain/onboarding-review.js`). It never messages them — it files one row per
  person, clean ones included, because a review that only appears when
  something is wrong cannot tell you the rate. A `bad` verdict means somebody
  was told something untrue or got no answer: a dashboard row and an alerts
  pill until acknowledged, never `BREAKS_USERS`. **Adding a check means adding
  its failing case to `tests/onboarding-review.test.js`** — the founding case
  is Yahav's real evening, replayed end to end, and a check whose failure
  cannot be written down is one nobody will trust in six weeks.
- **`/health` sees the DB, every `job_heartbeats` row, and the gateway — and
  nothing else.** A component that writes no heartbeat is invisible to it, and
  says so by staying green. That is how the gateway went unwatched for months
  while sixteen sweeps beside it were checked every minute.

### Two hostnames: allma.world is public, duckdns is admin

- **`allma.world` serves an ALLOWLIST, not the admin dashboard.** Caddy passes
  a named set of routes to `:8788` — `/pick/<48 hex>`, `/d/<64 hex>`, `/me`,
  `/me/data`, `/me/events`, `/me/act`, `/me/out`, `/oauth/google/callback`,
  `/health`, `/ready`, and the two stranger-readable pages `/` and `/privacy`
  — plus `/voice-bridge*` to `:8791`. Everything else 404s
  in Caddy and never reaches the app. **Read the Caddyfile for the current
  set** rather than this line: it said "exactly four" for a day and was wrong
  the moment the personal dashboard shipped. What does not change is the
  invariant — the list is exactly the routes the app serves ahead of its Basic
  Auth check, and **adding a public route to the app does not make it reachable
  — the Caddyfile has to say so too.** That cost the user dashboard its launch:
  the code deployed green, `/me` answered on `127.0.0.1:8788`, and every link
  sent to a person 404'd in Caddy (2026-09-04).
- **The admin dashboard lives ONLY on `olmachat.duckdns.org`.** It is not
  exposed on `allma.world` at all, not even behind Basic Auth.
- **Match `/pick/` on the exact token shape, never `/pick/*`.** A prefix match
  lets a malformed token fall past `picker.TOKEN_RE` into the Basic Auth
  check, so a truncated WhatsApp link answers a user with the ADMIN password
  prompt on the public domain (`incidents.md`, "A truncated link asked a user
  for the admin password"). The dashboard link follows the same rule —
  `^/d/[a-f0-9]{64}$`, and the five `/me` routes named one by one rather than
  `/me*` — for exactly that reason.
- **Three places hold the domain and none of them are in the repo**:
  `/etc/caddy/Caddyfile`, `/opt/olma/google-oauth.json` (`public_base_url`,
  which builds the OAuth `redirect_uri`), and `/opt/olma2-voice-bridge/server.js`
  (the `<Stream>` TwiML URL). The fourth, the `public_base_url` **flag**, is DB
  state and drives `/pick/` links only — it is NOT the one OAuth reads. A
  deploy cannot touch any of the four, and a rollback cannot restore them.
- **`google-oauth.json` is cached at module level** (`clientConfig()`), so
  editing it does nothing until `olma2-dashboard` restarts.
- **A redirect URI must be registered at Google BEFORE the file points at it**,
  and both hostnames stay registered during any move. Verify against Google
  rather than the console UI: drive a consent URL and check whether it reaches
  the sign-in page or `redirect_uri_mismatch`, **with a known-bogus domain as a
  control** — without one the probe reads "accepted" for everything.
- **Changing the domain never invalidates an existing Google connection.**
  `redirect_uri` belongs to the authorization-code exchange only; the refresh
  grant sends `client_id`/`client_secret`/`refresh_token` and no URI. Re-consent
  is needed only if the **client_id** changes — which is why a second OAuth
  client is the dangerous mistake here, not a second redirect URI.

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
- **The doctrine is FULL: 39,229 of the 39,250 chars the gateway will inject
  (2026-09-05; it was 39,249 the day before).**
  Over the line nothing is announced — `trimAgentsBootstrapContent` keeps a
  head and a tail and deletes the middle of whichever section sits at the cut.
  So a paragraph added there must be paid for by deleting one, and the default
  answer is to put the instruction in the TOOL RESULT instead, where it costs
  tokens only on the turns it applies to (`turn_start`'s `onboarding` string,
  2026-09-04). `tests/intake.test.js` fails before anything is lost.
  The health board shows the rendered size against the gateway's ceiling
  (`doctrineMeter` in `dashboard.js`) — an unreadable config reads as an
  unknown ceiling, never as the gateway's 20k default.
- **The tool schemas have a ceiling too: 55k chars of JSON, 700 per
  description, the identity line under 40** (`tests/tool-schema-budget.test.js`).
  They are injected on every turn for every user, so guidance about what to
  do with a RESULT rides the result (`turnHints`, `set_my_timezone`'s `hints`),
  where it costs tokens only on the turns it applies to — never the
  description. Adding a tool means paying for it by trimming another.
- **When brokerd has put a 👍 on their message, the result says so
  (`hints.markPlaced`) and the model answers `NO_REPLY` unless words add
  something** — a question, a caveat, an error. A sentence after the mark is
  a second notification for the same fact (Miron, 2026-09-05: "deleted ✅"
  under a 👍). The mark table is `reactions.TOOL_MARKS`; the undo-shaped
  tools (archive, cancel reminder, edit, forget) earn the same 👍 as a capture.
- **One in-flight reaction per message.** A mark is a whole `openclaw` CLI
  start-up (15s wall on the box), so a short turn has the 👀 and the 👍 alive
  at once and the LAST to finish wins. `placeMark` kills an older child still
  starting up when a newer mark arrives for the same message; one that
  already exited is simply replaced on the phone.
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

## The live dashboard is v2's (`olma2/src/adapters/http/dashboard.js`)

`olma2/docs/v1-reference.md` describes **v1's** dashboard, which is dead — its
"5 edits with a positional param on `renderPage(...)`" recipe does not apply
here and following it wastes a session. This is the one that serves both
https://allma.world and https://olmachat.duckdns.org.

Same house style — zero deps, Basic auth, server-rendered HTML + form POSTs,
no JS — but structured differently:

- **Since 2026-09-05 the file is split:** `dashboard.js` is the router (auth,
  CSRF, the OAuth callback, the GET/POST handlers, ~490 lines);
  `admin/sections/*.js` are the section renderers (one file per group of
  related sections), `admin/sections/index.js` holds `GROUPS` and `SECTIONS`,
  `admin/user-page.js` and `admin/contacts.js` are the two separate pages,
  `admin/posts.js` the per-user POST handlers and `safeBack`, `admin/html.js`
  the shell, `STYLE` and the formatting helpers. Exports are unchanged.
- **Since 2026-09-05 the page is six collapsible groups** (`GROUPS`, CSS-only
  `<details>`), only the first open on load, with an alerts strip inside it
  built from signals the sections already compute (`collectAlerts`, one
  extra query). Every `SECTIONS` entry names its `group`; a section with an
  unknown group falls off the page, and the suite checks the two agree. The
  old outbox and boost sections are blocks inside "מה מתוכנן להישלח" and
  "הגדרות מערכת"; the reaction vocabulary (`reaction_emoji`) is edited there
  too, one box per state via `POST /reactions` — never as a JSON flag row.
- **The personal dashboard (`docs/design/user-dashboard.html`, served as-is)
  creates coordinations and adds, answers, approves and swaps candidate times
  through `/me/act` actions that call the SAME domain functions as the chat
  tools** (`user-dashboard-write.js` → `meeting-options.js`). Picks arrive as
  `{day, part | time}` in the person's own terms and become an instant in
  their zone in `meeting-option-moment.js`; never convert in the browser. A section form may send `back=/#<id>`; `safeBack` accepts
  only ids the page renders.
- **Sections are a named array, not positional args.** `const SECTIONS = [{ id,
  title, hint, render }]`, rendered in order by the `GET /` handler. Adding one
  is a single entry plus its `render*(client, csrf)` function; the `hint` is
  required by convention, because this is a tool someone reads daily and an
  unlabelled table is a puzzle. **Read the array for what exists** — it was
  listed here once and was wrong within a fortnight (10 named, 15 live).
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
- **`MEMORY.md`** — curated long-term summary, folded from daily notes by a weekly root-crontab sweep (`memory-consolidation-sweep.js`, Sunday 03:00 — deliberately not `openclaw cron add`, see gotcha above).
- Deliberately no embedding key / no `active-memory` plugin — `memory_search`/`memory_get` use free keyword (FTS5/BM25) search, on-demand only, to keep steady-state cost near zero.
- **Contact/phone-number facts never belong in memory files** — that's what `connections` + `set_contact_label` are for (structured + tool-backed, not prose the model might mis-recall).

## Testing

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
