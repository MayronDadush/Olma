# Olma — architecture reference for Claude Code

Condensed ground truth for the live system, so a fresh session doesn't need
several SSH explorations to get oriented. `README.md` is the ops runbook
(connect, restart, update); this file is the code map. Both live only here —
the actual code lives on the server (`/opt/olma/`, `/opt/olma-dashboard/`),
not in this git repo. If this file and the server disagree, the server wins —
update this file, don't trust it blindly for anything you're about to act on.

## ⚠️ Two systems coexist on the box (since 2026-08-16)

Everything below "Multi-user architecture" describes **v1**, the system users
are LIVE on today. **Olma 2.0** is fully built and running alongside it,
NOT yet serving users (cutover = Phase G, pending):

- **Source of truth: `olma2/` in THIS repo** (unlike v1). ~5.3k lines, 83
  tests. `olma2/README.md` is its map. Deploy+test: `bash olma2/scripts/deploy.sh`
  (rsync → `/opt/olma2/` → migrations → full suite on the server).
- Postgres 16 local (`olma2` + `olma2_test` DBs), creds in `/opt/olma2/.env`
  (0600). Daily `pg_dump` 02:15 → `/root/backups/`, 14-day retention.
- Services: `olma2-brokerd` (unix-socket daemon: pg pool, flood counters,
  outbox worker + all sweeps, heartbeats in `job_heartbeats`) and
  `olma2-dashboard` (`127.0.0.1:8788`, Basic Auth creds in `/opt/olma2/.env`).
- v2 intake sweeps are **inert** until an `intake` agent exists in
  openclaw.json (`scripts/install-intake.js` — cutover-only, needs
  `dmPolicy:"open"` + one gateway restart for the catch-all binding).
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

## Dashboard (`/opt/olma-dashboard/server.js`, ~715 lines)

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
