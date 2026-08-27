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
