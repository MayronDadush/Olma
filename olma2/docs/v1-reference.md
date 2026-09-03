# Olma v1 — reference for code still on the box

**Nothing routes here.** v1 was retired in place at the 2026-08-17 cutover:
its code still sits in `/opt/olma/broker/`, its SQLite DB still holds real
rows, and its dashboard is down. This file exists for one purpose — so that
someone reading v1 code on the server can understand it without re-deriving
it, and so that v1's shape is never mistaken for the live system's.

Moved verbatim out of CLAUDE.md on 2026-09-03. **Do not follow any recipe in
this file for live work**: the v2 dashboard, schema, tools and test suite are
different in almost every particular, and this file's instructions actively
mislead if applied to them. `CLAUDE.md` describes what is live.

The one thing here that still matters operationally is the **Known gap** noted
in CLAUDE.md: v1's Google Calendar and Monday integrations went dark at the
cutover, and v1's tokens stay decryptable if v2 reuses `/opt/olma/.enc-key`.

---

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
