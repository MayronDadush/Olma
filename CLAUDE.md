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
- Postgres 16 local (`olma2` + `olma2_test` DBs), creds in `/opt/olma2/.env`
  (0600). Daily `pg_dump` 02:15 → `/root/backups/`, 14-day retention.
  **The dump lands on the same droplet it backs up — no off-box copy yet.**
- Services: `olma2-brokerd` (unix-socket daemon: pg pool, flood counters,
  outbox worker + all sweeps, heartbeats in `job_heartbeats`) and
  `olma2-dashboard` (`127.0.0.1:8788`, Basic Auth creds in `/opt/olma2/.env`).

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
`nextOccurrence` (canonical: `daily` | `weekly` | `weekly:MO,TH` | NULL),
normalised on write; migration 005 canonicalised the stored values and revived
the dropped occurrences.

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

### Model provider pilot: OpenRouter (in progress 2026-08-20)

Every agent turn runs on `anthropic/claude-haiku-4-5` ($1.00/$5.00 per Mtok)
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
