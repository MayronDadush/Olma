# Olma — architecture reference for Claude Code

Condensed ground truth for the live system, so a fresh session doesn't need
several SSH explorations to get oriented. `README.md` is the ops runbook
(connect, restart, update); this file is the code map. Both live only here —
the actual code lives on the server (`/opt/olma/`, `/opt/olma-dashboard/`),
not in this git repo. If this file and the server disagree, the server wins —
update this file, don't trust it blindly for anything you're about to act on.

## ⚠️ v2 IS the live system (cutover done — verified 2026-08-17)

**Olma 2.0 now serves users.** Everything below "Multi-user architecture"
describes **v1**, which is retired-in-place: its code still sits in
`/opt/olma/broker/` but nothing routes to it. Verified on the box:

- `openclaw.json` `mcp.servers` has exactly ONE entry, `/opt/olma2/bin/olma-mcp.js`.
  v1's `olma-mcp.js` is not registered, so **every v1-only tool is dead** —
  Google Calendar and Monday included (see the integrations gap below).
- `agents.list` = `main, intake, u-3, u-8, u-9, u-10, u-11` (checked
  2026-08-19 — the earlier `u-7` here was stale); the `intake` agent exists,
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
  every existing user's workspace — see "Deploying doctrine no longer needs a
  second command". **This rolls back CODE only — never DB migrations.** A
  migration that already ran stays applied even after a code rollback, so keep
  migrations additive/backward-compatible rather than relying on this to
  undo one.
- Postgres 16 local (`olma2` + `olma2_test` DBs), creds in `/opt/olma2/.env`
  (0600). Daily `pg_dump` 02:15 → `/root/backups/`, 14-day retention.
  **The dump lands on the same droplet it backs up — no off-box copy yet.**
- Services: `olma2-brokerd` (unix-socket daemon: pg pool, flood counters,
  outbox worker + all sweeps, heartbeats in `job_heartbeats`) and
  `olma2-dashboard` (`127.0.0.1:8788`, Basic Auth creds in `/opt/olma2/.env`).

### The ledger overstated OpenRouter by 65%, in both directions at once (fixed 2026-09-03)

Building the owner's requested money-by-feature table surfaced that the
numbers behind it were partly invented: **$16.03 in `usage_ledger` against
$9.73 OpenRouter's own dashboard.** Three independent faults, each invisible
alone:

- **A model missing from `model-pricing.js`'s `RATES` was priced by whatever
  the caller happened to pass as a blended fallback rate — and the two
  callers pass opposite things.** The transcript sweep passes a real rate, so
  four pilot models were overstated 16x–54x (`gpt-5.6-luna` $2.538 ledger vs
  $0.157 real; `gpt-5.4-nano` $1.285 vs $0.035; `gpt-oss-120b` $1.097 vs
  $0.028; `qwen3.7-flash` $0.998 vs $0.019). `adapters/llm.js`'s `recordUsage`
  passes `null`, so the evals judge (`kimi-k2.6`) recorded **$0.000 against
  196k real output tokens** — ~$0.83 of real spend no page could show. A
  pilot arguing against a model on a number 16x too high is the opposite of
  what `docs/model-experiments.md` exists to do.
- **OpenRouter states the price it charged on every completion
  (`usage.cost`, authoritative USD — the same field media generation has
  recorded as-is since 2026-08-28) and it was thrown away.** It now wins
  whenever the provider gives one; the rate table is the fallback only.
  `0` is a real price and stays distinguishable from "not reported" — a
  truthiness check would have thrown one away with the other. Also
  discarded: `prompt_tokens_details.cached_tokens` / `cache_write_tokens` —
  so a warm prompt was billed as if every token were a fresh read, which
  matters more here than anywhere else: 53.2M of 54.5M input tokens are
  cache reads (97.6%).
- **`cost_usd numeric(10,4)` rounded every write to a hundredth of a cent,**
  and `recordUsage` does one `INSERT ... ON CONFLICT` per CALL — so anything
  under $0.00005 was added as exactly zero, forever, no matter how many.
  Live probe: a real `deepseek-v4-flash` completion costs $0.00000686, three
  orders of magnitude below what the column could store. Migration 027
  widens it to `numeric(14,8)` on all four ledgers (`usage_ledger`,
  `usage_system_ledger`, `media_usage_ledger`, `media_jobs`) — additive and
  backward-compatible, since `--restart` rolls back CODE only.

Rows already written stay as written — the ledger is append-only, same rule
as everywhere else in this file. The cost page's reconciliation line is what
makes the remaining gap visible instead of hidden.

### The carryover detector checked the wrong half of the pair, so the flagged case was innocent and the real leaks were invisible (fixed 2026-09-03)

The dedup fix below (`ORDER BY id`) stopped the flip-flop, but the single
surviving row it settled on — users 10 and 13 both holding "היי" — turned
out to be innocent: both really did say that. Auditing by hand inverted the
diagnosis: **two real leaks existed and neither could ever have produced a
duplicate-pair row**, because a leak *overwrites* — a stranger's words land
on exactly one card, so a detector built to find two cards agreeing has
nothing to match against. u-11 was carrying u-8's words; u-17 (Sarah) was
carrying u-14 (חיים)'s.

`config-guard.js`'s `checkCarryoverCollisions` now checks each card against
its OWN owner's real intake session FIRST (`quotesOwnWords`), independent of
whether any other card matches it — a leak with no twin is still a leak.
Only when a card passes that check does it get compared against others for
the (much rarer) copy-paste-collision case, and a `reported` Set stops the
same user id from being named twice across both passes. New
`domain/carryover-repair.js` (`repairCarryovers`, `stripCarryover`,
`classify`) removes — never rewrites — a carryover section whose text isn't
the owner's; `classify` uses containment, not equality, since the greeter
session keeps growing after provisioning, and a legacy section with no
`<<< >>>` fence is `unverifiable` and left alone rather than guessed at.
`scripts/repair-carryover-leak.js` (dry-run default) applied it to
production: 2 repaired, 2 verified as genuinely their own, 7 with no
carryover, 0 unverifiable. Cards backed up to
`/root/backups/carryover-leak-20260903/` first. Sarah's real request behind
the leaked text already existed as task 242 — nothing was lost, only
mis-attributed on the card.

### One carryover leak filed itself seven times — `config_guard`'s dedup key wasn't deterministic (fixed 2026-09-03)

`checkCarryoverCollisions` queried active users with no `ORDER BY`, then
built the issue title from `users ${prior} and ${u.id}` — whichever order
Postgres happened to return that tick. Postgres row order is **not**
guaranteed without an explicit `ORDER BY`, so the title flipped between
`"users 10 and 13"` and `"users 13 and 10"` from one sweep to the next.
`fileViolations` dedupes on title and `closeResolved` closes titles no
longer reported — so a non-deterministic title isn't merely duplicated, it
makes the guard **fight itself**: each tick filed one spelling and closed
the other, nine open/close rows for one still-unresolved condition. Fixed
with `ORDER BY id` on the query plus sorting the pair before interpolating
(`[a, b] = [prior, u.id].sort(...)`), so the same condition always produces
the same title regardless of iteration order. Verified live post-deploy: one
tick did the final flip, the next reported zero new/closed issues — stable.

### `main` said NO_REPLY into a real person's WhatsApp (2026-09-01)

Two messages landed in מירון's chat at 11:25 local, in the middle of a normal
conversation about deleting a task:

```
Past quiet hours now (08:24 UTC), but no user messages waiting,
nothing urgent to report.  NO_REPLY
הטוקן מהקובץ שוב נדחה. אעצור הפעם.  NO_REPLY
```

Neither came from his agent. Both are in `main`'s transcript verbatim
(`agents/main/agent/openclaw-agent.sqlite`, `transcript_events`, 08:25:06),
and the same shape repeats every ~30 minutes all night: 04:57, 05:25, 05:55,
06:26, 06:55, 07:25, 07:55, 08:25. **Two independent conditions had to hold,
and neither alone would have been visible:**

- **Something woke `main`.** The 2026.8.1 upgrade auto-created **36 cron
  jobs** — a `heartbeat` and a `skillCollectionReview` for every agent in the
  roster, all with `sessionTarget: main`, all enabled. Nobody created them;
  v2 schedules in brokerd and the gateway `cron` tool is denied to agents
  precisely so this does not happen.
- **`main` could deliver to a person.** Six leftover WhatsApp sessions —
  `agent:main:whatsapp:direct:+9725…` for six real users including מירון —
  from the v1 era when `--to <phone>` alone ran the turn on the DEFAULT agent.
  Harmless for as long as nothing ran main.

`main` has no user row and therefore no identity token, so its `turn_start`
calls improvise one — the transcript shows `"olma_identity":"main"`,
`"unknown"`, `"olma"` — which is what the four ownerless `auth.failed` rows
at 08:25 are, and what "הטוקן מהקובץ שוב נדחה" was reporting. **It was never
מירון's identity that was broken**: u-3's file is locked, and its token
matches the DB in both `.olma-identity` and `AGENTS.md`.

- **The six sessions were NOT v1 leftovers** — that was this file's first
  reading and it is wrong, corrected here rather than deleted because the
  wrong version shipped a detector. Their transcripts settle it: five of the
  six contain `role: assistant` messages and nothing else, i.e. they are the
  RAW PIPE's own delivery sessions, created by reminders and alarms because
  #96 made main the systemAgent. Archiving them achieved nothing durable —
  two were recreated by ordinary reminders within hours, one to a user who
  had simply been sent a reminder at 13:00.
- **Exactly one of the eight carried inbound turns** (four, from מירון), and
  that is the session the leak actually went through. So `config_guard`'s
  `checkInfraAgentSessions` tests for an INBOUND USER TURN
  (`sessions.hasInboundUserTurn`), not for the session's existence. Without
  that test it files a violation against ordinary operation for every user
  who receives a reminder — a detector that flags a working system, which is
  the failure this very section already records twice. `null` (unreadable
  transcript) is never a violation: "could not read" is not "someone spoke".
- **Filed, not alerted.** It is real damage a person sees, but it does not
  stop a tool call, and `BREAKS_USERS` means exactly that since #97. Widening
  it would put the alert list back to meaning two things at once.
- **One row per (agent, channel), never per session** — a per-session title
  would file a brand-new issue every time somebody joins (`checkStuckOutbox`'s
  lesson).
- **The cron half cannot be switched off at all**, which was established by
  trying rather than assumed: `openclaw cron disable <id>` refuses all 36 with
  *"system-owned monitor jobs cannot be edited by cron clients"*. They are the
  gateway's own monitors, and a future upgrade can add more. So the session is
  not merely the better lever, it is the ONLY one — which is also why it is the
  right one.
- `scripts/quiet-main-agent.js` reports the cron jobs as context and archives
  the sessions (`--apply`; dry-run otherwise). Archiving goes through
  `openclaw sessions archive`, i.e. **through the running gateway**, never by
  writing to its sqlite ourselves — being a second writer to that store with
  the old schema in mind is the mistake `agents.list` already cost a night for.
  Every CLI call is bounded by `--timeout`, because `openclaw config set` is
  documented to hang after a successful write.

**And the detector spent its first hour reporting its own fix** (#104). The
six sessions were archived through the gateway, and the freshly-deployed
script called all six violations anyway — `already_archived`, six times.
`archived_at` is a **column** on `session_nodes`, not a field inside
`entry_json`, and `readAgentIndex` only ever selected the entry, so an
archived session was indistinguishable from a live one. `config_guard` would
have filed the same row every tick for ever against a fix that had already
landed — the detection-layer-nobody-trusts failure for the fourth time in
this file, arriving one hour after the detector that would suffer it.
`mapIndexEntry` carries `archivedAt` now (null in the legacy file era, which
had no archiving: there a session that exists is live by construction) and
`deliverableInfraSessions` skips it. **Anything new that reads the session
index and means "live" has to say so** — listing is not the same question.
Found by running the shipped script against the box rather than by a test.

**The session was NOT the vehicle, and archiving did not stop the leak.** Two
hours later, with all six of main's sessions archived, messages were still
landing in מירון's WhatsApp on the same cadence (09:27, 09:55, 09:56 UTC).
The real rule is visible to the second in the gateway journal — a cron turn
that emits **text before `NO_REPLY`** has that text delivered; a bare
`NO_REPLY` sends nothing:

```
u-17 09:56:08 "Nothing needs attention…"        →  Sent 09:56:08
u-19 09:56:50 "הטוקן עדיין נדחה על ידי השרת"     →  Sent 09:56:50
u-3, u-8, u-20, u-21   bare NO_REPLY            →  (nothing)
main 09:24:59          bare NO_REPLY            →  (nothing)
```

That last line is the trap: main's silence on the first post-archive wake was
read as the archive working, and it was **main having nothing to say**. An
absence of evidence was scored as evidence, on a sample of one — the same
mistake as grepping a log file that turned out not to exist (below).

- **The cron wakes every agent, not main** — 16 ran in one three-minute
  window, each in its own `agent:<id>:main` session, none of them a WhatsApp
  session. Delivery to מירון is not through a session anybody can archive.
- **Most of the text was agents complaining their token was rejected**, which
  is the identity-file damage above arriving as WhatsApp messages. Repairing
  the eight mismatched files (`repair-identity-files.js --apply`, run
  2026-09-01: *8 repaired, 3 already correct, 11 now immutable*) removes the
  bulk of what there is to say.
- **`u-18`..`u-22` were removed from the roster** — no user row, no binding,
  five open guard issues (#28–32), and no valid identity file, so they were a
  permanent source of exactly this text. `agents.entries` edit + workspaces
  and agent dirs moved to `/root/backups/orphan-agents-20260901/` (moved, not
  deleted). Hot-reloaded with no restart; **cron jobs fell 36 → 27**.
- `channels.whatsapp.accounts.default.selfChatMode` is still `true`, which the
  gateway documents as *"Same-phone setup (bot uses your personal WhatsApp
  number)"* — a leftover from the original install. The account is linked to
  Olma's OWN number (`972559347282`, "Olma - אולמה"), so the flag is stale.
  Not yet changed, and not yet proven to be the routing rule that picks
  מירון; his number is also the only non-wildcard entry in `allowFrom`.

**A theory that was checked and is wrong, recorded so nobody re-derives it:**
this looked exactly like the auth-storm-from-transcript-redaction failure
(the gateway masks token args, the model imitates the mask). It is not —
u-3's transcript carries the full unredacted token. The masking was never
involved.

### The actual reason it kept converging on מירון: `heartbeat.target` defaults to `"owner"` (fixed 2026-09-02)

The doctrine fix above did not hold. Twelve-plus hours later מירון sent a
screenshot — the same shape continuing: English heartbeat commentary at
01:55, 05:54, 07:25, 09:55, 10:25 local, plus a **raw DSML tool-call leak**
at 09:31 exposing his own real identity token. Hash-correlating every
`Sent message … -> sha256:…` journal line against every agent's own
`transcript_events` (not just main's) settled it for good: **three different
agents** produced these sends — `main` (2), **u-17/Sarah** (2), **u-9/קפיש**
(1) — none of them narrating an auth failure this time, just heartbeat
commentary ending in `NO_REPLY` that the model wrote a sentence before
anyway. The two theories the previous section left open were both wrong:

- **Not `selfChatMode`.** The WhatsApp account is on Olma's own number
  (`972559347282`), confirmed from `credentials/whatsapp/default/creds.json`
  — never מירון's.
- **Not `allowFrom` position.** u-17 and u-9 have **no WhatsApp session with
  מירון's number at all** (checked both agents' `session_nodes` directly),
  and main's own session to him is the one already archived the day before.
  The session a heartbeat actually runs in (`agent:<id>:main`) has
  `delivery:{kind:"none"}` recorded on it in the gateway's own sqlite. None
  of that stopped the send.

The real mechanism is in the gateway's own source
(`targets-CwL8pr8V.js`, `resolveHeartbeatDeliveryTarget` /
`resolveHeartbeatOwnerRoute`), and it is a documented default, not a bug in
the "unintended code" sense: `agents.defaults.heartbeat.target` is `undefined`
by default, which resolves to `"owner"`, which reads
**`commands.ownerAllowFrom`** — the field `bootstrapCommandOwnerFromPairing`
auto-filled with whoever first approved the WhatsApp pairing. That was
מירון, back when this was a single-user bot. `commands.ownerAllowFrom` is
*also* consumed by real command-authorization code (Discord voice, Telegram
exec-approval) — which is what made it a red herring at first read — but
`targets-CwL8pr8V.js` is a third, independent consumer, and it is the one
that matters here: **every one of the 18 agents' heartbeat turns, whenever
they produce anything other than a clean silent ack, defaults to messaging
whoever is the gateway's configured command owner — regardless of that
agent's own user, regardless of session state.** The gateway even ships the
fix as a string it's supposed to show on first alert:
*"Set `agents.defaults.heartbeat.target: \"none\"` to keep these internal."*
Nothing in our config had ever set it.

Fixed by setting exactly that: `agents.defaults.heartbeat.target: "none"` in
`openclaw.json` (backed up to
`/root/backups/openclaw.json.pre-heartbeat-target-fix-20260902-085735`
first). Hot-reloaded on write (`[reload] config hot reload applied
(agents.defaults.heartbeat)`, 08:57:43 UTC) and the gateway was restarted
anyway for a clean re-read; came back healthy (`[gateway] ready`,
`[heartbeat] started`, WhatsApp listening) with no new sends to מירון since.
This closes the whole class — every agent, every future thing a heartbeat
might have to say — at the one place all of them funnel through, rather than
depending on prompt wording the model has already shown it won't reliably
follow.

**Still open, and NOT what this fix touches:** the 09:31 DSML leak
(`<｜DSML｜tool_calls>…`) is a distinct bug — u-3's own agent, correctly
targeting מירון himself, failing to format a real tool call and leaking the
raw syntax (including his live identity token) as chat text instead. That is
a tool-calling reliability failure, not a routing one; setting
`heartbeat.target: "none"` does nothing for it.

### The lock that worked perfectly, on three files out of sixteen (2026-09-01)

`chattr +i` on `.olma-identity` was added 2026-08-27 and applied **only at
provisioning** — so it protected workspaces created after that date and nothing
else. Nobody noticed, because the gap is invisible until something tries to
write. On 2026-09-01 a test suite running on the box overwrote eight identity
files, and one `lsattr` settled the whole question:

```
----i---------e-------  u-3, u-9, u-13     ← locked, untouched
--------------e-------  u-8, u-10..u-22    ← unlocked, eight overwritten
```

**Every locked file survived; every file that was overwritten was unlocked.**
No exceptions in either direction. The protection was never weak — it had
simply never been backfilled onto the users who existed before it shipped.

`domain/identity-repair.js` + `scripts/repair-identity-files.js` (dry-run by
default) do two jobs, and the second is the one that stops the recurrence:
rewrite a file whose token disagrees with `users.identity_token`, and set `+i`
on **every** active user's file, matching or not. Locking only the broken ones
protects precisely nobody — the eight that were overwritten matched the DB
right up until the moment they did not.

- **Scope, per #97**: the token has been inline in `AGENTS.md` since
  2026-08-27, so `.olma-identity` is the RECOVERY path, not the credential. A
  stale one blocks nobody while doctrine is intact. This repairs the spare key
  — which matters exactly when the primary fails, the moment nobody wants to
  find the fallback was overwritten months ago.
- **Unlock → write → relock**, in that order: the immutable bit stops root
  too, so skipping the unlock fails with EPERM on precisely the files that are
  correctly protected.
- **The lock is read back with `lsattr` after setting it**, and a failure is
  counted and named rather than assumed. A report claiming a lock it did not
  get is worse than one admitting the filesystem cannot do this, because the
  operator stops looking.
- **A missing file is reported, never written blind.** Writing a token into a
  directory that may no longer be that person's workspace is worse than the
  auth failure it would paper over.

### The guard was right within a minute, and unread for eighty (fixed 2026-09-01)

`config_guard` filed the five corrupted-identity issues at 19:08:40 on
2026-08-31, less than a minute after the upgrade above produced them. They sat
on the dashboard while those five people's agents failed every tool call they
made, and were found by a human eighty minutes later. **Detection was never
the problem** — this file has now recorded the same shape three times (the
thirteen already-resolved issues nobody read on 2026-08-27; `/health` red for
thirteen hours during the credit outage). What was missing is escalation.

Most violations describe damage nobody feels today — an orphan agent, a
duplicated carryover, a setting that would matter if something *else* also
broke. A dashboard row is the right home for those. Four are different in
kind, and `BREAKS_USERS` is the whole list: an identity file or an `AGENTS.md`
whose token is not the DB's, `tools.alsoAllow` missing `read`, and an empty
`mcp.servers`. While any of those holds, the affected agents cannot complete a
single tool call and the person on the other end simply gets nothing. Those
alert on the **raw `openclaw message send` pipe** — the credit alarm's channel,
no model and no credit — because it works precisely when the system cannot
answer for itself.

- **Announced once, and re-armed by recovery.** `config_guard_alerted` holds
  the set already sent. A condition that persists is not repeated; a NEW one
  still gets through; a condition that CLEARED drops out, so the same break
  next month alerts again. Same tiering rule as the balance warning.
- **The two halves of that flag are written under different rules**, which is
  the part a test caught rather than the design. Dropping a cleared condition
  is unconditional. Adding a fresh one records that somebody was *told*, so it
  is written only after the pipe confirms `ok` — a failed send leaves it
  unstamped and the next tick retries. Stamping first would have made a
  gateway outage (exactly when this alarm matters most) swallow the alert
  permanently. The same promise `credit-watch` and the balance forecast make.
- **A throwing pipe never takes the issue rows with it.** Filing happens
  first and the send is wrapped — the durable dashboard record must survive a
  dead gateway, which is the condition being reported.

### The gateway was upgraded underneath a running system (2026-08-31)

Someone ran `npm i -g openclaw` on the box at 19:08 UTC, taking the gateway
from 2026.6.10 to 2026.8.1. It crash-looped for ~35 minutes (restart counter
hit 16) because the new version demands an agent-identity migration that only
runs with the writers stopped: **stop the gateway, `openclaw doctor --fix`,
start** — the error text says exactly this and it worked first try (agent
sqlite files were backed up to `/root/backups/agent-sqlite-pre-doctor-20260831`
first; they were not needed). WhatsApp was down for every user the whole
window, including a brand-new joiner mid-conversation. Found not by an alarm
but by an outbox row's `last_error` reading ECONNREFUSED — the delivery
retry/backoff absorbed the outage so well that nothing else noticed.

The upgrade also **rewrote `openclaw.json` into a new format**: the
`agents.list` array became a keyed `agents.entries` object (same fields, id
as key). Three consequences, the first one a time bomb:

- **A config carrying BOTH shapes has `agents.list` silently DELETED** by the
  gateway's own migration ("Removed agents.list because canonical
  agents.entries is already set"). Our provisioning wrote `agents.list`, so
  the next joiner's agent would have been thrown away on the next config
  load, their binding routing to a nonexistent agent. All roster
  reads/writes now go through `usesEntries`/`listAgentIds`/`hasAgent`/
  `addAgent`/`removeAgent` in `src/intake/openclaw-config.js` — both formats
  supported, the format decision in one place.
- **`intakeConfigured` read only `.list`, so registration was entirely OFF**
  from the upgrade until the fix deployed: the sweep reported
  `skipped: no_intake_agent` and every new joiner would have been greeted by
  intake and never provisioned. This is the quiet half — nothing errors,
  nothing retries, strangers just never become users.
- The doctor migration **registered every agent directory on disk into
  `entries`**, including `u-18`..`u-22`, which have no user row and no
  binding — old debris directories, now visible to `checkOrphanAgents`
  (which reads entries too now). Expect it to file them; removing them from
  entries + disk is operator cleanup, not urgent (nothing routes there).

Worth keeping as a shape: the vendor's auto-migration was correct and still
broke us, because OUR code was a second writer to the same file with the old
schema in its head. After any gateway version bump, diff `openclaw.json`
against what `src/intake/openclaw-config.js` expects before trusting
provisioning.

### A phone number is not a location (2026-08-31)

A new US joiner (+1516..., Long Island area code) was guessed
`America/New_York` — she is in Los Angeles. The same afternoon she sent a
friend request to an Israeli-numbered user who is ALSO in LA: his stored
`Asia/Jerusalem` read 22:14, so the gate held the request as 'night' until
his "morning" — while it was noon where he actually sat, mid-conversation
with Olma. (The turn_start night-nudge would have released it, but the
gateway was down — the outage above and this incident interleaved.) Both
timezones were corrected by hand (`admin.timezone_corrected`, unconfirmed on
purpose so the agent still verifies), and the request delivered at his real
midday.

The durable fix is doctrine, not code — the inference was never wrong about
what it claimed (a country), it was read as more than that (a location):

- **Curiosity ladder rung 2** (right after the name): when the card says the
  timezone is unconfirmed — especially a non-Hebrew conversation or a
  non-Israeli number, whose country can span four zones — ask early, one
  line, which city they are in; save with `confirmed: true`.
- **A mentioned location updates the zone THAT TURN, no question**:
  `set_my_timezone`'s description now says so ("אני בלוס אנג'לס" is the
  answer, not a prompt to ask about timezones). Pinned in
  `tests/intake.test.js` alongside the act-first rules.

### OpenRouter cache reads were priced 5x too high (fixed 2026-08-31)

`model-pricing.js` charged `cacheRead` at the full input rate on the stated
belief that OpenRouter publishes no cache pricing. It does —
`/api/v1/models` carries `input_cache_read` per model, ~5x cheaper than
input — and on a workload that is mostly a warm 30k-token prefix, that
mispriced the biggest token column: four steady DeepSeek days summed $1.106
in `usage_ledger` against $0.50 at the provider's own rates, with
OpenRouter's dashboard agreeing with the lower figure. The dashboard was
overstating the live model bill 2.2x. All four OpenRouter entries re-checked
against the live models endpoint; a test now pins `cacheRead < input` for
each. (`cacheWrite` stays at the input rate — DeepSeek/Qwen bill a cache
write as a normal input token, there is no separate write price.)
Rows already priced stay as written — the ledger is append-only and the
error is conservative (overstated, never hidden spend).

### Voice calls get a per-call ledger (2026-08-31)

Built for the pricing-model question ("כמה עולה לי דקת שיחה?"), which could
previously only be answered by reading provider balances by hand.
`voice_usage_ledger` (migration 026), one row per Twilio call sid;
`jobs/voice-usage.js` re-reads Twilio's recent-calls page hourly and
upserts. What made it interesting:

- **Twilio prices a call minutes AFTER it ends** — `price` is null at first,
  then settles. The upsert back-fills; null means "not settled", never $0
  (the same rule as the cost page's `remaining: null`).
- **Twilio is the only meter with per-call truth.** Deepgram/Cartesia/LLM
  publish no per-call figure; the dashboard's "שיחות קול" block multiplies
  MEASURED minutes by labelled per-minute estimates (Deepgram's measured
  from a real balance drop: $0.100 over 25.5 min).
- Measured economics, for the record (2026-08-31, 23 real calls): Twilio
  ~$0.065/min to 052-numbers (billed in whole rounded-up minutes; one 055
  call cost 3x), all-in ≈ **$0.10/minute**. Messages by comparison:
  ≈ **$0.0053/message** all-in on DeepSeek (94 real messages over 4 days,
  $0.50 total, including planning/extraction/digests). Calls are the only
  per-user cost that can hurt a subscription price; messages are noise.

### Reminders that come back, and cadences that could not be said (2026-08-29)

Three connected repairs, migration 023. The first two shipped together on
purpose: the second breaks the first the moment anyone uses it properly.

**A reminder fired exactly once.** `dueForSending` filtered on `sent_at IS
NULL` and the sweep stamped it on the first enqueue, so someone driving, in a
meeting, or asleep past the 2h expiry heard about it never. Live evidence: 45
reminders fired, 3 were followed by a completion. There are three rungs now —
the moment they chose, `reminder_escalation_gap_hours` (3) after that one
LANDED, and the next day at the same hour — both numbers dashboard flags, and
`reminder_escalation_max = 1` restores the old behaviour with no deploy.

- **A rung is only scheduled once the previous one was DELIVERED**, not merely
  enqueued: the query joins the outbox and requires `sent_at IS NOT NULL AND
  hold_reason IS NULL`. This is the check-in ladder's bug (below) refusing to
  repeat itself — that one counted messages which died inside quiet hours as
  ignores and backed people off to weekly having sent them nothing.
- **Repeating reminders never escalate.** A repeat rule IS the person's chosen
  cadence; chasing it too would be two drums on one task, with rung 2 of
  Monday's reminder colliding with Tuesday's scheduled one.
- **Only rung 1 is urgent.** That moment is theirs; a follow-up is Olma's own
  idea and queues behind the daily proactive budget — otherwise three rungs per
  reminder is a way to spend an unlimited budget by setting enough reminders.
- **Rung 1 keeps the unsuffixed idempotency key** `reminder:<id>`; later rungs
  are `reminder:<id>:<n>`. Renaming rung 1 would have let the sweep re-enqueue
  rows written before this as brand new, and a duplicate reminder is the one
  outcome worse than a missed one.
- Ending it needed **no new plumbing**: `complete_task` and `cancel_reminder`
  already write to the columns the query filters on.
- Wording lives in `domain/proactive-text.js`, NOT in `channels/openclaw.js`'s
  `instructionFor` — reminders ride the raw pipe (see below) and there is no
  model fallback, so an elaborate instruction there is unreachable code. Each
  rung is deterministic text that says what it is and carries its own way out,
  written **without grammatical gender**: fixed text cannot know who it is
  addressing, and in Hebrew a guess is wrong for half its readers.
- **A ladder that can no longer climb retires.** Found red-teaming: a rung the
  gate held or expired correctly stops the climb, but the row would then sit
  pending for ever, reading in `list_my_reminders` as one that never fired.
  Nothing can be due two days past the original moment, so the sweep closes it.

**And `sent_at IS NULL` stopped meaning "has not gone out"** — it now means
"the ladder has not finished", and a row sits there up to a day after being
delivered. Three readers took the old meaning and told somebody: `jobs/planning.js`
announced a reminder at a time already behind us, `domain/digest.js` overcounted
what was still waiting, and the dashboard flagged a working reminder `overdue`
— an operator page raising a healthy system, which is the detection-layer-nobody-
trusts failure again. All three ask `attempts = 0` now. **Anything new that asks
"what is still pending" must ask that too.** Found by walking every consumer of
`task_reminders`, not by a failure; none had a test that could have caught it.
It also merged separately (#67) because #63 was merged by a concurrent session
at a head that predated the fix — after any shared-branch merge, check
`git merge-base --is-ancestor <sha> origin/main` before believing it shipped.

**Monthly cadences did not exist.** `normalizeRepeatRule` returned null for
`FREQ=MONTHLY` — and null means one-off, so "כל 16 לחודש" fired once, silently.
Canonical vocabulary is now `daily` | `weekly` | `weekly:MO,TH` | `monthly:16`
| `monthly:last` | NULL. The arithmetic moved into the person's timezone
(`datetime.partsInZone` / `instantInZone`, Intl only, no dependency), because
both halves of the promise are local:

- Adding a month of milliseconds across a DST boundary moves an 08:00 reminder
  to 07:00. The wall clock is preserved instead; the test pins 08:00 local on
  both sides of Israel's March switch AND that the stored UTC hour changed.
- **"The 16th" read off a UTC clock is the 15th** for anyone whose reminder
  sits before ~02:00 local. Bare `monthly` is pinned to a concrete day at WRITE
  time in `setReminder` — the only place knowing both the moment and the zone.
- A day past the end of a short month **clamps rather than skips** (a
  medication reminder must not vanish because February is short), and the clamp
  cannot compound because the day comes from the RULE, never from the previous
  occurrence: Jan 31 → Feb 28 → **Mar 31**, not Mar 28.

**A standing task died the first time you did it.** `completeTask` marked the
task done and cancelled every pending reminder — including the successor the
sweep writes the moment the current one fires. One "סיימתי" ended the
recurrence for good, with no error and nothing in a log; from outside,
identical to a quiet week. Confirmed live BEFORE touching code: user 3's task
17 ("לנקות את הכלים", `weekly:MO,TH`) completed 2026-08-27, silent since.
Doing the dishes on Monday does not finish "clean the dishes every Monday and
Thursday", so `completeTask` on a task carrying a live repeating reminder now
returns `recurring: true` with `nextRemindAt`, leaves the task open and the
cadence armed, and audits `task.occurrence_completed`. Ending one for real is
two steps and the tool description says so: `cancel_reminder`, then
`complete_task`. `scripts/repair-killed-recurrences.js` (dry-run default) went
back for the one this already happened to — **run 2026-08-29, task 17 revived,
zero remaining**. Its fingerprint is exact rather than a guess: `completeTask`
writes `completed_at` and `cancelled_at` in ONE transaction, so both carry the
identical `now()`, and a reminder the person cancelled themselves never
matches. A moment already passed is walked forward instead of resurrected, and
the old row keeps its cancellation — that Monday really did go unreminded.

**A snooze destroyed its own evidence.** `snoozeTask` overwrote `due_at` and
audited only where the task landed, so two hours later and the fourth
postponement of the same errand were indistinguishable. The old value is read
in the same statement (a `FOR UPDATE` CTE) and the row carries `fromDueAt`,
`pushedMinutes`, `snoozeCount`, `afterReminder`. Only this one needed new code:
completion-vs-due is already `tasks.completed_at` − `due_at`, "did a nudge
land" is `task_reminders.sent_at` → `completed_at`, and responsiveness is
`audit_log`'s `message.received` — all verified by query before writing
anything. An **undated** task records `pushedMinutes: null`, not 0: setting a
first date is not postponing one, and averaging them would read as "this person
barely postpones" off events that were never postponements.

### WhatsApp reactions arrive and are thrown away (measured 2026-08-29)

Asked whether a 👍 on a reminder could mean "done". The answer is more
interesting than yes or no, and is written down here so nobody re-derives it:
**the gateway does receive inbound WhatsApp reactions.** The channel is not in
`dist/` at all — it is a separate plugin at
`/root/.openclaw/extensions/whatsapp/` (Baileys), and
`send-A9EqsNyz.js:readWhatsAppApprovalReactionEvent` reads `msg.message.reactionMessage`
for emoji, target message id, actor and chat. That is what makes 👍/👎 approval
prompts work.

It dies three functions later. A reaction that is not a registered approval
target falls through to `processDurableInboundMessage` → `normalizeInboundMessage`
→ `hasInboundUserContent`, which returns true only for text, media, location or
an interactive response. A reaction is none, so the message is dropped before
the durable journal, before the `message_received` hook, before everything. The
documented opt-in `channels.whatsapp.pluginHooks.messageReceived` fires 2000+
lines downstream of that drop and changes nothing. `reactionNotifications`
exists for iMessage, Matrix and Telegram; Signal reads inbound reactions too.
WhatsApp is the one channel built outbound-only plus the approval special case.

Patching `hasInboundUserContent` in a vendored dist bundle would surface them,
and the recurring-patch problem is solvable (a resync script plus a
`config_guard` check). **The unsolvable half is correlation**: the reaction
carries `reaction.key.id`, the id of the message reacted to, and we never
record it — `outbox` has no message-id column, and delivery goes through
`openclaw agent --deliver`, which hands none back. So we would know someone
approved *something* and have to guess it was the last reminder. Guessing which
task a 👍 closed is worse than having no 👍 at all.

### Two branches, one migration number — a third time, in one afternoon (fixed 2026-08-29)

Three merges to `main` within about an hour (#62, #63, and a commit pushed
into #63 mid-review) each independently burned migration number 21/22/23 —
the exact incident "Two branches, one migration number" already documents
twice. Every single occurrence followed the documented rule correctly:
`SELECT max(version)` on the box, not `ls migrations/` on main. The rule
still failed, because it is **necessary but not sufficient** — the number is
only safe relative to what has been **applied**, and two branches in flight
cannot see each other's still-unmerged files. No amount of discipline closes
that gap; only the merge itself, or a check that runs at merge time, can.

Two changes, neither of which existed before this:

- **`scripts/check-migrations.js`** — a DB-less, dependency-less wrapper
  around `migrate.js`'s own `listMigrations()` (already collision-checked,
  already tested in `db-types.test.js`; this only wraps it for a fast CLI
  exit code). Wired into CI as its own job, `migrations`, that `test`
  depends on — so a collision fails in seconds with the one line that
  explains it, instead of several minutes of 500+ tests all throwing in
  their `before` hook, which reads like "everything is broken" rather than
  "one number is duplicated."
- **`concurrency:` on the whole workflow**, grouped by `github.ref`,
  `cancel-in-progress` false only on `main`. This is the other half of the
  same afternoon: three merges to `main` in quick succession each trigger a
  real `deploy.sh --restart` against the one production box, and two of
  those running at once would race the same `/opt/olma2-previous` rollback
  snapshot — nothing before this stopped that. Every other ref (a PR, a
  feature-branch push) still cancels its own superseded runs, the ordinary
  CI-time-saving default, since only `main` has a deploy to protect. Before
  this existed, the discipline was manual: merge one, wait for its
  `deploy.sh` to finish and verify `/health`, only then merge the next —
  which is what actually happened three times in a row this session while
  the fix above was being built.

Neither change touches the collision RULE itself (`listMigrations()`,
unchanged) — both are about catching a violation earlier and preventing the
conditions that make one likely, which is a different problem than the rule
already solves.

### Availability is tapped on a page, not typed (2026-08-28)

The first "ephemeral UI": when someone needs to give meeting availability,
their agent offers a choice — write it in chat, or get a personal link to a
small RTL page (dark, mobile-first, zero deps, vanilla inline JS) where they
tap a date or range on a month grid, tick one or more of
בוקר/צהריים/ערב/לילה (or כל היום / שעה מסוימת, each of which replaces a
selection rather than joining it), and build up to 10 options with
✕-removal. The four spans tile the day exactly and `all_day` is their union,
so ticking all four collapses to "כל היום" — the same sentence said shorter;
`canonicalParts` is the one place that decides this and the page only mirrors
it. Their own Google Calendar
events overlay the grid (best-effort, their credential only), and options the
OTHER side already submitted show as tap-to-adopt chips. Migration 020 —
018 AND 019 were both burned on prod by other branches while this was being
written, so the number was re-checked with `SELECT max(version)` on the box
immediately before the merge, not once at the start.
`domain/availability.js`, `adapters/http/picker.js`, tool
`send_availability_picker`.

- **The token in the URL is the whole credential** — same trust model as the
  OAuth callback route above it in dashboard.js (random, user-bound, 7-day
  TTL), except deliberately MULTI-use so the person can reopen and edit.
  Links are idempotent per (meeting,user), die with the meeting status, and
  expired rows age out in the retention sweep.
- **The server is the judge**: the page posts raw form data; dates, the
  closed daypart vocabulary and labels are validated/built server-side.
  Overlap is computed in code, zero tokens, in UTC instants — each option
  carries its owner's timezone and is converted before intersecting (the
  "משמרת 15:00 stored as Z" incident, one layer up), then labelled back in
  the READER's timezone.
- **Notifications ride the outbox** (urgency urgent, hash-idempotent, so the
  recipient's quiet hours/pause/budget all still hold): a partial submit
  tells only the participants who have NOT yet answered
  (`availability_shared`, offering chat or their own picker); the last submit
  sends the initiator alone the computed intersection
  (`availability_complete`) — or an honest "no window fits". A submission is
  availability, never agreement: confirming still happens only through
  propose/respond_to_meeting_slot, and the doctrine + both instructions say
  so explicitly. `get_meeting_status` now carries everyone's option labels.
- `public_base_url` is a flag (dashboard-editable) so links don't hard-code
  the host. New outbox kinds inherit the DELIVERY_PREAMBLE automatically via
  `instructionFor` — pinned by tests like every other proactive kind.

### The credit alarm compared two clocks (fixed 2026-08-28)

`jobs/credit-watch.js` decides "have I already alerted for THIS outage" by
comparing `credit_alert_at` against the outage's first error. The first error
came from Postgres (`min(created_at)`); the stamp was written by Node
(`new Date().toISOString()`). Two clocks, and two separate failures:

- **A JS Date cannot hold microseconds.** `pg` parses a timestamptz into a
  millisecond-resolution Date and `toISOString()` drops the rest, so two events
  a fraction of a millisecond apart compare EQUAL — and `>=` then reads a
  genuinely new outage as the old one and stays silent. This is why
  `tests/credit-watch.test.js` failed roughly two runs in three on main:
  everything in it happens inside a few milliseconds. **A flaky test on the
  alarm that pages when the model provider runs dry is worse than no test — it
  trains everyone to shrug at a red suite.**
- **`now()` is transaction start, not the wall clock**, and this runs inside
  `withTx` (`bin/olma-brokerd.js`). Under READ COMMITTED a row inserted after
  our transaction opened is still visible to the SELECT, so `now()` can
  legitimately predate the outage just read — stamping the flag BEFORE the
  first error and re-firing the same alarm every tick for the rest of a real
  outage. Never observed live, and only because outages have so far started
  between ticks rather than during one.

Both sides now stay in Postgres: `min(created_at)::text` out, `$1::timestamptz`
back in for the comparison, and the stamp is `clock_timestamp()::text`. Nothing
passes through a JS Date, and no migration is needed — a legacy JS-written value
still parses as a timestamptz. The regression test pins the two moments one
microsecond apart (the same millisecond, which is all the old code could see)
and asserts the stored stamp is Postgres's own rendering — a space and `+00`,
never `T...Z`.

### Behavioral evals: nightly scripted conversations, judged twice (2026-08-28)

467 unit tests were green the night "אני רוצה להפסיק את השירות" was answered
with a warm goodbye and no tool call — unit tests check code, not the model's
judgment. `src/evals/` closes that: every scenario is a real past incident
(the stop request, the school essay, the UTC shift, the vehicles goal, the
phone-in-fact, the add_task loop, the invented meeting, the gender slip),
re-run nightly against a DEDICATED eval user's real agent — real gateway,
real tools, real DB — on a disposable session with no `--deliver`.

- **Two judging layers.** Hard checks (tool-call order + DB state) are RED
  and alert Miron's WhatsApp immediately on the credit-alarm raw pipe; the
  judge model (Kimi k2.6 via OpenRouter — a different family than the agent's
  DeepSeek, a model must not grade its own relatives) flags text quality as
  YELLOW, which alerts only on the second consecutive bad night — judge
  scores wobble, and an alert that fires on wobble teaches the reader to
  ignore alerts. A harness failure is ERROR and alerts like red — never
  silently green (the /health lesson). Everything lands in
  `eval_runs`/`eval_results` (migration 019 — renumbered after colliding with
  #55's 018, the two-branches-one-number incident repeating itself on merge
  day) and renders as the dashboard's
  "בדיקות התנהגות" section.
- **The eval user is structurally sealed off**: `users.is_eval` (ONE row,
  `+972599999001`), every user-selecting sweep excludes it, and the outbox
  gate `drop`s its rows (`hold_reason='eval_user'`) — its phone is fake, so a
  delivery attempt could only fail, climb `attempts`, and trip the
  stuck-outbox alarm. `resetEvalUser` refuses any row not marked `is_eval` —
  that check is the only thing between the wipe and a real person's data.
- **Cadence**: `jobs/evals.js` ticked hourly, runs once in 03:00-06:00 IL
  (watermark flag `evals_last_run_date`, stamped at START so a crashing suite
  cannot loop all night — the ERR heartbeat is the signal). Manual runs:
  `node scripts/run-evals.js [--only id,id] [--no-judge]` — exits non-zero on
  red/error, the "before a doctrine change" half of the design.
  **One-time arming on the box: `node scripts/setup-eval-user.js --apply`** —
  until then the sweep reports `skipped: no eval user`.

### Comparing a candidate model is now a scored run, not an argument (2026-08-30)

`node scripts/run-evals.js --model <id>` drives all nine behavioral
scenarios on a candidate instead of the live default — the standing ask is
to do this periodically and log it in **`olma2/docs/model-experiments.md`**,
which is the dated results file, not this one. Migration 024.

- **Nothing is routed anywhere.** The override rides one disposable session
  per scenario on the sealed eval user, never `--deliver`;
  `agents.defaults.model` is untouched (moving real users stays
  `scripts/set-default-model.js`). The script also warns when the gateway
  **reports** a model different from the one asked for — a silent fallback
  would otherwise record as a passing pilot for a model that never ran.
- **`trigger='pilot'` is load-bearing, in two places.** It is excluded from
  `previousStatus`, so a candidate's yellow can never make the next real
  night a false "second night in a row"; and the dashboard headline picks
  the newest NON-pilot run, so a candidate's reds cannot read as a
  production regression. Both are the detection-layer-nobody-trusts failure
  waiting to happen.
- **First result (run #10) earned its keep by ruling something out:**
  `deepseek-v4-pro` fails `stop-service` *identically* to v4-flash —
  `turn_start` skipped on the confirmation turn. Two models, two doctrine
  versions, same failure, so it is neither capability nor wording; a
  specific urgent instruction beating a general preamble is a property of
  models. **No model swap fixes it.** v4-pro was also 1.4-3x slower for no
  gain, which matters against `stuckSessionAbortMs = 65s`.
- Judging order, when reading a pilot: hard checks → judge verdicts → speed
  and price. The incumbent is already near the cheapest tool-capable tier,
  so a swap needs a quality or speed argument, not ~$0.02/Mtok.

### The night the evals cried wolf — and once for real (fixed 2026-08-30)

Two consecutive nightly eval runs woke the owner: run #6 (2 red + 5 error)
and run #8 (1 red + 4 error). Nine of eighteen judgements across the two
nights were harness failures, not agent failures — the judge layer was the
flaky part. Three separate roots, one deploy:

- **`llm.completeOpenRouter` threw a raw TypeError on a 200 with a non-JSON
  body.** `res.json().catch(() => null)` set `body = null`, the
  `body && body.error` check passed it, and `body.choices` threw "Cannot read
  properties of null (reading 'choices')" — recorded verbatim as two
  scenarios' errors. Now guarded with a named error. The same fix added
  **`finishReason`** to `complete()`'s contract (both providers, normalised
  to `'length'`), so truncation is a stated fact, not an inference.
- **2500 judge tokens still starved Kimi k2.6** — the SECOND raise for the
  same constant (700 → 2500 → 6000). The night's two "no content" errors were
  all-reasoning-no-answer, and the previous night's five "unparseable" were
  almost certainly JSON cut mid-object by the same cap. **6000 failed too**,
  and the constant was only settled once it was measured instead of guessed
  at a fourth time — see "The judge kept failing, three different ways" below.
- **The judge retries ONCE before a scenario becomes ERROR** — a judge
  failure is harness wobble, and an ERROR alerts WhatsApp at 03:50. Both
  attempts failing is still an ERROR (never silently green), and an
  ok-after-retry stores `retriedAfter` in the result row so repeated wobble
  stays diagnosable instead of self-healing into invisibility.

The one REAL red, both nights: **`stop-service` opened its confirmation turn
with `pause_olma` instead of `turn_start`.** The doctrine created the
conflict itself — "on EVERY message call `turn_start` first" vs "on their
yes call `pause_olma` THAT TURN, before you write anything back" — and
DeepSeek resolved it in pause's favour. `agents-template.md`'s stop section
was given the order explicitly: turn_start, then pause_olma, then the reply.

**That did NOT fix it, and the transcript is unambiguous** (run #9, after
the resync reached `u-15`): turn 1 opens `turn_start` correctly, turn 2 has
exactly ONE tool call, `pause_olma` — `turn_start` is skipped entirely, not
merely reordered. `deepseek-v4-pro` then failed it identically (run #10),
so it is neither wording nor capability: a vivid numbered instruction
outranks a universal preamble sitting far above it, in any model.

**Never relaxed to make the board green.** `turn_start` is not ceremonial —
it stamps `last_inbound_at` (the delivery gate's mid-conversation grace),
counts the message toward quota, nudges night-held rows, runs the flood
check and carries `offerResume`. Weakening the check would have been the
exact anti-pattern this suite exists to catch. **Closed structurally the
same day** — see "A turn the model forgot to open" below. `stop-service`
has been green since.

The YELLOW that night (phone-number-contact, an unnecessary question) got no
action on purpose: yellows alert only on the second consecutive night, and
acting on one night of judge wobble is the alert-fatigue failure the
two-night rule exists to prevent.

### A turn the model forgot to open (fixed 2026-08-30)

Two models and two rewordings failed to make DeepSeek call `turn_start` on a
stop request, so the server stopped asking. `domain/turn.js` +
`brokerd/server.js`: if the FIRST tool of a turn is not `turn_start`, the
server does that bookkeeping itself.

- **A turn is one brokerd connection.** The gateway spawns a fresh MCP shim
  per turn and the shim holds one socket for its whole life — no new protocol
  field, no clock heuristic. That mapping is true of the gateway TODAY, and
  `bin/olma-mcp.js` already refuses to bet on it staying true, so neither does
  this: a connection that ever serves a second user starts a fresh turn, and
  the recovery's count is consumed by exactly one `turn_start`. If the process
  model changes underneath us the failure is "no recovery" — today's behaviour
  — never someone's message going uncounted.
- **It repairs STATE and never consumes ADVICE.** `resume_offer_sent_at` is
  deliberately NOT stamped: that offer fires once per pause, and burning it on
  a turn where the model never saw it would leave the person waiting for an
  offer the database believes was delivered. The name is not captured either —
  that needs `sender_name`, which only the model has.
- **The skip is audited (`turn.opened_implicitly`, with `firstTool`), never
  silently compensated for**, and the eval check moved from `turnStartFirst`
  to `turnWasOpened` for this ONE scenario. A test proves the new check still
  goes red when the invariant really breaks — a detection layer that can no
  longer fail is not a detection layer.
- **Rolled out behind `implicit_turn_start`** (dashboard text flag: empty =
  off, `all`, or a comma-separated E.164 list). Phase 1 was Miron + the eval
  user; widened to `all` once the evidence was in. That evidence is what the
  staged rollout was for: across **51 eval-user turns** the recovery fired
  **4 times, all `pause_olma`** — every other turn opened normally and the
  mechanism stayed inert. Miron's healthy path was probed live against the
  real broker too (`turn_start` first → no recovery, one count).

### The judge kept failing, three different ways (fixed 2026-08-30)

`stop-service` went red, then errored three nights running for three
unrelated reasons. Worth reading as a set, because each fix revealed the
next and only the last one was measured first.

- **Truncation, and a retry that bought it again.** The cap had been raised
  twice by guess (700 → 2500 → 6000) and 6000 failed three attempts out of
  three. Probed against that exact conversation: `reasoning_tokens` **4568**,
  for an answer that is **33 characters** — `{"verdict":"pass","problems":[]}`.
  Essentially the whole budget is thinking. Base is 12000 now, and a
  `finish_reason=length` failure **escalates to 24000** on retry: retrying
  truncation at the same cap is the one error class where an identical
  attempt provably cannot come out differently.
- **Our own timeout, reported as the provider returning nothing.** The next
  three attempts failed with `empty or unparseable response body (http 200)`
  — diagnosed as an upstream wobble, twice. It was the 60s deadline. Both
  providers send the 200 immediately and the body afterwards, so an abort
  lands MID-BODY and surfaces as a `res.json()` failure on a response that
  looks perfectly healthy; `.catch(() => null)` then blamed the provider for
  a limit we set. Named as ours now, on both providers. Measured: OpenRouter
  pads the wait with whitespace at ~a byte per 39ms (1287 bytes across a
  49.8s call, 319 across a 12.5s one) and the JSON follows intact —
  **leading whitespace was never the problem**, `JSON.parse` skips it; only a
  body cut off mid-flight is. Latency is set by upstream load, not the cap
  (49.8s and 12.5s for the same prompt, minutes apart), so 60s was not a
  deadline but a coin toss. Judge timeout is 180s; nobody waits on a nightly
  judgement.
- The shape to remember, and the third time this file has recorded it:
  **a failure named after the wrong culprit costs a morning.** `finishReason`
  was added for this reason one change earlier, and the very next bug was the
  same mistake one layer down.

### The suite was green thirteen hours a day and red eleven (fixed 2026-08-30)

Found by the clock rolling past midnight mid-session, not by anyone looking.
Three tests fail outside 08:00-21:00 UTC — and CI's own deploy-on-merge run
had cleared that boundary by **fifteen minutes** on the PR immediately
before. Two unrelated clocks, both inherited rather than chosen:

- Test users are created with a **NULL timezone**, which the delivery gate
  reads as UTC, against the fallback availability window of 08:00-21:00. Two
  tests let `drainOnce` default its own `now`, so they were really testing
  what hour it was. `tests/helpers.daytime()` joins `slotStart` — that one
  exists because a hard-coded weekday depends on the DAY the suite runs, this
  one because an unpinned drain depends on the HOUR. Use it whenever the
  night rule is beside the point; a test ABOUT quiet hours still picks its
  own hour deliberately.
- **`jobs/metrics.js` mixes two notions of "day"**: it picks one as
  `now.toISOString().slice(0, 10)` (UTC) and then counts rows by
  `created_at::date`, which Postgres resolves in the SESSION's zone. Those
  agree only under UTC. Production is `Etc/UTC` (checked on the box), so it
  is latent there — but a dev box in IDT misfiles a day's metrics for three
  hours a night. The test pool now pins `Etc/UTC` to match production: a
  suite green only where the clocks agree is testing a configuration nobody
  deploys.

**And it happened again, in the file that guards the alarm (fixed 2026-09-02).**
Two `tests/credit-watch.test.js` tests fail on `main` between 21:00 and 05:00
UTC. `before()` parks an operator on `DEFAULT_ALERT_PHONE` at local hour 12 for
exactly this reason — but one block flips `admin_alert_phone` to a SECOND
number, and gave that one no user row. Its own comment said a phone with no row
"silently re-opens the night window"; it does the opposite — `alertHourOpen`
falls back to `DEFAULT_TZ` (Asia/Jerusalem), so past 21:00 UTC the alarm queued
instead of sending. Two things worth carrying:

- **The restore was not in a `finally`**, so the throw left the stray number in
  the flag and the NEXT test alerted for a phone whose night it also was. One
  broken hour, two red tests, and the second one looks unrelated to the first.
  The flag-leak shape this file already records (`quota_daily_free`), except the
  leak was caused by the failure rather than by forgetting.
- **A fallback default is not an open door.** The comment was not lazy, it was
  wrong about which way an unknown phone fails — and a test asserting a SEND
  must own the hour of every phone it points at, not just the default one.

### The fact table admitted everything and ranked by recency (fixed 2026-08-28)

The owner read the dashboard's "מה נלמד לאחרונה" and asked whether that is
really how the system stores what it knows. It is — `user_facts`, one row per
fact, Top-10 into USER.md every turn — and the storage was fine. The
**admission policy** and the **ranking** were not. On user 3's live card, three
of ten slots held: a third party's undated birthday, "היומן שלו מחובר ל-Google
Calendar עם גישת read_write" (two lines under the card's own `Calendar:
connected (read_write)`), and "שם שלו הוא מירון" (under its own `First name:
מירון`). What they pushed off the bottom — importance is 1 on almost every row,
so recency decides — was "עמית הוא חבר שמשחק איתו פוקר", i.e. exactly the
context the poker negotiation needed.

Four guards, all at `facts.rememberFact`, the one door the live tool, the
extraction job and the dashboard all share:

- **The bare-name guard had a hole.** It matched `שמו X` / `קוראים לו X` /
  `השם שלו X` and not "שם שלו הוא מירון" — the same sentence with the copula.
  The copula and the article are both optional now.
- **Olma's own state is not biography.** A system noun AND a
  connection/configuration verb together (or a bare `read_write`/`read_only`)
  is refused. Narrow on purpose: "יש לו פגישה ביומן" and "הוא מנותק רגשית"
  each carry one half and pass. The card, `integrations` and `connections` are
  the live copies; a fact is a frozen one that contradicts them the day the
  state changes.
- **A fact anchored to a moment must carry `expires_at`**, via
  `datetime.namesAMoment` — a moving reference point ("היום", "מחר",
  "tonight") or a real calendar date. ISO and slash forms decide alone; the
  dotted Hebrew form ("29.8") needs a weekday or a month elsewhere in the
  sentence, because "3.5 שעות" is the same shape. **A weekday ALONE is
  deliberately not a signal** — "ביום חמישי עובד מהבית" and "עובד כל יום ראשון
  עד חמישי" are recurring and correct as timeless facts, and a false positive
  here REFUSES a real fact.
- Doctrine for all three now rides `remember_fact`'s description, the
  extraction brief and `agents-template.md`, so the model stops producing them
  rather than only being refused.

**A one-meeting constraint became a permanent habit.** "גלי מעדיפה לא להיפגש
בשבת" was on her card with no expiry. She had said one Saturday did not suit
her, for ONE meeting; that was recorded correctly against the meeting
(`meeting_participants.constraints`, scoped, with its own private flag), and
`jobs/fact-extraction.js` — reading the transcript afterwards with no idea a
negotiation had been happening — read the sentence back out of context and
generalised it into who she is. No guard can see this: it reads exactly like a
real habit. So the job is now *shown* the constraints already recorded against
any meeting still open (or closed within the last day), quoted, with the
instruction not to repeat them as facts — the same shape as the open-task list
it already gets as the commitment dedupe reference. Only an explicit
generalisation ("אני אף פעם לא נפגשת בשבת") is a habit, and a standing
availability rule is `remember_preference` under `availability`, which the
delivery gate actually reads.

**Birthdays stay in the calendar.** The owner's instinct was to harvest them
into a side list; the cheaper answer is that `jobs/planning.js` already reads
7 days of calendar every night, so its brief now names a birthday or
anniversary as worth a note — where the note is *offer a reminder to send
greetings*, never greet on anyone's behalf. Google Calendar stays the copy that
updates itself. **Caveat**: `calendar.listEvents` reads `/calendars/primary`
only, and Google's automatic "Birthdays" calendar (fed from Contacts) is a
different calendar id — only birthdays the person put in their own calendar are
seen. A `user_contacts.birthday` column plus a `yearly` repeat rule
(`normalizeRepeatRule` has no yearly today) is the version that would cover the
rest; not built.

**A refinement now replaces instead of piling on.** Live example: "עובד
במוסך" (#29, `user_stated`) and, less than an hour later, "עובד במוסך בהוד
השרון א׳-ה׳ 7:30-16:00" (#33, `conversation`) — the extraction job's own
dedupe instruction only ever said "do not restate", so a genuinely more
complete version of the same fact sat beside the original forever instead of
completing it. `rememberFact` now takes an optional `replaces` (a fact id,
soft-deleted in the same call as the new row lands, with its own
`fact.replaced` audit row); the known-facts block the extraction job shows the
model now carries each fact's `#id`, and the JSON contract gained a `replaces`
field for exactly this case. **Two independent gates, not one**: `applyExtraction`
only honours an id from the EXACT snapshot the model was shown this call —
never one earlier in the same batch, never invented — and `rememberFact`
re-verifies ownership and `active = true` underneath that regardless. Without
the first gate, a model could point at any of a person's own facts by
guessing a plausible id and retire it sight unseen; the test suite proves
this by deliberately disabling each gate in turn and confirming the specific
test that catches it. A bad or foreign `replaces` is a silent no-op — it must
never cost the fact actually being saved.

**A refused fact is counted, never silently dropped.** The guards swallow a
proposal, and a nightly job that quietly drops facts looks exactly like a quiet
week — so `applyExtraction` tallies refusals by reason (`{system_state: 1,
needs_expiry: 1}`), the tally rides the `facts.extracted` audit row and the job
heartbeat, and it is attached only when non-empty (the note is JSON cut at 200
chars). If a guard ever starts over-firing, that counter is the only place that
would say so. The dashboard's fact form spells the same rules out, because a
refused admin write redirects with nothing said.

**Going back for the rows already written** is
`scripts/retire-refused-facts.js` (dry-run by default): it re-checks every
active fact against the current guards and soft-deletes what they would now
refuse, `--id N` for the cases no guard can see. Retiring is `forgetFact`, so
the row stays and only stops being retrieved.

**Found while running the suite:** `main` carried two `018-*.sql` migrations
(`018-behavioral-evals.sql` and `018-image-jobs-async.sql`) — the exact
collision documented in "Two branches, one migration number", from two PRs
merged the same day. The duplicate guard did its job and refused, so **every
`freshDb()` in the suite threw** and no test could run on main at all. The fix
is the same either way and two branches reached it independently (`328ed04` and
this one): production was already correct — 18 = image-jobs, 19 =
behavioral-evals, the file having been renamed on the box without the rename
coming back to git — so the repo is renamed to match production, never the
reverse. Worth noting how it was found: not by anyone reading `ls migrations/`,
but by every single test failing at once the first time somebody ran the suite
after both merges.

### The cost page showed four services out of eight (fixed 2026-08-31)

Owner asked for a pass over everything the project actually pays for, laid out
properly. The audit found the page was describing a system that no longer
exists: it showed Anthropic, DigitalOcean, ElevenLabs and the personal Claude
subscription — and **not OpenRouter**, which since the 2026-08-26 cutover *is*
the model bill (all background cognition, all media generation, the evals
judge), nor Twilio / Deepgram / Cartesia, which the voice bridge has been
billing against since 2026-08-31. Half the spend was invisible, and the
headline read roughly 3x cheaper than the truth.

The layout now splits on the distinction that actually matters, which the old
single table had no way to express:

- **Prepaid** (OpenRouter, Twilio, Deepgram) — credits bought up front that
  drain. The number that predicts an outage is what is **LEFT**, and a spend
  figure alone reads perfectly healthy right until everything stops. This is
  not hypothetical: Olma has been taken down by an empty balance three times
  (`jobs/credit-watch.js`), every time discovered from the silence.
- **Recurring** (DigitalOcean, ElevenLabs, Anthropic, the $20 subscription) —
  billed after the fact, nothing to run out of, so the trend is what matters.

Details worth keeping:
- **`daysLeft` is the provider's own arithmetic, not ours.** OpenRouter's
  `/auth/key` reports `usage_daily` and `/credits` reports what was purchased,
  so "≈N days at the current rate" needs no bookkeeping of ours to stay true.
  A dollar threshold cannot tell $2 left on a service nobody uses from an
  outage tomorrow on the one every model call goes through; days can. Twilio
  and Deepgram publish no burn rate, so those fall back to a flat $5 floor,
  labelled as the guess it is.
- **A failed credits call leaves `remaining` null, never 0.** Defaulting it
  would render a confident "$0.00 left" for the service the whole system runs
  on — the alarming shape, manufactured out of missing data. Pinned by a test.
- **Cartesia is listed with "no billing API" rather than omitted.** Probed
  2026-08-31: `/subscription`, `/usage`, `/account` all 404. A paid service
  missing from the page is one the owner cannot see they are paying for, which
  is the exact failure the whole rework exists to end.
- Every row carries a **"what it's for"** column. A service name alone does not
  tell you whether a line can be cancelled, and this page exists to be acted on.
- **The voice-bridge keys live in `/opt/olma2-voice-bridge/.env` and
  `twilio.env`, not in `/opt/olma2/.env`** — so the Twilio/Deepgram/Cartesia
  rows render "לא מוגדר בסביבה" until they are mirrored across (or the
  dashboard unit is given a second `EnvironmentFile=`; note `twilio.env` uses
  `export KEY=…`, which systemd's `EnvironmentFile` does *not* parse). The
  degradation is deliberate and honest — an unreadable service says so.

**Found by the audit, and the reason it mattered that day:** OpenRouter was at
**$1.77 of $5**, ≈4 days at the then-current burn. Nothing anywhere would have
said so before it stopped — `credit-watch.js` alarms on failures that have
already started, which is the outage, not the warning.

### The runway warning: an alarm that fires days BEFORE the money runs out (2026-08-31)

`checkBalanceForecast` in `jobs/credit-watch.js`, armed as `balance_watch`
(6-hourly), on the same raw `openclaw message send` pipe as the outage alarm —
the one channel that needs no model and no credit. Every prepaid provider
publishes what is left, so the runway was knowable days ahead and nothing was
reading it.

- **Tiers, not repetition.** Below-threshold alerts ONCE, then only again on
  crossing into a more urgent tier (days `[3,7,14]`, dollars `[2,5]`, ascending
  so `.find(v < t)` returns the *most* urgent tier crossed — at 4 days that is 7,
  not 14). At most three messages per depletion, each meaning something new. A
  daily "still low" would be fourteen messages that train the reader to swipe
  them away — the failure the evals YELLOW/RED split already exists to avoid.
- **Recovery re-arms it.** A topped-up service has its stored tier deleted, so
  the *next* depletion gets the full ladder instead of being silenced by a stale
  stamp. The bookkeeping is written even on ticks that send nothing, or a
  recovered service stays permanently quiet.
- **A service that could not be READ is never a service in trouble.** `error`,
  `remaining: null` or unconfigured → no alert. A billing API being down must
  not page anyone.
- **It defers outside 08:00–22:00 local** (the alert phone's own timezone,
  converted in Postgres). Unlike the outage alarm this is not an emergency — a
  prepaid balance cannot be topped up better at 03:00 — and the raw pipe bypasses
  the outbox gate entirely, so this function has to hold that line itself.
  Deferring leaves the tier **unstamped**: stamping would swallow the alert.
- A failed send is not stamped either, same promise as the outage alarm.

### The subscription line was a constant, and the plan changed (2026-08-31)

`SUBSCRIPTION_USD = 20` priced every month identically. The owner took a
one-month Max upgrade and the page had no way to know: **no API exposes
subscription billing** — the org endpoints cover API keys only, which is why
this was hardcoded in the first place. So it now takes a
`claude_subscription_overrides` flag, `{"YYYY-MM": usd}`, dashboard-editable,
and the row shows the actual rate plus a badge on an overridden month.

This added a **`json` FLAG_SPECS type**, parsed *and* shape-checked by a
per-spec `validate()` before it can land — unparseable or wrong-shaped input
changes nothing at all, the same rule the numeric coercion already followed. A
flag the page later reads as an object must never be able to hold a string.
`renderInfraCosts` recomputes the subscription from the flag rather than using
the cached `getInfraCosts()` value, because a rate the operator just corrected
has to show on the very next load, not ten minutes later.

**Confirmed the same day:** Anthropic API traffic ends on 2026-08-26, the
cutover date, and is zero after it — the month's $25.63 is entirely pre-cutover,
not a second bill running alongside OpenRouter.

### Every dollar on the cost page now shows in shekels by default (2026-08-31)

Owner ask, same session: he wants to see the price in shekels, as the default
— not a toggle to click. `infraCost.usdIlsRate()` fetches the ILS rate from
`open.er-api.com` (free, no key, updates once daily — which is what sets the
cache TTL at 12h: a rate that changes once a day gains nothing from being
fetched more often, and the page is read far more often than that).

`dashboard.js`'s `makeMoney(fx)` builds one formatter, closed over by every
dollar figure on the page — headline stats, both cost tables, the media block,
the reconciliation line, the per-day/per-user breakdown. Fetched exactly ONCE
per render and threaded through, not fetched per-row: a partial failure must
degrade the WHOLE page to USD-only, never leave some rows in shekels and
others in dollars depending on which call happened to land first. Shekel
figures keep the SAME decimal precision as their dollar source — a $0.003
media generation at whole shekels rounds to ₪0 and reads as free, which it
is not. (The `claude_subscription_overrides` flag from the section above this
one gets ILS treatment too, same as everything else on the page.)

### Six replies composed, one delivered — the wedge that beat every detector (2026-08-31)

Owner report: user 11 "took relatively long to get a reply". The truth was
worse and live while being diagnosed: between 18:23 and 18:27 UTC he sent
seven messages; his agent answered every one within 3–15 seconds — and **six
of those seven replies never reached WhatsApp**. Thirteen minutes of silence
from his side ("הי", "היי אולמה", "?", "תוכלי לעזור?"), then exactly one
delivered reply at 18:36.

The mechanism, from the gateway's own log: the session lane wedged after
every COMPLETED run (`state=processing`, `lastProgress=run:completed`,
`queueDepth=4`, classification `stale_session_state`), the gateway's stuck-
session recovery freed it at its 65s threshold via `abort_embedded_run` —
**and the abort discarded the undelivered reply along with the phantom run**
(`aborted=true drained=false`). The next queued message then processed in
seconds and wedged again: an ~90s tax per message, paid seven times, replies
lost six times. It only happens when messages are queued at run completion —
the final message, with nothing behind it, delivered normally. Same wedge
signature appears 2–3x/day on 08-20, 08-27, 08-28, 08-31.

**Why every detection layer stayed green**, each for its own documented
reason: `unanswered.js` repaired only case (a) — transcript ending with the
user's message — and these transcripts all ended with a healthy-looking
assistant reply (its own comment called case (b) "indistinguishable from a
normal turn"). `lane-watchdog` is tuned to the 2026-08-16 variant where the
gateway REFUSES to free the lane forever (`keep_lane` + age ≥90s); today it
freed the lane at 65s every cycle, so age never reached 90. `/health` was
honestly green — nothing it measures was failing.

**Case (b) is now provable, not guessable.** The gateway logs one line per
outbound send — `Sent message <id> -> sha256:<12 hex>` — and that hash is
`sha256("<digits>@s.whatsapp.net")` of the recipient (verified live against
a real send; pinned in a test). `sweepUnanswered` reads the same per-day log
file the lane-watchdog already reads (today + yesterday, for the midnight
edge) and repairs a transcript whose last turn is an assistant reply ≥3min
old with no Sent line for that person since composition. Three refusals that
matter as much as the detection:
- **An unreadable log returns `null`, never `[]`** — "no evidence of a send"
  and "no evidence at all" must not look alike, or one rotated log file
  sprays a repair at every user whose agent replied recently.
- **A reply to an injected DELIVERY instruction is excluded** — a lost
  proactive message is its outbox row's own retry problem; a second voice
  re-sending it from here would race that.
- **Same rung (`unanswered_repair`) as case (a)** so ONE hourly cooldown
  covers both — this incident qualified under both shapes within minutes,
  and two repair voices answering one silence is the duplicate-message
  complaint this whole area started with.

**The root bug is the gateway's, and the fix exists upstream — so the
gateway was upgraded the same evening** (owner-approved, 2026-08-31 ~19:30
UTC): OpenClaw 2026.6.10 → **2026.8.1**, whose `isActiveRunProgressStale`
falls back to `params.ageMs >= staleAbortMs` when `lastProgressAgeMs` is
undefined — the exact hole `lane-watchdog.js` documents — and whose recovery
path is reworked. The new version also runs a **`delivery-recovery`**
subsystem (durable outbound retry): on its very first boot it flushed a
pending outbound message that the old version had dropped. What the upgrade
actually took, recorded because every step surprised:

- `tools.alsoAllow` needed `"edit"` BEFORE the restart (warning #47487:
  `tools.fs` stops implicitly widening the "messaging" profile — losing fs
  read would break `.olma-identity` for every agent at once).
- The old config was **invalid under the new schema**: `tools.media.audio.models`
  moved to `tools.media.models` (entries tagged `capabilities: ["audio"]`,
  order preserved — ElevenLabs first, whisper CLI fallback second);
  `diagnostics.stuckSessionWarnMs/AbortMs` are retired (built-in defaults,
  recovery rewritten — `scripts/set-recovery-thresholds.js` is now a no-op
  against this version); root `audio` key retired;
  `agents.defaults.compaction.customInstructions` is **stripped upstream
  with no replacement** — the Hebrew-preserve/no-phone-numbers compaction
  brief is gone as a capability, not just a config line;
  `agents.ownership = "explicit"` is now required for multi-agent rosters.
- The WhatsApp plugin would not `plugins update` (no owner metadata — it had
  been hand-copied); `openclaw plugins install @openclaw/whatsapp@2026.8.1
  --accept-capabilities` installed it to `~/.openclaw/npm/projects/…`, and
  the old copy at `~/.openclaw/extensions/whatsapp` now merely shadows it
  (gateway logs "duplicate plugin id … will be overridden" — the NEW one
  wins; the old dir can be removed in any quiet moment). Baileys creds live
  in `~/.openclaw/credentials/` and survived untouched.
- First boot **refused readiness** ("startup migrations did not complete
  cleanly") until `systemctl --user stop openclaw-gateway && openclaw doctor
  --fix && … start` ran the stopped-writer sqlite migration for every agent.
- The channel then crash-looped on "routing has no explicit owner": 2026.8.1
  requires a **channel-wide binding** (match on channel+accountId, NO peer).
  One was added routing to `intake` — the per-peer bindings and the peer
  wildcard sit in HIGHER routing tiers and still win, so it is the declared
  owner/fallback, not a behaviour change.
- Verified after: gateway ready, WhatsApp listening, a real tool-calling
  turn on the eval user, `--deliver`/`--session-key`/`message send` all
  intact, zero inbound lost during the ~8min window. ("`agents.list` still
  works" was this session's read and turned out one config-load short of a
  time bomb — see "The gateway was upgraded underneath a running system"
  above: the migration deletes `list` when `entries` exists, and
  provisioning had to learn both formats that same night.)
- Rollback path if the new version misbehaves: `npm i -g openclaw@2026.6.10`,
  restore `/root/.openclaw/openclaw.json.pre-2026.8.1`, restore
  `/root/whatsapp-ext-2026.6.10.bak` → `extensions/whatsapp`, restart.

**The third aftershock ran for 48 hours and cost 126 real inbound messages
(2026-08-31 20:25 → 2026-09-02 21:23).** Our own seal became the poison.
Provisioning wrote `openclaw-workspace-state.json` into every workspace to
stop OpenClaw's stock onboarding kit hijacking a person's first conversation.
2026.8.1 keeps that state in `/root/.openclaw/state/openclaw.sqlite`
(`workspace_setup_state`) and reads the FILE as unmigrated legacy state:
`assertNoUnmigratedWorkspaceState` (dist/`workspace-state-store-*.js`) throws
on its mere existence — deliberately without reading it — before the turn
runs, every turn, for as long as the file is there. The doctor migration on
2026-08-31 19:07 copied all 13 workspaces into sqlite and **left the files in
place**, which is the moment the seal turned fatal.

- **The counted damage: 98 inbound messages for u-8 (גלי), 28 for u-14
  (חיים)**, plus `intake` — so no stranger could register either. Both users
  resumed within seconds of the fix and immediately completed tasks. The count
  is exact: it is every such line in the journal, which begins well before the
  outage did. **The first grep was over `--since "48 hours ago"` and put the
  start at 21:56 — its own window edge**, not a fact about the outage. A
  relative window cannot tell you when something started; it can only tell you
  it was already running when the window opened.
- **The very first symptom was 91 minutes earlier and nobody reads it**:
  `Aug 31 20:25:53 [heartbeat] failed: Legacy workspace setup state...`, one of
  the gateway's own auto-created heartbeat crons failing. There WAS an early
  warning, in the journal, ninety minutes before the first person lost a
  message — it just was not anywhere a person or a detector looks.
- **Nothing said so, and the reason is worth carrying.** `/health` is green
  (it measures brokerd), no heartbeat errored, and `audit_log` had no
  `message.received` row for either user — because that row is written by
  `turn_start`, and the turn never opened. **The absence of the evidence WAS
  the symptom**, and it was read as a quiet week. Found by reading the gateway
  journal by hand; the only durable trace anywhere was one stuck outbox row at
  22 attempts and a `config_guard` issue nobody had opened.
- **`openclaw doctor --fix` was needed a SECOND time, two days after the
  upgrade, for a different migration than the agent-identity one** — and it
  does not delete the legacy files, so the files must also be moved aside
  (never deleted: the sqlite rows are already complete and older).
- **The write is gone** from `intake/provision.js` and
  `intake/intake-workspace.js`. The kit stays neutralised by the two things
  that need no cooperation from the gateway: a real `AGENTS.md`/`USER.md`
  (which its own `reconcileWorkspaceBootstrapCompletionState` reads as already
  configured) and deleting the stock files outright. `config_guard`'s
  `checkLegacyWorkspaceState` watches for the file returning, in the
  `BREAKS_USERS` tier — this is not a dashboard row, the agent never starts a
  turn at all.
- **The shape, for the fourth time in this file:** an upgrade did not break
  our code, it changed the meaning of a file our code writes. After any
  gateway version bump, diff what WE write into a workspace against what the
  new version reads there, not only `openclaw.json`.

**The upgrade's aftershock took WhatsApp down for 28 minutes the same evening
(19:56–20:24 UTC), and the mechanism is worth remembering.** A routine
restart (cleaning up the old duplicate whatsapp extension dir) never came
back: every boot failed verification with `Plugin "perplexity" requires
capability consent`. Nobody installed perplexity. 2026.8.1's startup
**plugin auto-repair installs "configured" plugins on its own** — and
"configured" includes plugins *implied by environment variables* via the
official web-search install catalog (`OPENROUTER_API_KEY` sits in the
gateway unit env; perplexity web-search is catalog-installable against it).
The auto-install then lacked capability consent, verification refused
readiness, and the crash loop re-ran repair — **deleting the plugin dir
can never fix it; repair recreates it on the next boot** (observed live:
quarantined 20:05, recreated by the gateway 20:21). Three sessions chased
this concurrently, each finding the others' half-done mitigation.
- The fix that holds: `plugins.entries.perplexity = { enabled: false }` in
  `openclaw.json`. A disabled plugin is neither repaired nor consent-checked;
  boot degrades to a harmless "plugin not installed" config warning.
- The shape: an *upgrade* changed what the gateway does with credentials
  that were already in the environment. If another surprise plugin ever
  demands consent at boot, disable it by id in `plugins.entries` first,
  ask questions after — the alternative (granting consent to something
  nobody chose) installs real capability.

**And 2026.8.1 deleted every transcript file.** Session state moved into
per-agent sqlite (`agents/<id>/agent/openclaw-agent.sqlite`): `sessions.json`
is gone, `sessions/*.jsonl` are gone (the old files parked under
`session-sqlite-import-archive/` with an `.imported-*` suffix), and with them
every consumer of `channels/sessions.js` went silently blind at once — intake
discovery (no new user could be provisioned), usage attribution, fact
extraction, both unanswered nets (including the case-(b) detector shipped
hours earlier), and the dashboard's conversation view. `channels/sessions.js`
now reads BOTH generations behind the same API — sessions.json present →
files (every test fixture, and any rollback); absent → the agent sqlite,
read-only (`session_nodes` is the old index, `transcript_events` the old
transcript lines verbatim, seq-ordered). Cost watermarks switch from bytes to
event seqs, with an era guard: a byte watermark against a sqlite session
jumps to "now" instead of re-reading from zero, because re-attributing the
whole file-era history is the one corruption worse than a one-time gap.
Verified against the live box read-only before merging: intake discovery,
u-11's real conversation, all 494 transcripts, and a 34-call usage read.

**The one reader that walk missed cried wolf the same night.** The eval
harness reads its per-turn tool calls from `meta.agentMeta.sessionFile` —
which 2026.8.1 now fills with the session KEY, not a path. `readFileSync`
threw, the catch swallowed it, every turn's `toolCalls` came back `[]`, and
nightly run #24 (2026-09-01 00:09) scored **9/9 RED** — "turn opened with no
tool at all" on every scenario — waking the owner at 03:50 for a harness
artifact while the agent was calling tools perfectly. Fixed in #92:
`sessions.readSessionEventsSlice(agentId, sessionKey, fromSeq)` slices
`transcript_events` by seq exactly the way the file was sliced by byte
offset, and `makeTurnRunner` falls back to it when the path isn't readable.
A false red board must not stand, and must not feed tomorrow's comparison
either — so after the deploy a MANUAL run (`run-evals.js`, trigger
`manual`: no alert, but it heads the dashboard and is `previousStatus` for
the next nightly) replaced the headline: run #25, 7 green · 2 yellow · 0
red. `stop-service` green — the implicit-turn_start recovery holds across
the gateway upgrade.

### The raw pipe had no owner, so reminders and the credit alarm both went mute (fixed 2026-09-01)

The third aftershock of the 2026.8.1 upgrade, and the most expensive, because
nothing about it looked like a failure. `agents.ownership: "explicit"` came
with the new roster format — and from that moment every **agent-less** gateway
operation refused:

> Multiple agents are configured, but this operation has no explicit owner.

That is the whole **raw pipe**: `openclaw message send`, which carries
reminders (deliberately, since 2026-08-23 — they must not need a model), the
credit-out alarm, the runway warning and the nightly eval alert. `message send`
takes no `--agent` flag (checked: `--account`, `--channel`, `--target`,
`--message`, nothing else) and an inbound per-peer binding does not resolve an
OUTBOUND send's owner, so for a multi-agent roster exactly one door is left:
`agents.defaults.systemAgent.agentId`, read by the gateway's own
`tryResolveAmbientOwnerAgentId`. **The upgrade's migration fills that field in
automatically only when the roster it converted held exactly one agent** — ours
held eighteen, so it was left unset. `scripts/set-system-agent.js --apply`
(`main`, the agent with no user, restoring the pre-upgrade behaviour rather
than changing it — raw sends always logged there).

What twelve hours of it cost, none of it visible: Miron's 08:00 rent reminder
climbed to 16 attempts and **expired undelivered**; a second reminder sat at
12; and the credit alarm — the one channel that still works when the model
provider is dry — could not have reached anybody. The outbox's retry/backoff
absorbed all of it exactly the way it absorbed the gateway outage the night
before. **The only reason it was found at all is that the eval alert QUEUES**
(#82) rather than firing and forgetting: a pending row that would not clear,
with `held: "send failed"` in the heartbeat, is what there was to pull on.

- `config_guard` now checks it — a multi-agent roster with no `systemAgent`,
  or one naming an agent outside the roster, is a violation with the fix
  command in its text. The guard watched every OTHER config invariant that
  protects identity and had nothing to say about the one that carries
  delivery.
- **Verify the pipe, never the file**: `openclaw message send … --dry-run
  --json` returns `ok:false` with the real reason. That single command would
  have caught this the evening of the upgrade, and it is now the last line
  the script prints.

**And repairing the pipe immediately produced a false alarm of its own.**
The first `config_guard` tick after the fix told the owner *"🔴 משתמשים
חסומים ברמת הזהות — כל קריאת כלי שלהם נכשלת"*, naming EIGHT users — while
all eight agents were answering normally. `.olma-identity` stopped being the
credential on 2026-08-27, when the token moved inline into `AGENTS.md`; the
guard's wording and its `BREAKS_USERS` list both stayed on the old meaning,
so a stale FILE still read as a blocked user. (The files themselves are real
damage — a test suite running on the production box overwrote them during a
failed deploy — but what broke is those users' recovery path, not their
service.) `checkIdentityFiles` now reads `AGENTS.md` before choosing its
words: right token → `— fallback only`, filed on the dashboard and nobody
woken; wrong or missing → unchanged and still alarming, because then the
fallback IS the path. Two things worth carrying forward:

- **An alert that overstates is spent the first time someone checks it** —
  the same reason yellows wait for a second night and the runway warning
  climbs tiers instead of repeating. A backlog of alarms held behind a dead
  pipe arrives as a burst the moment the pipe returns, which is exactly when
  their wording gets read most carefully.
- The narrowing bit the fix on the way in: `/AGENTS\.md .*token/i` also
  matched the REASSURING half of the new sentence ("AGENTS.md carries the
  right token") and turned the deliberate non-alert straight back into an
  alarm. Caught by the test that pins the classification — patterns that
  match on prose have to be anchored to the failure, not the noun.

### Known gap: a reminder whose first rung died on the wire never climbs (2026-09-01)

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

### Nothing wakes Miron any more (2026-09-01)

Owner ask, plainly: "אתה יכול להפסיק לשלוח הודעות בלילה". The eval alert had
already been deferred to morning (#82). The **credit-outage alarm** was the
last thing that could fire at 03:00, and it held out longest because it is the
genuine "everything is down" signal — but the money can only be added by the
person asleep, the runway warning now says so days ahead, and it reads the
same at 08:00.

It **queues** rather than simply returning, and that difference is the whole
design: the outage's own evidence AGES OUT (failing reminders expire after two
hours), so a five-hour night outage would leave `min(created_at)` empty by
morning and be reported by nobody. The queued row keeps the moment it started;
the morning flush **re-reads reality before speaking** — present tense if it
is still broken, `recoveredText` if it healed overnight. An alarm saying "אף
הודעה לא נשלחת" about a working system is a false alarm, and one false alarm
is what teaches someone to ignore the next real one. Queuing also stamps
`credit_alert_at`, or the 30-second beat would re-queue the same outage all
night; the pending row is cleared only on a CONFIRMED send.

Both alarms now share `alertHourOpen` (08:00–22:00 in the alert phone's own
zone, converted in Postgres). **That made the outage tests hour-dependent** —
the "green thirteen hours a day" failure, one file lower — so the suite parks
a user on the alert phone at midday, and the test that borrows the flag puts
it back: a stray alert number with no user row silently re-opens the night
window for every test after it.

### The writing sounded like a form, and half the users were addressed as "את/ה" (2026-08-31)

Owner feedback, verbatim intent: the texting is robotic, sometimes
ungrammatical, walls of text, too many dashes — and address should default
to masculine with an early one-time question about switching to feminine.
The live transcript that triggered it was full of slashed forms ("ספר/י",
"תן/תני", "את/ה") — the agent had no stored gender and the old doctrine said
only "never guess", so it hedged in both genders at once, which reads like a
government form.

`agents-template.md` ("Language and tone"): masculine forms by default,
slashed forms named and banned, ONE early natural question about feminine
address stored via `remember_preference` (`gender_forms`); a stored
preference, or their own verbs, decide and skip the question. Style: write
like a person — short paragraphs with blank lines when a message must run
long, plain connected sentences instead of dash-chains, reread for gender/
number agreement before sending. The intake greeter (`intake-workspace.js`)
carries the same masculine-default line, since it speaks before any
preference can exist. Pinned in `tests/intake.test.js`; the doctrine change
reaches existing users via the deploy `--restart` resync, and the
`hebrew-gender-feminine` eval (stored feminine preference held consistently)
is unaffected — a stored preference still outranks the default.

### Live updates — "עדכן אותי על..." as infrastructure (2026-08-28)

Owner ask: מירון wants WhatsApp updates about new models on OpenRouter (with
a note when something is relevant to Olma), and more generally a feature
where a user can ask to be kept updated about live information — built
SMART: structured sources, not web crawling, minimal tokens. `domain/live-updates.js`,
migration 021.

- **A subscription = a SOURCE from a code registry + cadence + local hour.**
  `live_subscriptions` (params, last_state watermark, next_run_at); the
  hourly `live_updates` job (brokerd, expectations.js) picks due rows —
  planning-sweep pattern, rows decide who is due. Sources today:
  `openrouter_models` (three catalog views — the bare list hides media
  models; diff by model id against `last_state.knownIds`, an EVER-GROWING
  set — right for a catalog that is mostly append-only; only sends when new
  models actually appeared, with an "is any of this interesting for Olma"
  note), `weather` (Open-Meteo, free, no key; city geocoded ONCE at
  subscribe time; sends every cadence), and `news_topic` / `sports_summary`
  (2026-08-29 — Google News' own `news.google.com/rss/search?q=...` feed, no
  key, verified live; RSS is time-ordered and churns constantly, so unlike
  the catalog the watermark here is just the newest `pubDate` seen —
  bounded, and correct forever since old items never resurface; team is
  optional on sports, defaulting to a general "ספורט" query; both only send
  when something newer than the watermark actually appears). Adding a
  source is one registry entry — validateParams + fetch + prompt — no
  migration, no new sweeper. Parses RSS with a ~30-line zero-dependency
  reader (`parseRssItems`) rather than a new npm package — justified the
  same way the project's only two deps (`pg`, `@resvg/resvg-js`) were, and
  narrow on purpose: it only has to survive Google's own well-known feed
  shape, not arbitrary hostile XML.
- **The token economics are the design**: detection is a structured-API diff
  in plain code (zero tokens); the ONE background-model call
  (`llm.backgroundModel` → DeepSeek flash, ~$0.0001, recorded via
  `llm.recordUsage` into the subscriber's ledger) happens only when there is
  something to say. First run BASELINES silently — a new subscription must
  not open with "460 new models".
- **A reasoning model can spend its whole answer budget thinking, and never
  answer** (fixed 2026-08-29, hours after `news_topic` shipped). `summarize()`
  called `complete()` with `maxTokens: 700` — fine for the tiny test fixtures,
  not for מירון's first real run: 15 genuine headlines pushed
  deepseek-v4-flash to 676 reasoning tokens against the cap —
  `finish_reason: "length"`, `content: null`, no crash (an empty/unparseable
  reply is already a failed run — the watermark stays put and the sweep
  retries), but no message ever went out either, silently, until diagnosed by
  hand against the live API. `maxTokens` raised to 2000 (verified live:
  `finish_reason: "stop"`, a real coherent summary, $0.00018) and pinned by a
  test that reads the constant back out of the source — small test fixtures
  will never reproduce this, so nothing else could have caught the regression.
  Confirmed end-to-end post-deploy on מירון's own two live subscriptions
  (`news_topic`/בינה מלאכותית, `sports_summary`/ביתר ירושלים): both produced
  real coherent Hebrew summaries and landed on WhatsApp with a non-null
  `outbox.sent_at` — the first was delivered by the ordinary hourly sweep
  before any manual check ran, the second was forced due and delivered by the
  live outbox worker ~35s later, matching its own 30s tick.
- **Failure = retry, never swallow**: a transient fetch/LLM failure leaves
  `next_run_at` and the watermark alone (hourly tick retries); the outbox
  idempotency key `liveupd:<subId>:<date>` caps delivery at one per day per
  subscription regardless. Paused/eval users excluded in the due query.
- Tools: `subscribe_live_updates` / `list_my_live_updates` /
  `cancel_live_update` (open to all users, capped by the
  `live_subscriptions_per_user` flag, default 5; duplicates by
  (source, params) refused). Delivery is outbox kind `live_update`, normal
  urgency — quiet hours and budget hold as usual.

### Image + video generation, access-limited, spend in its own column (2026-08-28)

Owner ask: only the admin and חיים's number (+972505404255) may generate
images and video through our OpenRouter key, and the spend must be visible
separately. `domain/media.js` owns all of it; migration 017.

- **The catalog hides media models.** `GET /api/v1/models` returns text
  models only — `bytedance/seedance-2.0-mini` and `meta/muse-image` are NOT
  in it, but both exist: `?output_modalities=video` (27 models) /
  `=image` (50) reveal them, and `/api/v1/videos/models` carries the real
  per-model constraints (durations 4-15s, 480p/720p, aspect list). An
  earlier session concluded "no video models on OpenRouter" from the bare
  catalog — the owner's screenshot of the site proved otherwise.
- **Both kinds are submit-then-sweep — images too, since migration 018
  (2026-08-28, same day).** The first version made images synchronous inside
  the tool call ("~7s measured on a plain-triangle prompt, fits the 30s MCP
  budget"). Wrong, disproven live within the hour: מירון's first REAL prompt
  ("horse riding a horse") timed out at 25s; raising the margin to 27s just
  moved the failure — an unbounded direct call for the identical prompt took
  29.4s. `meta/muse-image` does not render a fixed-size image, it decides how
  much detail to spend per request (389 image_tokens for the triangle, 3052
  for the horse prompt, at a measured, consistent ~104 tokens/sec either way)
  — no fetch timeout under the 30s MCP ceiling can safely absorb every
  legitimate prompt. `generate_image` now only inserts a `media_jobs` row
  (kind='image', no provider_job_id/polling_url — OpenRouter's image endpoint
  has no job id of its own, one blocking call IS the whole job) and tells the
  agent it's on its way; `sweepMediaJobs` makes that (now unbounded) call
  itself, since sweeps were never under the 30s ceiling to begin with (video's
  own download step already ran a 60s fetch from inside one). Video is
  unchanged: `POST /api/v1/videos` → 202 + polling_url (~95s measured for
  4s/480p, $0.054); `sweepMediaJobs` (rides the existing minute tick, no new
  sweeper) polls, downloads the MP4, and both kinds land in the requester's
  workspace and enqueue ONE `media_ready` outbox row (urgent, idempotency
  `mediajob:<id>`, status-guarded UPDATE so a race cannot double-send).
  Failures get `media_failed` once; a job pending >30min is declared lost.
  `media_jobs.kind` CHECK widened to `('image','video')`;
  `provider_job_id`/`polling_url` made nullable for the image path.
- **The gate is server-side**: `role='admin'` (מירון, user 3 — granted and
  audited 2026-08-28) or a phone in the `media_gen_phones` flag
  (comma-separated, dashboard-editable). Every agent SEES the tools (tool
  listing is global) — the descriptions say never to offer the feature and
  the refusal happens on the call.
- **Video defaults to 480p, the cheapest tier** (owner ask, 2026-08-28) —
  `resolution` was not even a tool parameter before this, so the agent had no
  way to ask for better even if the user wanted it; added as optional, with
  the tool description telling the model to leave it unset unless the user
  explicitly asked for higher quality.
- **Money**: OpenRouter reports an authoritative `usage.cost` in USD on every
  generation — recorded as-is into `media_usage_ledger` (one row per user per
  day, images+videos together), rendered as its own block in the dashboard's
  cost section, deliberately OUTSIDE `usage_ledger` so the Anthropic
  reconciliation line stays honest. Models are flags too
  (`media_image_model`, `media_video_model`) — swapping models is a dashboard
  edit, not a deploy. FLAG_SPECS gained a `text` type for these.

### Friendship now enables everything, and friends can pass messages (2026-08-27)

Owner decision, two halves:

- **Approving a connection auto-grants every feature for BOTH sides**
  (`connections.respondToConnection` → `grants.autoGrantAll`, audited
  `grant.auto_granted`). The old flow — approve, then each side asked
  feature-by-feature — mostly produced silence and half-configured pairs.
  Per-side revoke keeps its exact meaning: `revoke_connection_feature` turns
  any feature off at any time, the gate (`requireFeatureBetween`) still
  checks both sides on every call, and `grant_connection_feature` now exists
  to turn one back ON. Tool descriptions, the `connection_response`
  instruction and the doctrine were all rewritten to stop asking about
  toggles and continue the original errand instead.
  `scripts/backfill-connection-grants.js` (dry-run default) brings
  pre-existing active connections up to the same rule — run ONCE at rollout,
  never on a schedule, so a later revoke is never resurrected.
- **`messages` is a third feature category** (one-line addition to
  `KNOWN_CONNECTION_FEATURES`, no migration): person-to-person messages
  relayed through Olma. `send_message_to_connection` (gated like everything
  else) → `domain/relay.js` → ONE outbox row `kind: 'relayed_message'`,
  urgency `urgent` — so it never folds into tomorrow's digest over a budget
  counter, but the recipient's own quiet-hours window, pause and block still
  hold it, which is precisely the "delivered when they're reachable"
  promise. The recipient's agent delivers it attributed to the sender,
  text fenced `<<< >>>` as data (max 1000 chars, refused over-length rather
  than truncated; identical text same day deduped via the idempotency key).
  The audit row (`relay.sent`) records that a message crossed, never its
  content. Doctrine: relay never arranges a meeting — scheduling stays with
  the meeting tools; a recipient tired of someone's messages gets
  `revoke_connection_feature feature=messages` offered. A message to a
  paused user is dropped by the gate like everything else — the sender is
  not told (pause state must not leak through delivery behaviour).

### A night-held message now gets a re-hearing when the person writes (2026-08-27)

The gate always had a 15-minute mid-conversation grace ("someone who just
wrote is awake"), but the worker never re-reads a held row before its
`release_after` — so a row held for the night slept until morning even while
its recipient chatted away. Observed live: two connection requests sat
'night'-held while the recipient was mid-conversation with Olma. `turn_start`
now nudges that user's `hold_reason = 'night'` rows to `release_after =
now()` on every inbound message; the gate stays the only judge (inside the
grace it delivers, otherwise it simply re-holds until the window). Only
'night' rows — a budget hold's budget is still spent, and a blocked user's
rows wait for the unblock summary; waking either would override the gate,
not re-ask it.

Same day, related repair: user 14's agent had overwritten its own
`.olma-identity` with a wrong token (the incident that motivated the
`chattr +i` lock), and the lock then froze the corrupt value in place. Fixed
by hand from `users.identity_token` (audited `admin.identity_repaired`);
when repairing, remember the immutable bit: `chattr -i` → write → `chattr +i`.

### A rollback cannot reach the filesystem (fixed 2026-08-27)

Six agents — `u-15`..`u-20` — sat in the live `openclaw.json` with workspaces
on disk, no user rows, and no audit trail. Each `USER.md` held a real user's
private first message (יובל's "yo", חיים's "מה העניינים ירון מה זה?"), pulled
in by the carryover bug that #44 later closed. Nobody was stranded — every
peer who ever wrote to intake is an active user — but the debris was
invisible for two days.

Mechanism: `sweepIntakeSessions` provisions several people inside ONE
transaction, and `provisionUser`'s side effects are a workspace write plus an
`openclaw.json` edit. On 2026-08-26 the gateway CLI was failing (third
Anthropic credit outage), `readIntakeFirstMessage` threw on a later phone,
the transaction rolled back — and every earlier person's DB row vanished
while their files and agent entries stayed. **A ROLLBACK cannot reach a file
or a config; whatever wrote them has to put them back.**

- `provisionUser` takes `registerUndo` and records what it actually created
  (`workspaceExisted`, `agentAdded`, `bindingAdded`, `allowFromAdded`), so
  `undoProvisionSideEffects` removes exactly that and never a workspace that
  was already there.
- `jobs/intake.runIntakeSweep(pool, deps)` owns the transaction — deliberately
  OUTSIDE `withTx`, so a failure in COMMIT itself is compensated too, not just
  one inside the callback. brokerd calls it instead of wrapping the sweep by
  hand. Undos run in reverse order, best-effort, never masking the real error.
- `config_guard.checkOrphanAgents` closes the detection half: the guard
  checked user→file from the start and never config→user. Only `u-<n>` ids
  are judged; `main`/`intake` have no user row by design.
- Found in passing and fixed here: `deprovisionUser`'s `fs.rmSync` has been
  broken since the `chattr +i` change — the immutable bit stops root too, so
  deleting a user from the dashboard threw EPERM and left the workspace
  behind. Both paths now go through `provision.removeWorkspaceTree`.
- Also: `checkStuckOutbox` had the COUNT in its title, and `fileViolations`
  dedupes on title — so nine near-identical "N outbox message(s) stuck" issues
  piled up over four days of the outage. Title is now stable.

**The dashboard was right the whole time and nobody read it.** The guard filed
"user 14: identity file does not match DB token" on 2026-08-26 09:28; it was
still `new` when the same user's broken token was diagnosed by hand a day
later. Thirteen open issues, every one already resolved in reality. A
detection layer nobody looks at is not a detection layer.

### Known gap: integrations were left behind by the cutover

v1 had per-user Google Calendar + Monday (`/opt/olma/broker/google-oauth.js`,
`crypto-store.js`, tools in v1's `olma-mcp.js`). v2 has an `integrations`
table but no credential columns, no `oauth_states`, no tools, and no
`/oauth/google/callback` route — and since the public host now points at the
v2 dashboard, the callback Google redirects to **404s**. One real connection
exists in the v1 SQLite DB (user `+972526269826`: calendar `read_write` +
Monday `read_only`). Porting it back is a restore, not a migration task; the
v1 tokens stay decryptable if v2 reuses `/opt/olma/.enc-key`.

### Repeating reminders were silently one-shot (fixed 2026-08-18)

`sweeps.js` compared `repeat_rule` against the literals `'daily'`/`'weekly'`
while the agent, handed a freeform field, stored RRULE-style `'FREQ=DAILY'`.
Nothing errored — the reminder fired once and no successor row was written.
Four of five live reminders were affected, including daily medication ones.
One vocabulary now lives in `domain/reminders.normalizeRepeatRule` /
`nextOccurrence`, normalised on write; migration 005 canonicalised the stored
values and revived the dropped occurrences. **Superseded in part 2026-08-29**
(see "Reminders that come back" above): the canonical set gained `monthly:16`
and `monthly:last`, and `nextOccurrence` takes the user's timezone — the
vocabulary listed here as `daily | weekly | weekly:MO,TH | NULL` is no longer
the whole of it.

### users.timezone must never be NULL

Nothing set it until 2026-08-18, so every row was NULL — and NULL falls back to
UTC in BOTH the outbox delivery gate and the digest sweep. For an Israeli user
that ran the 09:00-20:00 quiet-hours window at 12:00-23:00 local and fired every
digest three hours late. `domain/phone-timezone.js` (ported from v1) infers it
from the dialling code at provisioning, stored with `timezone_confirmed = false`
so the agent still confirms.

### Proactive delivery needs --to as well (fixed 2026-08-18)

`makeDeliverer` passes `--agent` + `--session-key` + `--channel` + `--to`. The
session key alone is not enough for a user who has never written to their OWN
agent (their first message went to intake): there is no session to derive a
target from, so `--deliver` fails with `Delivering to WhatsApp requires target`
and the welcome — the very message that would create the session — can never
land. Observed live: user 8 sat at 26 failed attempts, `onboarded_at` NULL,
receiving nothing from v2 at all. `--agent` keeps the turn on their own agent,
so the v1 lesson about `--to` hitting the default agent does not apply.

### Wedged session lanes (the live bug v2 works around)

`jobs/lane-watchdog.js` (added 2026-08-17) frees a lane the gateway itself
declared stuck and then refused to free. Root cause is in the gateway:
`isActiveRunProgressStale()` returns false whenever `lastProgressAgeMs` is
undefined, so recovery returns `keep_lane` forever and lowering
`diagnostics.stuckSessionAbortMs` (already 75s here) never helps. The
watchdog reads the gateway's own log, then calls `sessions.abort`
(RPC scope `operator.write` — no device upgrade needed) on that ONE key.
`jobs/unanswered.js` remains the slower backstop for messages dropped entirely.

### Model provider pilot: OpenRouter (RESOLVED 2026-08-26 — DeepSeek v4 is the plan of record)

**The cutover happened.** The Anthropic account ran dry a THIRD time
(08-20, 08-23, 08-26) and the owner decided not to refill — so open-weight
via OpenRouter went from pilot to production in one day:

- **Background cognition (fact-extraction, planning) runs on
  `deepseek/deepseek-v4-flash`** ($0.0886/$0.177 per Mtok, ~11x cheaper than
  Haiku) via the `background_llm` feature flag (`adapters/llm.backgroundModel`,
  dashboard-editable, fails open to the Anthropic default on malformed value).
  Verified live: the extraction tick that failed on Anthropic at 12:11
  succeeded on DeepSeek at 12:20, $0.0001/run in `usage_ledger`.
- **The registration blocker below is FIXED**: `register-openrouter-models.js`
  now writes both halves (allowlist + `models.providers.openrouter.models`).
  v4-flash/-pro are registered and appear in `models list`.
- **`scripts/set-default-model.js`** (dry-run default) flips
  `agents.defaults.model` to flash with pro + Haiku fallbacks; `--reset`
  restores Anthropic. Two clean pilots on u-3 first (model-pilot.js):
  honest tool sequence (turn_start → calendar → list_my_tasks → add_task)
  verified against the DB, correct Hebrew gender, ~77s wall for a cold
  pilot turn (watch `stuckSessionAbortMs=65s` — progress-staleness, not
  total duration, so streaming should keep lanes alive; verify on the
  first slow real turn).
- Benchmarks that justified it (2026-08-26, real briefs, recorded answers):
  flash matched Haiku's extraction exactly and — unlike Haiku AND v4-pro —
  did not hallucinate a past-year `expires_at`. Planning on real user-3 data
  was grounded and correct. DictaLM 3.0 24B (best Hebrew fluency) failed the
  rule-following half (missed dedupe, missed facts) — kept as the
  Hebrew-quality candidate for a self-hosted future, HF_TOKEN in
  `/opt/olma2/.env`.

The original pilot notes below stand as history (prices, the catalog
blocker, the cost reality check).

Every agent turn ran on `anthropic/claude-haiku-4-5` ($1.00/$5.00 per Mtok)
with `claude-sonnet-4-6` as fallback. The Anthropic account ran dry mid-day
2026-08-20 and every turn failed until it was topped up (see "a crashed turn
is not an answer"), which is what prompted looking at cheaper open-weight
models routed through OpenRouter.

**Done:**
- OpenRouter API key installed via OpenClaw's own credential CLI:
  `openclaw models auth paste-api-key --provider openrouter`. It lands in the
  agent's **encrypted sqlite auth store**
  (`~/.openclaw/agents/main/agent/openclaw-agent.sqlite`), NOT in a plaintext
  `Environment=` line the way `ELEVENLABS_API_KEY` did — a better trust model
  than the ElevenLabs precedent, and the one to copy for future providers.
  `openclaw models auth list` now shows `anthropic:manual` + `openrouter:manual`.
- `scripts/model-pilot.js` — runs a real agent turn (real workspace, USER.md,
  all ~59 MCP tools) on a **disposable session key and without `--deliver`**,
  so a comparison can never reach WhatsApp or contaminate a real session.
- `scripts/register-openrouter-models.js` — adds candidate models to the
  `agents.defaults.models` allowlist. Dry-run by default; does NOT touch
  `agents.defaults.model`, so registering never moves a live user onto an
  unproven model.
- Live config backed up: `/root/.openclaw/openclaw.json.pre-openrouter`.

**The blocker, and it is a real gateway constraint, not a config slip:**
`openclaw models list --all --provider openrouter` returns exactly THREE
entries — `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2.6`, `openrouter/auto`.
The bundled provider catalog does not carry Qwen3/DeepSeek/GLM, so
`--model openrouter/qwen/qwen3-235b-a22b-2507` fails with *"Model override
... is not allowed for agent u-3"* even with a valid key. Registering an
arbitrary OpenRouter model needs BOTH:
1. `agents.defaults.models["openrouter/<id>"] = {}` (the allowlist), and
2. a matching entry in `models.providers.openrouter.models[]`
   (`{ id, name }`) — the gateway says so itself in its own error text.
`models.providers` is currently `{}` and `models scan` only covers FREE
models, so there is no CLI path for step 2; it is a direct `openclaw.json`
edit through `src/intake/openclaw-config.js`.

**Prices checked live on OpenRouter 2026-08-20**, per Mtok in/out, vs Haiku's
$1.00/$5.00: `qwen3-235b-a22b-2507` $0.09/$0.55 (~11x/9x cheaper) ·
`deepseek-v3.2` $0.209/$0.310 (~5x/16x) · `llama-4-maverick` $0.20/$0.696 ·
`gpt-oss-120b` $0.03/$0.17 (cheapest, but Anglocentric — weakest Hebrew bet) ·
`glm-4.6` $0.43/$1.75 · `kimi-k2.6` $0.549/$2.313 (~1.8x/2.2x — the only one
usable **today** without a config edit). All advertise tools + JSON-schema
structured output, which is the hard requirement: an Olma turn is mostly tool
selection, and a model that calls tools unreliably is worthless here at any
price.

**Cost reality check before anyone over-invests:** the gateway's own counters
put ALL of v2 — 7 users, every background sweep, both silent agents — at
**~$1.81 total lifetime**. The $15.78 on the Anthropic key is cumulative since
2026-06-27 and mostly predates v2. The pilot is worth finishing as
infrastructure for scale, not as this month's savings.

**Next step:** register Qwen3 + DeepSeek in `models.providers.openrouter`,
restart the gateway, then compare against Haiku with `scripts/model-pilot.js`
on `u-3` only — judging Hebrew grammatical gender, tone, and above all whether
tool calls (meetings, contacts, reminders) stay correct.

**Two lines above are now known to be wrong (2026-08-31), left in place as
history and corrected here:**

- **Registering a model does NOT need a gateway restart.** Probed immediately
  after a write adding two models: the `--model` override was accepted, the
  gateway's own `executionTrace.winnerModel` named the candidate and
  `fallbackUsed` was false. This matters operationally — the restart is the
  only part of a model pilot that touches live users, so believing it was
  required is what confined these experiments to off-hours for months.
- **"`gpt-oss-120b` Anglocentric, weakest Hebrew bet" was a guess, and it
  measured TRUE but only once someone checked** — its `stop-service` reply
  degenerated to "בשמת על ההפעלה מחדש של שם שם שם?", and it is 1.6x slower
  over the suite. `qwen3.7-flash` is worse still: it answers with no tool call
  at all and rate-limits reproducibly on our tier.

**And the price argument is closed.** Read live 2026-08-31, the whole
tool-capable floor is ~$0.03/$0.13 against the incumbent's $0.089/$0.177 —
hundredths of a cent per Mtok on a system billing ~$18/month. A future swap
needs a quality or speed case. Dated per-run detail lives in
`olma2/docs/model-experiments.md`, which is the log; this file only carries
the conclusion.

### Background cognition runs on direct API calls, not agent turns (2026-08-25)

`adapters/llm.js` is the substrate: one direct Messages API call (Haiku,
`ANTHROPIC_API_KEY` in `/opt/olma2/.env`, zero deps), one narrow interface an
OpenRouter backend could implement later. Three rules it owns:

- **The server is the judge.** The model returns ONE JSON proposal; the JOB
  validates and writes through the same domain functions the live tools call.
  First live call proved why: "בספטמבר" came back as `expires_at 2025-09-15` —
  a year the model assumed, in the past, which would have expired the fact on
  arrival. Past/unparseable expiries are dropped, the fact kept.
- **Usage is recorded by the caller** (`llm.recordUsage` → `usage_ledger`):
  a direct call has no transcript for the usage sweep to find, so unrecorded
  cost would silently vanish from the dashboard (migration 012's lesson).
- **An unparseable reply is a failed run, not an empty one** — watermarks stay
  put and the work is retried next tick.

Consumers so far: **fact-extraction** (rewritten — was a full agent turn with
60+ tool schemas; measured live at $0.0022/run vs ~$0.045, 20x; the NO_REPLY
and honest-tool-calling fragilities are gone by construction) and the
**planning pass** (`jobs/planning.js`, migration 015): daily, in each user's
05:00-07:00 local (after memory consolidation, before digests), reads open
tasks + task_reminders + calendar (best-effort) + top facts, and writes
`user_plans` — **which is NOT a message and never becomes one on its own**.
It renders into USER.md ("Today's plan … notes for YOU, not a message to
send", omitted when stale >26h or user paused), so digests, checkins and live
turns get smarter through channels that already respect quiet hours, budget
and pause. Paused users are skipped at `dueUsers` — a plan is Olma leaning
forward, which is what they declined. Live quality check on realistic data:
correct prioritisation by due date, correct tz conversions, no inventions.
memory-consolidation stays on the agent path (it edits workspace files).

### The API bill was 76% cache writes — fixed with a 1h cache + a prompt diet (2026-08-22)

With the ledger finally accurate, the breakdown over every transcript on disk
came out: cacheWrite $10.53 (76%), cacheRead 13%, output 11%, input 0%. Every
cold turn re-wrote a ~29.5k-token prefix into a cache that lives 5 minutes —
and Olma's traffic (a WhatsApp message every 20 minutes, fact-extraction 30
minutes after a chapter closes) is precisely wrong for a 5-minute cache.
Three changes, all reversible:

- **`agents.defaults.params.cacheRetention: "long"`** (native OpenClaw knob →
  `cache_control {type:"ephemeral", ttl:"1h"}`; `scripts/set-cache-retention.js
  --apply`, `--reset` reverts). Verified live in Anthropic's usage report:
  writes moved to the `ephemeral_1h` bucket. The stated bet: a 1h write costs
  2x input vs 1.25x for 5m, and wins only if it prevents ≥ ~40% of re-writes —
  the dashboard reconciliation line is the judge, and the revert condition is
  "daily average not down after 48h vs the $1.0-1.4 baseline of Aug 18-21".
- **`tools.deny`** for gateway tools with no caller by design
  (`scripts/trim-agent-tools.js`): cron (12.5k schema chars! — v2 schedules in
  brokerd), message (forbidden by DELIVERY_PREAMBLE; the DeepSeek pilot proved
  the double-send hazard is real — denying makes doctrine a hard stop),
  sessions_*, apply_patch. `read`/`write` stay (.olma-identity, USER.md).
- **Prompt diet**: tool descriptions compressed keeping every doctrine rule
  (tests pin the rules, reworded to match), `agents-template.md` 30.1k → 19.1k
  chars with zero rules dropped, identity_token boilerplate shortened (×64).

Measured cold-start result: system prompt 49.9k → 36.7k chars, tool schemas
35.3k → 18.4k chars, cold cacheWrite ~32.7k → 21.5k tokens (-34%) — and a
second session minutes later wrote only 7.7k, riding the now-warm 1h cache.
Pricing followed the switch: `domain/model-pricing.js` cacheWrite is the 1h
rate (2x input) since transcripts don't carry TTL; `adapters/infra-cost.js`
prices the report's 5m/1h buckets separately, so history stays exact.

### Cost reporting was wrong in BOTH directions (fixed 2026-08-22)

Two independent bugs, each of which made the dashboard's cost numbers useless,
found by comparing them against Anthropic's own console after the account ran
out of credit mid-conversation on 2026-08-20.

**1. Per-user attribution read a gauge as a counter.** `jobs/usage.js` summed
`totalTokens` out of the gateway's `sessions.json` and accumulated positive
deltas, on the stated belief the field is cumulative. It is not:

- `totalTokens` is the size of the CURRENT CONTEXT. Every session in the index
  sits at 26k-38k no matter how long the conversation ran. One real session
  (u-3, `9b199906`) held 138 model calls and 5,690,328 billable tokens; its
  gauge read 58,892.
- `estimatedCostUsd` is derived from that same gauge, and each call's own
  `usage.cost` block comes back all-zero from the gateway — so it is not a
  price at all.
- **Sessions rotate.** That $2.18 session no longer appears in `sessions.json`;
  the WhatsApp session key now points at a newer sessionId. Its usage did not
  merely go unpriced, it became invisible, and the delta arithmetic saw a
  shrink and re-baselined to zero.
- Agents with no user row (`main`, `intake`, and every retired v1 agent) were
  skipped outright, so background sweeps and the intake greeter cost nothing
  on paper.

Rewritten to read the TRANSCRIPTS, which are append-only and carry a real
`usage` block per assistant message. `usage_session_snapshots.byte_offset` is
the high-water mark — it only moves forward, so a re-run charges nothing twice,
and an old transcript is still read after the index forgets it. Prices live in
`domain/model-pricing.js` (migration 012 has the autopsy). Non-user agents go
to a new `usage_system_ledger`.

**2. The "source of truth" was itself under-reporting by 4x.**
`adapters/infra-cost.js` reads Anthropic's org `usage_report/messages`, and
priced cache writes from `row.cache_creation_input_tokens` — **a field that
does not exist in the response.** The real one is `cache_creation`, an object
keyed by TTL (`{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`). Since
an Olma turn re-caches a 40k-char system prompt plus 59 tool schemas
constantly, this is the single largest line on the bill: 2,808,131 cache-write
tokens silently priced at zero on 2026-08-20 alone, turning a real $4.57 day
into $1.06. The page looked perfectly healthy the whole time.

**What makes it stay fixed:** the cost section now renders a reconciliation
line — attributed-here vs billed-by-Anthropic, with the percentage gap, shown
always rather than only when it breaks. A silent divergence between the two is
exactly how both bugs survived a month. Post-fix, days from 2026-08-18 onward
reconcile at 0.0%; earlier days remain 36-92% short because those transcripts
have already rotated off disk, which is unrecoverable and now visible instead
of hidden.

**Sizing, for context:** the real figure is ~$18/month, not the ~$2 the broken
ledger claimed. 2026-08-20 alone was $4.57, and roughly half of it was ONE
real WhatsApp conversation (138 model calls: a meeting negotiation, a contact
save, a calendar reconnect). Model pilots were 5% of that day. There is no
runaway process — a long tool-using conversation is simply what it costs.

### Voice-note transcription moved to ElevenLabs Scribe v2 (2026-08-18)

Was local `whisper.cpp` only (`/root/whisper-transcribe.sh`, ggml-small-q5_0,
~37s wall time — the number the 75s watchdog floor above was sized around).
Now `tools.media.audio.models` in `openclaw.json` is
`[{ provider: "elevenlabs", model: "scribe_v2", language: "he" }, { type:
"cli", command: "/root/whisper-transcribe.sh", ... }]` — ElevenLabs first,
the old local script kept as an automatic fallback (OpenClaw tries entries in
order, moves on on failure/timeout — no code change needed for the fallback
to work). `ELEVENLABS_API_KEY` lives in
`/root/.config/systemd/user/openclaw-gateway.service` as a plain
`Environment=` line (0600, root-only — same trust model as `openclaw.json`
itself; OpenClaw's own docs say "set it in the environment", there's no
`models.providers.elevenlabs.apiKey` field for the audio-STT path the way
there is for TTS). Verified live 2026-08-18: a real voice note went from
receipt to transcript in the log in ~4s (vs the ~37s local baseline) with a
clean Hebrew transcript — no explicit provider tag in the log line since
`--verbose` isn't on, but the timing alone rules out the local CLI path
(300s timeout, ~37s typical).

**Gotcha hit during setup**: the first key pasted in returned `401
missing_permissions` on `/v1/speech-to-text` — it was a scoped ElevenLabs key
without the `speech_to_text` permission checked, not an invalid/expired key.
Fixable from the ElevenLabs dashboard (Settings → API Keys → edit
permissions) without rotating the key.

**Recovery thresholds lowered to match (2026-08-18)**: `stuckSessionWarnMs`
30s→25s, `stuckSessionAbortMs` 75s→65s
(`olma2/scripts/set-recovery-thresholds.js --apply`, then gateway restart).
Not a naive "latency dropped 9x so shrink 9x" move — the ElevenLabs model
entry got its own `timeoutSeconds: 15` (down from the 60s provider default)
so a hang fails over to the local whisper.cpp fallback quickly, but that
fallback path itself is unchanged (~37s). Worst-case *legitimate* run is now
bounded by ElevenLabs-timeout + local-whisper-run ≈ 15s + 37s ≈ 52s, so 65s
keeps ~13s of margin above that — the thing this floor has to stay above is
the slowest real fallback, not the fast common case.

### Long schedules go out as an image, not a wall of text (2026-08-19)

A real "תמונת מצב" reply ran to 17 tasks + 5 reminders + calendar events in one
WhatsApp message. `render_schedule_card` (registry.js) draws that as a PNG
instead. What makes it work, all verified against the gateway source and live:

- **Delivery is the `MEDIA:` marker, not a tool.** A line `MEDIA: <path>` in the
  agent's FINAL reply is parsed out by the gateway (`MEDIA_TOKEN_RE`,
  `payloads-*.js`) and attached to that same message. `extractMediaDirectives`
  defaults ON for the final reply (only the intermediate streaming-block path
  disables it). So it rides the existing `--deliver` turn — **no new outbox
  kind, no second send**, and no conflict with `DELIVERY_PREAMBLE`'s
  never-call-a-sending-tool rule. The tool returns a path; it sends nothing.
- **The workspace IS the security boundary.** Outbound media is only read from
  the agent's `localRoots`, which always include its own workspace
  (`resolveAgentScopedOutboundMediaAccess`); `assertLocalMediaAllowed` throws
  `path-not-allowed` for anything else, after `realpath` (so symlinks don't
  escape). Cards therefore go to `<users.workspace_path>/cards/<uuid>.png`,
  built from the DB row and never from tool args. A prompt-injected
  `MEDIA: /etc/shadow` sends nothing. `hostMediaRead` is NOT set in
  `openclaw.json` — turning it on would dissolve this guarantee.
- **Renderer: `@resvg/resvg-js`** (first dependency besides `pg`), with Heebo
  vendored in `olma2/assets/fonts/` and `loadSystemFonts:false` — the droplet
  has no Hebrew font, and pinning the files keeps output deterministic.
  Chose it over headless Chrome after measuring both on the same SVG: pixel
  output differs by 1.8% (glyph antialiasing only), but Chrome costs ~1.2s of
  launch and ~200MB against 998MB free on a 1-vCPU box.
- **Two gotchas the code comments guard**: every `<text>` must open with RLM
  (U+200F) or a line starting with a digit renders with the number flung to
  the wrong end; and resvg **cannot draw colour emoji from a font** — icons are
  twemoji PNGs inlined as data URIs, addressed by a closed semantic vocabulary
  (`birthday`, `travel`…) so a bad name falls back to `generic` instead of
  drawing nothing. `scripts/calibrate-card-metrics.js` measures the text-width
  coefficients via `getBBox()`; rerun it if the font or weights change.
- Render cost on the live box: 57ms (3 items) → 156ms (24). Synchronous, so it
  blocks brokerd's event loop — that is what `LIMITS.totalItems` is protecting.
- Files age out inside the existing `jobs/retention.js` sweep (24h, flag
  `card_retention_hours`), not a new cron.
- **`agents-template.md` changes reach existing users only via
  `scripts/resync-agent-templates.js --apply`** — AGENTS.md is written once at
  provisioning. Run it after any doctrine edit.

### Check-ins were counting messages that never arrived (fixed 2026-08-20)

Existing users had gone nearly silent on proactive outreach — traced to two
compounding bugs in `jobs/checkin.js`. **(1)** `checkin_misses` incremented on
every enqueued onboarding step, including ones that landed inside quiet hours,
expired unsent, and were never delivered — an evening joiner could rack up two
ghost misses before midnight, tripping the ladder down to weekly cadence on
day one with zero real ignores. Day-one onboarding steps no longer increment
misses at all; a new `isDeafOnDayOne(client, userId, onboardedAt)` (≥2
delivered onboarding messages + no inbound since onboarding) gates the 5h step
directly instead. **(2)** Once a check-in did land, it was a generic "מה
קורה?" — content nobody had reason to answer. Added a `discovery` rung
(`discoveryGaps()`) that checks what's actually missing for *this* person —
no `digest_times` with open tasks, a facts card under 3 active entries, no
calendar connection, zero active connections — and offers to close the
highest-value gap, rotating topics (never the same one twice in a row via the
prior outbox row's `payload->>'topic'`) and falling back to plain silence only
when there is genuinely nothing to offer. Three stuck users' inflated
`checkin_misses` were reset via audited admin SQL after deploy.

### "אני רוצה להפסיק את השירות" was answered with a goodbye and nothing else (fixed 2026-08-22)

```
21/08 19:47:01  him:  אני רוצה להפסיק את השירות
21/08 19:47:08  Olma: בטוח? יש משהו שלא עובד כמו שצריך, או פשוט די לך?
21/08 19:47:16  him:  זהו
21/08 19:47:21  Olma: בסדר, קפיש. בהצלחה לך! 💙      ← and called NO tool
22/08 06:21:21  Olma: שלום קפיש 👋 רציתי להציץ...     ← proactive check-in
```

His daily medication reminder was still armed for that evening too. The
conversation was handled exactly right — one confirming question, a clear
answer, a warm goodbye — and then nothing happened, because **there was nothing
to call**: no tool, no dashboard control, and `users.checkin_enabled` was a dead
switch (one query read it, nothing on the box ever wrote it, and it only ever
covered check-ins anyway). The only "stop" that existed anywhere was the
dashboard's delete button — irreversible, operator-only, and not what he asked
for. Same shape as the two bugs above it: the agent understood, and the outcome
had no structured home.

**Pause is reversible and deletes nothing** (`domain/pause.js`, migration 013
`users.paused_at`). Someone done with a product is not asking to be erased;
treating "stop messaging me" as "delete my account" would be a second thing
done to them they never asked for. Tasks, reminders, facts, preferences and
history all stay.

- **`pause_olma` / `resume_olma`** are the tools that were missing.
  `agents-template.md` gained **"When they want you to stop"**: one confirming
  question → on their yes call `pause_olma` THAT TURN, before replying → then
  say plainly that Olma will not write again, nothing was deleted, and one
  message brings it back. Never argue, never pitch to retain, never ask twice.
- **The gate is the chokepoint.** `outbox/gate.js` returns a new terminal
  action `drop` for a paused user, checked FIRST and with no exceptions —
  not reminders (the user picked the time, and they have now unpicked it), not
  urgent, not another user's fan-out. `hold` would mean delivering later and
  there is no later; `expire` folds into a digest and would then be delivered.
  The worker stamps `sent_at` with `hold_reason = 'paused'` (UPDATE, never
  DELETE, so the producing sweep cannot recreate it) and excludes those rows
  from the daily budget count, so six cancelled messages do not exhaust the
  budget on return.
- **Every sweep also skips paused users** (`checkin`, `sweepDigests`,
  `reminders.dueForSending`, `unanswered`, `fact-extraction`) so the rows are
  mostly never manufactured. `dueForSending` matters twice: successors are
  written per send, so an unguarded paused user grows a fresh reminder row
  every day they are away. `unanswered` is the exception that argues hardest to
  be one — it exists to finish a conversation the PERSON started — and stays
  out anyway: "Olma never initiates" is only a promise if it has no clauses.
- **Reactive replies still work.** Pausing stops Olma initiating, not Olma
  answering — a person who writes wants something. The card shows `PAUSED` with
  an explicit instruction never to offer, pitch or schedule while it is set.
- **Resume re-arms repeating reminders at their own next real time**
  (`nextOccurrenceAfter` walks the rule forward from its last occurrence), so
  "18:00 daily" comes back at 18:00, not at whatever hour resume was pressed.
  A one-off whose moment passed is NOT resurrected. Matching is on
  `cancelled_at >= paused_at`, `DISTINCT ON (task_id)`, so two pauses cannot
  bring the same reminder back twice.
- **The dashboard can resume, never pause.** An operator can bring someone back
  (they asked, through some channel that is not their agent); there is no admin
  pause button, because that would be a way to silence a user without their say.

Live: קפיש (user 9) was stopped by hand the moment this was found — reminder
#32 cancelled ~10h before it would have fired, `checkin_enabled = false`,
audited as `admin.service_stopped` with `dataDeleted: false` — then migrated
onto `paused_at` once this shipped.

### Pausing left them relying on their own memory to come back (fixed 2026-08-22)

The pause feature above fixed the incident it was built for, and immediately
raised the next question: if קפיש writes to Olma again next week, does he get
answered and then silently wait — same as before pause existed, except now
HE has to remember `resume_olma` exists rather than Olma ever bringing it up?
Asked explicitly, and yes, that gap was real.

`turn_start` (`registry.js`) now stamps `resume_offer_sent_at` the first time
a paused person's message arrives, and returns `offerResume: true` for that
one turn only. The write is the atomic UPDATE itself —
`WHERE paused_at IS NOT NULL AND (resume_offer_sent_at IS NULL OR
resume_offer_sent_at < paused_at)` — so a second concurrent call to the same
turn cannot double-offer, and comparing against `paused_at` rather than
clearing the column on resume means a leftover value from an EARLIER pause
cycle reads as "not offered this time" for free — resume, then pause again,
and the offer fires once more with no second write anywhere.

Doctrine (`agents-template.md`): answer what they actually asked, in full,
first — then ONE line asking if they'd like Olma back. Never twice in the
same pause; that would be the exact pitch-to-retain pattern the stop section
already forbids. If they say no, or just talk about something else,
`offerResume` will not fire again until they resume and pause once more.

Caught a pre-existing test-isolation bug while adding coverage: one test in
`mcp-e2e.test.js` dropped the shared DB's `quota_daily_free` flag to 1 to
test the block flow, and never restored it — every later test in the file
sharing that connection was one stray `turn_start` call away from silently
hitting `blocked` instead of `proceed`. Fixed with a `finally` restoring it
to the default (50); this is what made the resume-offer tests flake until
found, since they are the first in the file to call `turn_start` more than
twice for one user.

Migration 014, verified against production's actual current state (13
applied, matching the tree) rather than an older dump.

### Two branches, one migration number (fixed 2026-08-22)

`src/db/migrate.js` derives `version` from `parseInt(filename)`, and
`schema_migrations.version` is the PRIMARY KEY. Two branches each adding an
`011-*.sql` — the ordinary way this repo works, since neither sees the other's
file until they merge — meant the runner applied one, inserted version 11, then
violated the key on the second. Every test file's `freshDb()` threw inside its
`before` hook and the suite stopped producing a readable result at all.

The part that cost the most time: **only the `pull_request` build ever sees
both files.** `actions/checkout` builds a merge commit for `pull_request` and
checks out the branch head for `push`, so the branch's own push build stayed
green and passed in 41s while the PR check hung indefinitely on the same
commit, same runner, same job definition.

The other half is worse and is what actually bit this branch twice. A version
can be burned by a branch that never merged: production had version 12 applied
from `012-usage-from-transcripts.sql`, deployed by hand off
`perf/prompt-cache-costs`, while `main` still ends at 011. A same-named new 012
would then be filtered out of `pending` as "already applied" — deploy reports
success, the column is never created, and the code that needs it fails at
runtime with nothing in the log about a migration.

Both are guarded now:
- `listMigrations()` refuses two files sharing a version, by name, before any
  SQL runs.
- `migrate()` records the FILE each version came from (`schema_migrations.file`,
  added in-place; pre-existing rows stay NULL and are not checked) and refuses
  to proceed when a version was applied here from a different file.

`tests/db-types.test.js` covers the tree being collision-free today, the
duplicate guard firing, and the burned-version guard refusing rather than
skipping. **Pick a number above every version the target database has seen —
`SELECT max(version) FROM schema_migrations` on the box, not `ls migrations/`
on main — and never renumber one that has already been applied anywhere.**

### The name was in front of us on every turn (fixed 2026-08-22)

A user's card read `First name: unknown` and, two lines below it, `[context]
שמו חיים.` — the same file asserting both. `users.first_name` was NULL, so the
dashboard, the digest and every invitation showed his phone number, and
`connections.requestConnection` refused outright (it hard-requires a first
name), while his own agent greeted him as חיים because it read the name off the
FACT card. Four of eight active users were nameless; three of them had a
display name the system had watched go past on every turn.

The name arrives with EVERY inbound message. The gateway prepends a
`Conversation info (untrusted metadata)` block carrying `"sender": "חיים דדוש"`
— visible to the model, never to brokerd, and written down by nobody. Three
layers each had their own reason to drop it:

- **Provisioning only knew one source.** `intake/provision.js` prefills a name
  from `user_contacts` (someone else's address book). Nothing read the display
  name, and `jobs/intake.js` passes no `firstName` at all, so an organic joiner
  starts NULL by construction.
- **The doctrine said ASK, so the agent never SAVED.** `agents-template.md`
  ranked the name first on the curiosity ladder as *"ask what to call them"*,
  and `set_my_name`'s own tool description said *"their own request only"* —
  actively telling the agent not to record a name it could plainly see.
- **The read-back had nowhere to put it.** `jobs/fact-extraction.js` did learn
  the name, and its only tools were `remember_fact`/`add_task`, so the name
  landed in `user_facts` as prose. Exactly the vehicles failure one layer down:
  the net catches it and files it where nothing looks.

The fix turns on one distinction `setTimezone` already drew in this table:
**`setName(..., { confirmed })`**. Confirmed = they told us, and it overwrites.
Unconfirmed = we observed it (display name, a name read back out of a
transcript) — it fills a blank, refines an earlier guess, is audited as
`user.name_observed`, and can NEVER overwrite a name the person confirmed
(guarded in the UPDATE itself, not read-then-write). A guess is worth far more
than a blank: it is what lets Olma use the name at all, and `name_confirmed =
false` keeps the agent checking. On top of that:

- `turn_start` takes `sender_name` and captures it only when `first_name` is
  NULL. It runs on every message, so it cannot join `CARD_TOOLS` — it flags the
  envelope (`result.cardStale`, honoured in `brokerd/server.js`) on the one turn
  in a person's life that fills the name in. `render.js` serialises `data` only,
  so the flag never reaches the model.
- Untrusted is the right label and the reason this is safe: `cleanName` already
  bounds a name to one line of 60 chars because it is interpolated unwrapped
  into another person's agent instruction (`domain/connections.js`). A `sender`
  that is mostly digits is the gateway echoing the number back — dropped.
- The extraction job gets a THIRD pass, offered only when there is no name on
  file, and `set_my_name` in its tool list; the fact pass is told a name belongs
  in the profile. The card now spells out both the unknown and the unconfirmed
  case instead of printing a bare `unknown` nobody acted on.

**Going back for the ones it already happened to** is
`scripts/repair-missing-name.js` (dry-run by default, `--phone` to aim,
`--name` for a peer who set no display name, `--keep-facts`). It reads the
display name out of the gateway's own trajectory files
(`sessions.readPeerDisplayName` — BACKFILL ONLY, hundreds of KB per session,
newest-first across all of a peer's sessions because only turns the PERSON
started carry a Conversation info block), writes it unconfirmed, soft-deletes
the fact the name had been hiding in, and refreshes USER.md. It sends nothing:
messaging someone to say we had forgotten their name would cost them more than
the bug did.

### A goal said out loud left no trace anywhere (fixed 2026-08-21)

A user told Olma he needed to sell three of his vehicles. It was never saved,
never split, no reminder was offered, and nothing ever came back to it. Three
separate mechanisms each had a reason to drop it, which is why nobody noticed:

- **The read-back was told to.** `jobs/fact-extraction.js` — the net under a
  turn the agent was too busy to catch — carried the line *"Do NOT record:
  tasks or things to do"*, and `remember_fact` was the only tool it could call.
  It now runs two passes over the same transcript: facts, then **commitments**
  (`add_task` / `add_tasks_bulk`), with the person's open list pasted in as the
  dedupe reference and hard rules against inventing a date, setting a reminder,
  or sending anything. New rows are stamped `source = 'extracted'` by the JOB
  via a high-water mark — the same trick facts already used, never a parameter
  the model must set honestly — and show on the user page as a `מהשיחה` pill.
- **Splitting cost more than not splitting.** `add_tasks_bulk` now takes
  `parent_task_id`, so a goal becomes a project plus N parts in ONE call.
  Previously the only path was a loop of `add_task`, which the doctrine
  explicitly forbids for a dump, so in practice big goals were saved (if at
  all) as one undoable line.
- **The proactive ladder was blind to it.** Every rung was deadline-driven:
  `deadline_risk` needs `due_at` inside 24h, `overload` counts overdue rows —
  and a goal like this arrives with no date at all. New `stalled_goal` rung
  (above `discovery`, below `overload`): open, top-level, no due date, no
  pending reminder, nothing done under it, older than 3 days if it has open
  parts / 7 days if it is a lone line. **One goal per fortnight per user**,
  rotating between them, matched on `payload->>'topic' = goal:<id>` — the rung
  that exists to move something forward must never become the drum it replaced.

Doctrine side: `agents-template.md` gained "A goal they mention IS a task"
(save it that turn → split it if it has obvious parts → ONE follow-up, a date
or the single unblocking question → everything else across later days), and the
curiosity ladder now ranks an open goal above the digest/calendar pitches.

**Going back for the person it already happened to** is a separate job from
stopping it recurring, and the code fixes above do only the second.
`scripts/repair-missed-goal.js --phone <n> --note "<the goal>" [--apply]`
(logic in `domain/repair.js`, dry-run by default, same-day idempotent) does the
first, in two moves and inventing nothing: it clears
`users.last_fact_extraction_at` so the next read-back tick re-reads their recent
conversation and saves the goal in THEIR words, and enqueues ONE `checkin` row
whose instruction opens with it. The row carries `release_after = now + 15min`
so the read-back can land first, and the delivery gate then holds it until that
person's own availability window opens — so running the repair at midnight
reaches them when they wake up. It also resets `checkin_misses` (a ladder that
had backed off to weekly, or given up at 4, would otherwise swallow the
message). Matching is on trailing phone digits, and an ambiguous fragment
refuses with the candidates rather than picking one.

### A Saturday nudge about Friday's poker game (fixed 2026-08-22)

A user was asked, on Saturday morning, whether "יום שישי בשעה 20:00" worked
for him. It was the `stuck_meeting` rung — the TOP of the check-in ladder —
chasing a proposal nobody had answered. Three gaps stacked:

- **A slot had no machine-readable time.** `meetings.proposed_slot` was TEXT
  only, so *nothing in the system could ask whether the moment had passed.*
  That is the root; the rest follows from it.
- **Nothing ever closed a negotiation.** Not `retention.js`, not any sweep;
  the round cap was removed 2026-08-15 by design. A meeting stayed
  `negotiating` until confirmed, cancelled, or emptied by opt-outs —
  otherwise forever.
- **The nudge query had no time bound at all**: `proposed_slot IS NOT NULL`
  was the whole test. And since `stuck_meeting` outranks every other rung, one
  dead meeting also **shadowed every other check-in that person should have
  been getting**.

Migration 011 adds `proposed_start_at` / `confirmed_start_at` and an `expired`
status. `propose_meeting_slot` now **requires `starts_at`** — the same moment
as the text, ISO-8601 with offset — under the identical refuse-don't-guess rule
calendar events already had (that rule now lives once, in `domain/datetime.js`,
shared by both). A slot already in the past is refused at proposal time, before
it reaches anyone's phone. `respond_to_meeting_slot` needs `counter_starts_at`
alongside a counter-proposal for the same reason.

`pendingMeetingFor` excludes a slot that has started **and** any row whose
`proposed_start_at` is NULL — legacy rows cannot be dated, and asking about a
possibly-dead slot is the bug itself. `sweepStaleMeetings` (in the existing
minute tick, no new cron) closes what passed: 6h after the start, or after
`LEGACY_STALE_DAYS = 3` untouched for NULL-start rows. The grace is deliberate
— closing a meeting early is worse than closing it late. The automatic sweep
tells the INITIATOR once (`meeting_expired`, idempotency key `mexpired:<id>`),
because they are the only one who can restart it.

`scripts/close-stale-meeting.js --phone <n>` lists someone's open negotiations
with ages; `--id N --apply` closes one — and, unlike the sweep, tells EVERY
active participant, not just the initiator (`mexpired:<id>:<userId>` each).
An operator closing a meeting by hand is very often doing it on behalf of the
person who was AWAITING an answer, not the one who asked — that person
deserves to know it ended too. `expireOne`'s `UPDATE ... WHERE status =
'negotiating'` still guarantees only one of {sweep, script} ever succeeds on a
given meeting, so this can never double-message anyone.

### A retry cap that overflowed the thing it was capping (fixed 2026-08-24)

The Anthropic account ran dry again on 2026-08-23 (same failure as 2026-08-20).
Every agent turn started returning *"Your credit balance is too low"*, so every
delivery failed and `outbox.attempts` climbed all day. That part is external and
recoverable. What made it an outage was the backoff:

```sql
release_after = now() + least(interval '10 minutes',
                              interval '5 seconds' * power(3, attempts))
```

**`least()` evaluates both arguments.** The cap never protected the
multiplication that produced the value being capped — it only compared the
result afterwards. An `interval` holds microseconds in an int64, so at
`attempts = 26` (5s x 3^26 = 1.3e19us > 9.2e18) the multiplication threw
`interval out of range`, and the row could no longer record even its own
failure. The comment above it promised "everything queued goes out within ten
minutes of service returning"; topping the account back up would in fact have
changed nothing.

The second half is what turned two bad rows into total silence: `drainOnce` had
no per-row guard, and it drains `ORDER BY created_at`. So the two oldest
poisoned rows aborted every tick before the 28 healthy messages behind them were
reached. `outbox_worker` sat at `ERR interval out of range` for ~13 hours with
`/health` correctly red the whole time and nobody looking.

- The exponent is capped **before** it is multiplied: `power(3, least(attempts, 6))`.
- Each row is processed inside its own `try`; anything that escapes is pushed to
  `outcomes.errored` (ids + message, visible in the heartbeat note) and stepped
  over. **One row failing is a defect; one row silencing the system is an
  outage.**
- The pre-existing backoff test used `attempts = 20`, below the 26 threshold —
  which is exactly why this survived. The new test walks 26/40/100.

Worth remembering as a shape: `/health` was right, it had been red for half a
day, and the deploy gate had just been moved off it (see the `/ready` split
above) for unrelated but correct reasons. Nothing was watching the endpoint that
was telling the truth.

### Both of them explained why, and neither ever heard it (fixed 2026-08-22)

Meeting #4 ("פוקר", מירון + עמית) burned four slots in one afternoon —
שני → ראשון → שני → ראשון → שלישי — while BOTH men were explaining
themselves to their own Olma the whole time. מירון's row held *"בצילומים
ומסיים מאוחר — פנוי בשני, שלישי וחמישי"*. עמית's held *"לא ביום שני"*, the
bare fact with the reason stripped off. Neither reason ever crossed.

Three things were wrong, and only the middle one looks like the bug:

- **The reason was never asked for.** `record_meeting_constraint`'s whole
  description was *"Save a constraint the user stated (\"not Fridays\")"* —
  availability, not why. So a reason offered in conversation was recorded as
  a day, or not at all.
- **It never travelled.** `meeting_slot_proposed` — the message the other
  person actually receives — carried the slot and nothing else. The reason sat
  in `meeting_participants.constraints` where the sweep could read it and the
  recipient could not. `meeting_slot_declined` only *suggested* the agent go
  look via `get_meeting_status`, and only on a decline.
- **`get_meeting_status` handed over everything.** It returned every
  participant's raw constraints to every participant. So the data was already
  crossing — silently, with no notion of anyone having chosen to share it.

Reasons are now shared **by default**, because a reason given while arranging
a thing is part of arranging it: `record_meeting_constraint` takes
`private=true` as an opt-out, and `shareableConstraints` rides along with
`meeting_slot_proposed` (including counter-proposals) and
`meeting_slot_declined`. The flag is honoured on the way OUT — `getStatus`
now shows a participant their own constraints in full and everyone else's
shareable ones only. **A flag the writer sets and the reader ignores is worse
than no flag, because it is a promise.**

Constraints are stored as `{ text, private }`; rows written before this are
plain strings and read as shareable, which is the chosen default. Each is
capped at 200 chars and at most 3 travel, because this text is written by one
user and interpolated into another user's agent turn — the same reasoning as
`cleanName`. It is quoted inside the usual `<<< >>>` fence, and doctrine says
to reflect it in the user's own language and never as verified fact: *"אמית
אמר שהוא בצילומים"*, never *"אמית בצילומים"*. Olma never presses for a reason
— a day ruled out without one is a complete answer.

**Found alongside it, and separate:** the machine time disagreed with the
text. "יום שני 20:00" was stored as Aug 25 (Tuesday) and "יום שלישי 20:00" as
Aug 26 (Wednesday), while "יום ראשון" mapped correctly — an off-by-one on
everything after Sunday. `domain/datetime.js` validates FORMAT only (offset
present) and `proposeSlot` refuses only a past time, so a well-formed but
wrong date sails through and the row that expiry, nudges and the calendar all
read says a different day from the one both people are discussing. Meeting #4's
row was corrected by hand (`admin.meeting_slot_corrected`, slot text left
alone, nothing sent).

**Closed 2026-08-24.** `domain/datetime.js` now owns the weekday vocabulary
alongside the offset rule (one file, same reasoning as
`reminders.normalizeRepeatRule`): `weekdaysInText` reads Hebrew day names —
including prefixed forms (`בשבת`, `ושני`) and `יום א׳` letters — plus English
names and abbreviations; `weekdayInZone` says which day the moment falls on
**in the user's timezone** (falling back to the offset the model itself wrote,
never silently to UTC); `weekdayClash` refuses the disagreement rather than
resolving it, since neither half is known to be the right one. Text naming no
weekday is untouched — the check only fires when there is something to check.
The reader is deliberately narrow because a false positive REFUSES a real
proposal: trailing-letter lookaheads keep `שנייה`/`ראשונה` out, and `ל` is not
an accepted prefix so `לשבת בקפה` stays "to sit at the cafe".
`meetings.badSlot` applies it to `proposeSlot` **and** validates a
counter-proposal BEFORE the decline is written — a counter refused halfway
used to leave the meeting declined with nothing proposed. No migration: this
is a validation rule, not a column. Tests: `tests/slot-weekday.test.js`
(vocabulary, timezone edges, the live meeting #4 rows) plus four in
`tests/meetings.test.js`. `tests/helpers.slotStart(text)` is how meeting tests
now build a timestamp that agrees with their own slot text — hard-coding
"Tuesday 17:00" beside `now + 48h` passes or fails depending on the day the
suite runs.

### A shift said as "15:00" was stored as 15:00 UTC (fixed 2026-08-26)

A user confirmed her week's shifts in plain Hebrew — "רביעי מ15-22", her own
local time, obviously — and the tool call wrote `due_at 2026-08-26T15:00:00Z`:
her local digits re-labelled UTC, three hours late in real terms. The reminder
was then correctly derived 30 minutes before the WRONG time, and the morning
digest made the bug visible by reading both numbers back in one line:
*"משמרת 15:00–22:00 (תזכורת ב-17:30)"* — a reminder arriving 2.5 hours after
the shift it was for. All five bulk-created shifts had the identical drift.

The root: `due_at`/`remind_at` never got the offset guard calendar events and
meeting slots already had. The trajectory shows the model writing bare local
times on EVERY date-carrying call in that conversation — `"2026-08-26T14:30:00"`,
no offset, no Z — which Postgres then read in the server's timezone (UTC).
Same class as the NULL `users.timezone` incident: a bare time plus an assumed
frame, silent by construction.

`add_task` / `add_tasks_bulk` / `snooze_task` / `set_task_reminder` now refuse
a string without an offset through the same `hasOffset`/`badTime` in
`domain/datetime.js`, and their tool descriptions say to convert from the
user's stated local time via their timezone (USER.md carries it). Two edges
that earned their lines:

- **`hasOffset` accepts a real `Date` instance unchanged** — a Date is already
  an unambiguous instant. Found by a test failure, not design: `domain/pause.js`'s
  resume re-arm computes a Date for the next occurrence, and refusing it would
  have silently stopped re-arming reminders on resume — a worse bug than the
  one being fixed. Only strings crossing the tool boundary are checked.
- **A well-formed but WRONG `…T15:00:00Z` still passes.** Format validation
  cannot tell a correct UTC instant from local digits mislabelled Z. Meetings
  answered this with `weekdayClash`; tasks have no semantic cross-check yet
  (titles like "משמרת … 15:00-22:00" often carry the hour, so one is possible)
  — worth building if the mislabelled-Z form ever shows up in a trajectory.

Going back for the data was separate from stopping the recurrence: the two
still-future shifts (tasks 41/42 + reminders) were corrected by direct audited
UPDATE (`admin.task_due_corrected` / `admin.reminder_corrected`, matching the
meeting-slot precedent); past ones were left alone — their wrong reminders had
already fired and rewriting history helps nobody. Verified live post-deploy:
the next reminder fired at 14:30 local, 30 minutes before the real shift, and
a bare-time `add_task` probe against the live broker came back refused.

### "I can't do that" was the whole answer (fixed 2026-08-21)

A user asked Olma to look a few things up online and buy them. She has no web
access and no way to purchase — 65 tools, none of them search, browse or pay —
so the answer was correct and useless: his errand went down with the refusal,
including the details he had already typed. He ended the exchange worse off
than before it, still needing the thing and now also told no.

`agents-template.md` replaced the three-line "offer to log it" section with
**When it is something Olma cannot do**. It names the boundary explicitly
(no internet search, no links, no prices, no stock, no orders, no payment, no
phone calls, no email) so the model stops improvising around an unnamed limit,
then requires three moves in ONE message: say it plainly once → **offer to
save the request as a task ("רוצה שאשמור לך את זה כמשימה?"), and on a yes save
it in their own words with the detail they already gave, plus a reminder if it
is time-shaped** → log the gap as `feature_request` / `agent_detected`.

The offer is deliberate and is the ONE exception to act-first (which the goal
section now cross-references, so the two save-rules cannot read as
contradicting each other): everywhere else the person is describing their own
errand, so Olma guesses and lets them correct; here they asked OLMA to do it
and the answer was no, so writing it to their list uninvited hands the job
back to them without asking. Logging the gap stays silent — it is the agent's
own observation, invisible to them and about the product rather than their
list, so it needs no permission and must never be asked about. Previously that
demand signal was gated behind the user agreeing to file it, so most of it was
never captured. `report_issue`'s tool description carries the same rule at the call
site.

The load-bearing half is the **hallucination guard**. A request to look
something up is where a model is most likely to answer from training data as
though it had looked: a price, a stock level, a link, "מצאתי לך". Those all
assert a lookup that never happened, and for a purchase the remembered version
is stale by construction. Knowledge that does not go stale is allowed when it
is plainly the agent's own rather than a lookup; a price never qualifies.

### Deploying doctrine no longer needs a second command (2026-08-21)

`agents-template.md` is written into a workspace once, at provisioning, so every
doctrine change used to reach NEW users only unless someone remembered
`scripts/resync-agent-templates.js --apply` afterwards — and a step that is only
ever remembered is eventually forgotten. `deploy.sh --restart` now runs it
itself, **after** the post-restart health check passes (never before: a
workspace must not be handed doctrine from a release that is about to be rolled
back out from under it). `roll_back()` runs it too — the script derives what to
write from the template in the currently-deployed tree, so calling it after a
restore puts the OLD doctrine back, keeping one invariant: what the workspaces
say matches the code that is actually running. A resync failure fails the run
but does NOT roll back — the service is up and healthy, and doctrine that
silently reached nobody is the exact failure this step ends. A local deploy
without `--restart` still resyncs nothing and now says so on stderr.

### A Google consent with no calendar scope was stored as "connected" (fixed 2026-08-20)

Google's OAuth consent screen shows the calendar permission as its own
checkbox, separate from the base email/profile grant — a user can press
"Continue" without ticking it, and the token exchange still succeeds with only
`userinfo.email`/`openid` granted. `calendar.completeOAuth` used to accept
that token and store a "connected, read_only" row that 403'd on every real
call (live: user 8, 2026-08-20 — she saw a success page and then nothing
worked). Now a consent granting neither `calendar.events` nor
`calendar.readonly` is refused outright: the useless token is revoked at
Google, any PRIOR working connection is left untouched, and the person gets a
`calendar_scope_missing` outbox message telling them exactly which box to
tick, plus a callback page that explains instead of showing false success.
See `domain/calendar.js` (`completeOAuth`), `channels/openclaw.js` (payload
case), `adapters/http/dashboard.js` (callback page + outbox label).

**A connection that breaks LATER had the same silence** (fixed 2026-08-22).
`markNeedsReauth` enqueues exactly one `calendar_needs_reauth` message and then
never raises it again, so a reconnect the person starts and abandons is dropped
forever — user 3's calendar was rejected by Google on 2026-08-20 20:22, he began
a reconnect 30 minutes later, never finished, and 36 hours of meetings and
digests ran calendar-less without a word. The `discovery` check-in rung *did*
qualify him (its gap query asks for `status = 'connected'`, and `needs_reauth`
is not that) but would have pitched it as a first-timer's feature — "your
calendar is not connected, here is what it does" — to someone who set it up
twice and watched it break. `discoveryGaps` in `jobs/checkin.js` now reads the
status instead of testing for one, and a rejected connection gets its own
instruction: say plainly that it expired, skip the pitch, ask the access level,
reconnect. That rung is now the only thing in the system that ever revisits an
abandoned reconnect.

### Onboarding has no "welcome" step any more (redesigned 2026-08-17)

Retired the whole `kind: 'welcome'` outbox mechanism. The intake greeter
(`intake/intake-workspace.js`) went silent (`NO_REPLY`) earlier the same day
to stop a real duplicate-message incident (two voices — a generic intake
reply and a scripted personal welcome — landed as two separate WhatsApp
messages); going silent fixed the duplicate but felt worse than either. The
actual redesign: the greeter answers for real, in Olma's voice, with genuine
product knowledge and no tools — never a placeholder, never "wait a bit,
the real me is coming." There is no second, separate welcome moment left for
it to clash with. When `provisionUser` (`intake/provision.js`) activates the
person's own agent, `onboarded_at` is set right there (not on a message
delivery), and whatever they already told the greeter — extracted facts
only, never the raw transcript — is written straight into their new
workspace's `USER.md`. `agents-template.md` tells the personal agent to fold
that in on its first real turn and then remove it; the conversation the
person is already having simply continues, silently more capable.
- **`bindings` hot-apply — but only when bundled with another hot change.**
  (Corrected 2026-08-16 from the gateway source + live evidence, after an
  earlier probe over-generalised and cost every new user 2-4 minutes.)
  `server-reload-handlers-*.js:170` early-returns when the reload plan is a
  noop, skipping the `params.setState(nextState)` at :607 that swaps in the
  new config; a plan is noop only when `hotReasons` is empty. So a
  bindings-ONLY write is silently dropped, while `bindings + agents.list` in
  the SAME write applies both. Provisioning always writes agent+binding in one
  `saveConfig` → live in ~1s, no restart. Only the one-off catch-all binding
  (`install-intake.js`) is bindings-only and needs its single restart.
  Peer wildcard `peer:{kind:"direct",id:"*"}` is supported, outranked by exact
  peers.
- **Never poll `openclaw sessions list` on a timer** — measured 2.9s of CPU
  per invocation, which on this 1-vCPU box is ~20% of the core per 15s tick
  and directly slows every agent reply. The same facts (plus token counters
  and the gateway's own cost estimate) are in
  `agents/<id>/sessions/sessions.json`, keyed by session key. `olma2/src/channels/sessions.js`
  reads it; all three former poll sites now use that.
- Stdio MCP servers get NO identity env vars from the gateway (probed) —
  the workspace `.olma-identity` file remains the only auth root; brokerd's
  `config_guard` job watches the config invariants that protect it.

### The live dashboard is v2's (`olma2/src/adapters/http/dashboard.js`)

The `## Dashboard` section further down describes **v1's**, which is dead —
its "5 edits with a positional param on `renderPage(...)`" recipe does not
apply here and following it wastes a session. This is the one that serves
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

## Multi-user architecture

One shared MCP server (`olma-mcp.js`) serves every user — OpenClaw spawns
every configured MCP server on every agent turn regardless of tool
allow/deny, so per-user servers don't scale (measured cap: a few dozen
users). Identity comes from a per-workspace `.olma-identity` file holding a
`olma_tok_<32 hex>` token (`tools.fs.workspaceOnly` makes it unforgeable —
an agent can only read its own). Every tool takes `identity_token`; none
accept a `user_id`. `resolveOwner()` (`olma-mcp.js:62`) is the whole auth
mechanism. Verified at 1000-user scale: `scale-test.js`, 300 concurrent
calls, ~1.5ms each, zero cross-user leakage.

`provision-user.js` does new-user setup end-to-end: DB row → workspace +
`AGENTS.md` (rendered from `agents-template.md`) → `openclaw agents add` →
`sealWorkspace()` (strips OpenClaw's stock onboarding kit, which otherwise
hijacks the first conversation) → routing binding + `allowFrom` in
`openclaw.json` → identity token → `welcome.js` fires ~25s later (after the
gateway restart routing needs).

## Database schema

Tables: `users, tasks, reminders, shares, task_shares, roundups,
roundup_participants, connections, connection_feature_grants, meetings,
meeting_participants, audit_log, integrations, oauth_states, usage,
feature_requests (created lazily)`.

**`users`** — `id, phone (E.164, UNIQUE), first_name, last_name, role
('admin'|'user'), status ('pending'|'active'|'blocked'), agent_id,
workspace_path, timezone, timezone_confirmed, name_confirmed, onboarded_at,
identity_token, digest_times, digest_scope, last_checkin_at,
checkin_misses, checkin_enabled, invited_by_connection_id`.

**`tasks`** — `id, owner_id, title, due_at, status, source, category,
include_in_digest, archived_at, parent_id` (self-referential, one level of
project/sub-task nesting only — capped in code, not schema).

**`shares`** (whole task-list, mutual consent) / **`task_shares`** (single
task/project, offer-only) — `owner_id, viewer_id, scope, status
('pending_owner'|'pending_viewer'|'active'|'declined'|'revoked'),
requested_by`. Completely independent of `connections` below — don't
conflate the two when reading code that touches both.

**`connections`** (added 2026-08-14) — mutual-consent "friendship" gating
cross-user scheduling (`create_roundup`). `requester_id, target_id (NULL
until the target joins), target_phone (always known), status ('invited' →
'pending_target' → 'active', or 'declined'/'revoked'), invite_message,
invited_at, responded_at, requester_label, target_label`. Two paths in one
state machine:
- target already an Olma user → starts `pending_target`
- target has no user row → starts `invited`, ONE outbound intro message
  sent (no follow-up ever); `connection-invite-poller.js` auto-provisions
  them if they reply and flips the row to `pending_target`; `welcome.js`
  then asks them to confirm.

Labels (`requester_label`/`target_label`) are private nicknames ("אמא"),
one per side, independent — not symmetric.

**`connection_feature_grants`** (added 2026-08-14) — a connection alone is
not enough to USE a feature. Each side independently grants specific
categories (`sharing`, `meetings`, `roundups` — validated in code via
`KNOWN_CONNECTION_FEATURES`, not a DB CHECK, so a new category is a
one-line addition, no migration) per connection; a row's presence =
granted, absence = not granted, default off. Deliberately NOT mutual —
Miron enabling sharing with Kapish does not enable anything on Kapish's
side. `requireFeatureGrant()`/`gateParticipantsOnFeature()` are what
`create_roundup`, `start_meeting_coordination`, and the three sharing
tools (`share_my_tasks_with`, `share_task_with`,
`request_access_to_tasks_of`) all check before doing anything — the error
distinguishes "not connected" from "connected but not granted" so the
model always has an actionable next step. Right when a connection
activates, both sides are asked (via `askAgent()`, not plain `notify()` —
a reply is expected, so it must land in their real session) which
features they want. `migrate-connection-grants.js` backfills all three
categories for both sides of every *pre-existing* active connection so
this didn't silently break anything already working.

**`roundups`** / **`roundup_participants`** — the "ask N people one
question, collect answers, report to the initiator only" primitive.
**`create_roundup` is disabled** (`ROUNDUP_CREATE_ENABLED = false` in
olma-mcp.js, 2026-08-15 — under evaluation as a feature, agents kept
using it for scheduling despite the tool description warning them off,
which is exactly the failure mode `meetings` exists to prevent). The
tool definition and handler are left intact, just filtered out of the
exposed `TOOLS` list and refused defensively in the handler too — flip
the flag back to re-enable. The other roundup tools (`list_my_roundups`,
`close_roundup`, `answer_roundup`, `decline_roundup`, etc.) still work.
`aggregation` is `'status'` only now (`'availability'` retired
2026-08-14 — old rows keep the value, nothing new writes it).
`roundup_participants.state`: `awaiting|answered|declined`.

**`meetings`** / **`meeting_participants`** (added 2026-08-14) — the
*only* path for scheduling/coordinating between people now; replaces
round-ups' old `aggregation:'availability'` use case entirely, because a
round-up's "collect independently, no reconciliation" shape let one
side's agent unilaterally declare a meeting "arranged" without the other
side ever agreeing to that specific slot (real production incident).
`meetings.status`: `negotiating|confirmed|no_match|cancelled`.
`meeting_participants.state`: `awaiting|confirmed_current|declined_current|opted_out`.
**The one rule enforced in code, not just prompted**: status can only
become `confirmed` via `tryConfirmMeeting()` (called from
`respond_to_meeting_slot` and `opt_out_of_meeting`, the only two
callers), and only once every *active* (non-`opted_out`) participant row
is `confirmed_current` against the identical `proposed_slot` — no tool
lets a model narrate a meeting into existence. Tool descriptions (2026-08-15)
frame `slot_description` as date+time+medium (location/phone/video)
together as one package, not time alone — confirming means agreeing to
all of it. `meeting_participants.constraints` is a JSON array of
freeform strings each person has said, so nobody is asked about a day
they already ruled out.

**No round cap** (removed 2026-08-15 — `meetings.round`/`max_rounds`
columns still exist for telemetry but are no longer enforced; a meeting
just keeps negotiating until it confirms, the initiator cancels via
`cancel_meeting`, or **`opt_out_of_meeting`** removes someone — the
initiator can't opt out of their own meeting, they must cancel instead.
Opting out excludes that participant from the confirmation gate (and
from future `propose`-round targets, via `activeParticipantTargets`);
if opting out leaves the initiator with nobody else active, the meeting
auto-closes `no_match`. `checkin.js`'s existing idle/daytime/cooldown
sweep is what re-prompts a participant stuck in `awaiting` (see below)
— there is no separate meeting-specific cron script by design, to avoid
running two similar sweepers.

On confirmation, the fan-out to each participant (`meeting-fanout.js`,
`confirmed` case) also checks `calendar_status` and — if they have
read_write Google Calendar connected — has their own agent turn work
out the real start/end from the confirmed slot and call
`create_calendar_event` for them; if not connected, it offers to
connect instead of pushing. This runs per-participant in their own
turn (not centrally in olma-mcp.js) because turning freeform slot text
into a real datetime needs the LLM's own language understanding, not a
deterministic parser, and each person's calendar is independently
theirs — there is no cross-user "invite" concept.

Fan-out script: `meeting-fanout.js` (mirrors `fanout.js`'s structure,
one `kind` per state transition: `gather`, `ask_initiator_to_propose`,
`propose`, `confirmed`, `no_match`, `cancelled`).

Deliberately 1:1-only for now — every fan-out targets a specific
`whatsapp:direct:<phone>` session, never a group. Group-chat-specific
meeting behavior (Olma present in a WhatsApp group with several humans)
is an intentionally separate future feature, not yet designed.

**`audit_log`** — every cross-user exposure (`share.*`, `roundup.*`,
`connection.*`) logs here: `actor_id, event, detail (JSON), created_at`.

## MCP tool inventory (`/opt/olma/broker/olma-mcp.js`, ~3100 lines)

Recipe for adding a new tool group (every section below follows it): a
doctrine comment block → `const XXX_TOOLS = [...]` (every schema needs
`identity_token` in both `properties` and `required`) → `function
handleXxxCall(db, ownerId, name, args, now)` returning `text(...)` or
`default: return null` → append `XXX_TOOLS` to the big `.concat(...)` before
`const TOOLS = [` → append `|| handleXxxCall(...)` to the chain inside
`handleCall`'s `default:` case.

| Lines | Group | Tools |
|---|---|---|
| 164–383 | Calendar (async — own path via `ASYNC_TOOL_NAMES`) | `start_calendar_connection, calendar_status, disconnect_calendar, my_calendar_events, create_calendar_event, update_calendar_event` |
| 384–469 | Digest | `get_my_digest, set_digest_preferences, set_task_reminder, list_my_archive` |
| 470–556 | Capture (brain dump) | `add_tasks_bulk` |
| 557–710 | Learned preferences (→ caller's own `AGENTS.md`, behavior only) | `remember_preference, forget_preference, list_my_preferences` |
| 711–776 | Feature requests | `request_feature` |
| 862–1000 | Monday (async, read-only by construction) | `connect_monday, disconnect_monday, my_monday_boards, my_monday_items` |
| 1001–1106 | Profile | `get_my_profile, set_my_name, confirm_my_name, set_my_timezone` |
| 1107–1230 | Projects (one level of sub-tasks) | `add_subtask, group_tasks_into_project, get_project_overview` |
| 1271–1717 | Round-ups | `create_roundup` — **disabled**, see schema section (still gated on `connections` in code) — `list_my_roundups, get_roundup_answers, close_roundup, list_my_pending_roundups, answer_roundup, decline_roundup` |
| 1718–2157 | **Connections** (friendship) | `request_connection, list_pending_connection_requests, respond_to_connection_request, list_my_connections, set_contact_label, remove_contact_label, revoke_connection` |
| 2158–2497 | **Meetings** (scheduling — see schema section above for the hard-gate rule, opt-out, and no round cap) | `start_meeting_coordination, record_meeting_constraint, propose_meeting_slot, respond_to_meeting_slot, opt_out_of_meeting, get_meeting_status, list_my_meetings, cancel_meeting` |
| ~2500+ | Core tasks + sharing (inline `switch`, not a separate handler fn; the three offer/request tools also gate on `connection_feature_grants` — see schema section) | `list_my_tasks, add_task, complete_task, snooze_task, share_my_tasks_with, share_task_with, request_access_to_tasks_of, list_pending_share_approvals, respond_to_share, list_my_shares, revoke_share, view_shared_tasks` |

Shared helpers worth knowing: `resolveOwner`, `withDb`, `audit`, `notify`
(fire-and-forget WhatsApp send, swallows errors — never use for anything
needing delivery confirmation), `scrubTokens`/`wrapUntrusted` (defense in
depth against token leaks and prompt injection from another user's free
text), `findCounterparty` (deliberately conflates "no such user" with
"blocked"/"self" for privacy — do NOT reuse it where the caller needs to
tell those apart, e.g. anything that might message a stranger; use
`lookupUserByPhone` instead for that).

## Other broker scripts

- `checkin.js` — proactive re-engagement sweeper, gated on idle time / daytime / digest proximity. `--apply` to send, dry-run by default. Since 2026-08-15 it also checks each about-to-be-nudged user for a `meeting_participants` row stuck in `awaiting` on a `negotiating` meeting, and if one exists it takes priority over task-nudging in `buildInstruction()` — this is deliberately the *only* mechanism that re-prompts a stuck meeting participant (no separate meeting-specific cron script, to avoid two similar sweepers).
- `setup-digest-cron.js` — (re)creates per-user `openclaw cron` digest jobs. Payload is always an *instruction* ("call get_my_digest now"), never baked content — a prior incident had a stored task-list snapshot go stale and announce already-completed chores.
- `memory-consolidation-sweep.js` — weekly (Sunday 03:00, root crontab, **not** `openclaw cron add` — that demanded a device scope upgrade to full `admin`, declined as disproportionate; see gotcha above) asks each active user's own agent, one `openclaw agent --agent <id>` call per user, no `--deliver`, to silently fold `memory/*.md` into `MEMORY.md`. Same instruction-not-content rule as the digest.
- `connection-invite-poller.js` — polls `openclaw pairing list whatsapp --json` every 2 min (root crontab, not `openclaw cron` — see gotcha above) for a peer-invited stranger's reply; auto-approves + provisions ONLY numbers with a matching `connections` row in `invited` status, leaves organic strangers for the dashboard's manual approval.
- `workspace-seed.js` — `sealWorkspace()` neutralizes OpenClaw's stock onboarding kit and creates `MEMORY.md`/`memory/` (never overwrites an existing `USER.md`/`MEMORY.md` — those accumulate real content). CLI (`node workspace-seed.js [--apply]`) backfills every DB-tracked user; the legacy `main` workspace isn't DB-tracked so isn't touched by it.
- `migrate-connections.js` — one-off, idempotent; safe to re-run.

## Memory architecture (turned on 2026-08-14)

OpenClaw ships a three-tier memory system; it was previously just never
configured. Now live in every workspace:

- **`USER.md`** — tiny identity card, injected every turn.
- **`memory/YYYY-MM-DD.md`** — raw daily notes, auto-injected for the last 2 days on session start only (`agents.defaults.contextInjection: "continuation-skip"` — full bootstrap files no longer re-inject on every turn within a session, saving ~4-5k tokens/turn).
- **`MEMORY.md`** — curated long-term summary, folded from daily notes by a weekly root-crontab sweep (`memory-consolidation-sweep.js`, Sunday 03:00 — deliberately not `openclaw cron add`, see gotcha above).
- Deliberately no embedding key / no `active-memory` plugin — `memory_search`/`memory_get` use free keyword (FTS5/BM25) search, on-demand only, to keep steady-state cost near zero.
- **Contact/phone-number facts never belong in memory files** — that's what `connections` + `set_contact_label` are for (structured + tool-backed, not prose the model might mis-recall).

## Dashboard — v1, DEAD (`/opt/olma-dashboard/server.js`, ~715 lines)

**Nothing routes here.** Kept only to explain v1 code you may still read on the
box. The live dashboard is v2's — see "The live dashboard is v2's" above, whose
structure is different in almost every particular (named sections, not
positional args; `url.pathname`, not exact `req.url`).

Zero deps, `node:sqlite`, HTTP Basic auth, server-rendered HTML + form POSTs
(no JS, no `/api/*` fragments). Sections in page order: pending pairing →
users → task shares → **connections (חברויות)** → **meetings (פגישות,
added 2026-08-14 — read-only, shows status/proposed-or-confirmed
slot/participant states; "confirmed" only ever means every participant
actually agreed, never a guess)** → external integrations → round-ups →
feature requests → audit log. Adding a section is 5 edits: a
`read*()` (guard with `sqlite_master` check if the table might not exist
yet), a `render*Section()`, a new positional param on `renderPage(...)`, a
`<h2>` block in the body, a new arg in the `GET /` call — keep the
positional order identical between the signature and the call site, that's
the one easy thing to get wrong. Routes match on exact `req.url` string, not
`url.pathname`, except the Google OAuth callback.

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

## Testing

All 8 broker tests speak real MCP over stdio to a real `node olma-mcp.js`
child process, against a throwaway `/tmp` DB built from `schema.sql` +
per-test `ALTER`s, with `--no-notify`. Run after any broker change:

```bash
cd /opt/olma/broker
for t in security-test.js roundup-test.js projects-test.js connections-test.js \
         connection-grants-test.js meetings-test.js scale-test.js capture-prefs-test.js \
         feature-request-test.js checkin-test.js; do
  node "$t"
done
```

`scale-test.js` seeds 1000 users / 10000 tasks and asserts zero cross-user
leakage under 300 concurrent calls — the load-bearing proof that the
single-shared-process design actually holds up.
