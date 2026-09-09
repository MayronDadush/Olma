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
- **The live OpenRouter model names its providers in order**
  (`agents.defaults.models["openrouter/deepseek/deepseek-v4-flash"].params
  .provider.order`, `scripts/pin-openrouter-provider.js --apply`, restart the
  gateway). Unpinned, OpenRouter picked a different provider per request —
  three in six hours on 2026-09-09 — and a prompt cache is per provider, so
  the first call of nearly every message paid the whole prompt: 0–9% cached
  for any gap over two minutes, ~90% for the second call of the same turn
  (`incidents.md`, "The conversation that never ended"). DigitalOcean first
  for the price ($0.068/M against $0.089–0.091), the two it was already using
  behind it, `allow_fallbacks: true` so an outage costs the cache and never a
  reply. `register-openrouter-models.js` writes `{}` per model and would wipe
  this; `config_guard` goes red when the order is gone. `model-pricing.js`
  prices flash at the pinned provider's rates — new rows only, the ledger is
  append-only.
- **The `Conversation info` block is prompt-only: the transcript keeps the
  bare text.** On 2026.8.1 the roster, the tag and the message id of a group
  message exist in one place code can reach — the `llm_input` plugin hook,
  which hands over the model's input verbatim (`gateway-plugin/olma-turn`
  → brokerd `group_context` → `group_inbound_context`). Group mode was
  designed to read them off the store, went live, and registered nothing
  (`incidents.md`, "The roster was never in the transcript"). A store
  that our own probes wrote into is not evidence of what the gateway writes.
- **Never poll `openclaw sessions list` on a timer** — 2.9s of CPU per call,
  measured when the box had one core and still most of a core now that it has
  two. It directly slows every user's reply.
- **The gateway heartbeat stays OFF: `agents.defaults.heartbeat.every: "0m"`.**
  `target: "none"` only suppresses delivery; the 30-minute NO_REPLY turn
  still runs for every agent, and it was 82% of the model bill (2026-09-05,
  `incidents.md`, "The heartbeat was the bill"). Nothing of ours rides on it.
  `config_guard` goes red if it comes back; `scripts/disable-heartbeats.js
  --apply` turns it off again.
- **Every session resets daily: `session.reset: { mode: "daily", atHour: 2 }`**
  (UTC on the box — 05:00 in Israel, before anybody writes). The gateway
  default is "none", and a session that never ends carries the whole
  conversation into every call: on 2026-09-09 u-3's one session, open since
  08-27, was 205k tokens a call — $0.018 of history per message before the
  first word, 8–23 s to the first token, 52% of the real-user bill across
  four people (`incidents.md`, "The conversation that never ended"). What
  the conversation knows lives in the DB and USER.md, not in the window.
  **`readRecentMessages` follows `session_windows.previous_session_id`** so
  the watchers (promise_watch, the onboarding review, fact extraction,
  unanswered) still see yesterday on the morning after — a reader of the
  live session id alone is blind once a day. `config_guard` goes red if the
  mode comes back off; `scripts/set-session-reset.js --apply` sets it.

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
- **The raw pipe goes over the gateway's own WebSocket now, with the CLI
  behind it** (`channels/gateway-rpc.js`, `channels/openclaw.sendRawMessage`).
  A fresh `openclaw` process cost 8.8-12.7s idle and 49-95s while a room was
  busy, against 120-190ms to connect and 5-35ms per call on an open socket —
  the cost was never the send, it was a cold Node process loading the CLI.
  **The fallback is narrow on purpose, and widening it is how a room gets told
  the same thing twice**: a request that never reached the gateway retries on
  the CLI, a request the gateway ANSWERED with an error stays failed (the CLI
  reaches the same handler), and a request written to the wire that then timed
  out is `timedOut` and is retried NOWHERE — the gateway hands the message to
  WhatsApp before it answers. `idempotencyKey` is required by the send schema
  and is fresh per attempt, exactly as a new CLI process was. The module
  refuses outright inside `node --test`: `deploy.sh --restart` runs the suite
  on the box, where `127.0.0.1:18789` serves real people and, unlike the
  config path, a socket has no temp-directory equivalent.
  `OLMA_GATEWAY_RPC_SEND=off` in `/opt/olma2/.env` puts everything back.
- **Cancelling a queued message is an UPDATE, never a DELETE.** The row carries
  the `idempotency_key` that stops the sweep re-creating it.
- **A STYLE is chosen at delivery, off the recipient's channel, and a channel
  the table has never heard of gets PLAIN** (`domain/message-format.js`, the
  whole reference is `olma2/docs/whatsapp-formatting.md`). WhatsApp renders
  eight things and nothing else — bold, italic, strikethrough, monospace,
  inline code, block quote, bulleted and numbered lists; no underline, no
  headings, no `[label](url)`, all three of which arrive as literal
  characters. `user_channels.channel_type` has only ever held `whatsapp`,
  which is what has made "WhatsApp markup" and "our markup" look like one
  thing. Same rule and same reason as `localizedKey` for the LANGUAGE of a
  rung: what a person can read is a fact about them at the moment of sending,
  never about the row. **There is no escape character**, so a value we did not
  write — a task title is the person's own words — is left unwrapped when it
  already carries the marker: emphasis lost, sentence correct, which is the
  right way round. The module BUILDS markup and does not parse it, so
  owner-typed markup in `message_templates` would reach a second channel raw;
  that gap is named in the doc rather than closed by a parser nothing can
  check.
- **The delivery gate is the chokepoint and a paused user has no exceptions** —
  not reminders, not urgent, not another user's fan-out.
- **Quiet HOURS and a quiet DAY draw different lines, and the digest is where
  they differ.** Hours exempt a digest and rung 1 of any reminder — they chose
  those moments. A day in `quiet_days` (preference, `"fri,sat"`, read by
  `preferences.quietDays`) exempts only `askedForInWords` — rung 1 of a
  reminder a PERSON put there in words — so a digest, an automatic reminder off
  a due date, and an introduction all wait. Held and never dropped, released
  into the next day they KEPT (Friday+Saturday releases on Sunday, inside their
  window), judged in THEIR zone: 23:00 UTC Friday is already Saturday in
  Jerusalem. Seven quiet days is refused at the parse, because that is `pause`,
  which is reversible and reports on itself. The introduction's exemption from
  the stopped-answering rule does NOT transfer here — that branch drops, this
  one holds, and nothing is lost by waiting.
- **`DEFAULT_WINDOW` (09:00-21:00) is no longer only a fallback — it is a
  sentence somebody read.** The discovery ladder's timezone rung states the
  hours in the same message that asks which country they are in, so moving the
  constant without moving that copy makes the first message we ever sent them a
  lie. The test asserts the copy against the constant for exactly that reason.
- **That rung asks for the COUNTRY, not the city** (owner, 2026-09-08): a zone
  moves when you cross a border. The six where that is false — US, Canada,
  Russia, Australia, Brazil, Mexico — are named in the instruction and get a
  follow-up about the area, and dropping that re-opens the fault the rung was
  built around (Sarah's +1 bought her New York while she was in Los Angeles).
- **Only the PERSON writing releases a night-held row.** `openRecord` takes
  `{ wake }`: the gateway opener, which has a real `message:preprocessed`
  behind it, passes `true`; `openTurnImplicitly` — the fallback for a model
  that skipped `turn_start` — passes `false`. Unconditional, it woke Sarah at
  01:26 for a gateway heartbeat poll (`incidents.md`, "Good morning at half
  past one"). A turn happening is not evidence that anyone is awake.
- **Only rung 1 of a reminder is a moment THEY chose; every rung after it is
  one OLMA chose, and quiet hours apply to it.** The gate exempted `kind ===
  'reminder'` wholesale, so Vered was asked "בוצע?" at 01:33 about a reminder
  she had set for 22:32 (`incidents.md`, "The rung nobody asked for, at half
  past one"). `sweepReminders` already drew this line for the daily budget and
  the night window never got the same sentence. The rung rides the payload as
  its own field, not as `attempt`: `attempt` drives the WORDING and a redo
  deliberately uses rung 1's text while still being Olma's moment.
- **A reminder rung the GATE held is never chased; a rung OUR pipe lost is
  redone at once.** The discriminator is on the expired outbox row: the gate
  leaves `attempts = 0` and no `last_error`, a dead pipe leaves both. The
  redo goes out under the next rung's key with the plain wording, keeps the
  urgency of the rung it replaces, and still spends a rung so a broken pipe
  cannot loop (`incidents.md`, "The reminder that could not climb").
- **Nothing Olma DECIDED to say goes out in front of an introduction she still
  owes.** An `introduction` outbox row is her saying who she is to somebody who
  never heard it — the intake greeter's job normally, a queued repair when the
  greeter missed. While one is unsent the gate holds every other row as
  `awaiting_introduction` (held, never dropped) and exempts it from the daily
  budget, because everything else is waiting behind it and a budget hold there
  is a deadlock. A moment THEY chose still passes — a digest, rung 1 of a
  reminder they asked for in words — on the same line the gate draws
  everywhere else, and it survives the quiet drop too: somebody who has not
  answered is the likeliest person never to have been told who was writing to
  them. **It also keeps the floor for ten minutes AFTER it lands**
  (`INTRODUCTION_ROOM_MS`), counted from the introduction's own `sent_at` and
  never from when the waiting row was last looked at — released on a plain
  "while one is pending" clock, the next row went out on its heels and was read
  as part of it (ג.ב, 08:00:27 and 08:01:19). The worker reads that landing with
  `hold_reason IS NULL`: a cancelled or superseded introduction carries
  `sent_at` too and reached nobody. Bounded to two days in the worker: a repair that never
  went out must not silence somebody for ever. What decided this before was
  `ORDER BY created_at`, which is an accident: ג.ב's introduction and a
  day-one calendar offer were both due at 08:00, from an assistant that had
  not yet said what she was (2026-09-08).
- **Reminders that come due in the same tick go out as ONE message, and the
  coalescing happens at DELIVERY, never at enqueue.** A batch enqueued under
  one idempotency key would let cancelling a single reminder re-create the
  group. In the worker there is no new row: siblings are locked in the same
  transaction, re-`decide()`d (expiry is per row), grouped by rung template (a
  batch may only make the promise every line in it makes — hence three list
  templates), and a failed send fails for all of them and skips them for the
  rest of the tick. Vered got nine messages in ninety seconds
  (`incidents.md`, "Nine reminders, nine messages").
- **A `--deliver` that TIMES OUT has very likely gone out, and is never
  retried.** The CLI hands the turn to the gateway and waits for the model;
  the kill at `SEND_TIMEOUT_MS` ends the waiting, never the turn. The worker
  books a `timedOut` result as sent (`last_error` keeps the timeout, audit
  `delivery.unconfirmed`) — retried as a failure, each retry was a new turn
  and a new message, and Dana got her day-one check-in six times in seventeen
  minutes (`incidents.md`, "Six good mornings for one timeout").
- **Anything else due in the same moment is ONE message too, and two rules say
  what may travel together** (`domain/message-merge.js`). A REMINDER is never
  folded into a composed turn: every rung rides the raw pipe with the owner's
  wording and no model, and handing the one sentence a person asked for to a
  model that may reword or drop it would leave the row stamped delivered all
  the same. And a merged message carries **at most one ASK** — two questions
  get one answer and nothing can tell which was answered — with the statements
  first and the question last. A row carrying its own hand-written
  `instruction` is never composed with (that is what keeps an introduction
  saying exactly what it says), and a kind absent from `MERGEABLE` goes alone,
  so one added next month is safe until somebody reads it. Same place and same
  reason as the reminder batch: at DELIVERY, no new row, no new key, every
  sibling re-`decide()`d because expiry and the holds are per row.
  **The daily budget counts `DISTINCT sent_at`, not rows** — one `UPDATE`
  stamps a whole batch with one timestamp, and the budget limits how often
  Olma interrupts somebody, which is messages. Counting rows charged a merged
  message twice and made merging cost more than sending the same things apart;
  it is also what made the first measurement of this problem read one message
  as five (`incidents.md`, "Fifty-two seconds behind the introduction").

### Data you must not get wrong

- **`users.timezone` must never be NULL** — NULL falls back to UTC in both the
  delivery gate and the digest sweep, running an Israeli user's quiet hours
  three hours off.
- **Every time crossing a tool boundary needs an explicit offset.** A bare
  local time is read as UTC. A phone number's country is not a location, and a
  well-formed-but-wrong time still needs a semantic cross-check.
- **"What is still pending" must ask `attempts = 0`**, not `sent_at IS NULL` —
  since the escalation ladder, a delivered row sits with `sent_at` NULL for up
  to two days with `remind_at` receding into the past. The rule was written the
  day the ladder shipped and four readers still had it wrong a day later,
  `list_my_reminders` worst of all: it filtered on `cancelled_at` alone, so it
  had been returning RETIRED reminders as things still to come since long
  before the ladder — 105 rows on the box, 13 of them pending. **The test that
  should have caught it asserted on replicas of those queries that it had
  written itself** (`incidents.md`, "A hundred and five pending reminders").
  Eight other `sent_at IS NULL` readers are RIGHT: completing, pausing,
  replacing and not-stacking all ask "what would still fire", which a
  mid-ladder row would.
- **…and "what is still going to REACH them" is a THIRD question, which
  `attempts = 0` answers wrongly.** A mid-ladder reminder has two messages
  left to send and was invisible in all four readers, so the row Olma was
  asked to stop was the one row nothing could name: she cancelled the two she
  could see, on other tasks, and the ladder climbed on ("תפסיק עם התזכורות
  … הבאה רק ביום שני", 2026-09-09; `incidents.md`, "The reminder that would
  not stop"). The two answers travel APART and never merge — `list_my_
  reminders` returns `chasing` beside `reminders`, and only `reminders` is an
  hour anyone may say out loud. The fast path is `turn_start`'s
  `recentReminders`, which already fires on the turn that answers a reminder
  and now carries `reminderId`/`taskId`/`stillChasing`; the id is not in the
  outbox payload, it is in the `idempotency_key`. **And cancelling withdraws
  the queued rung** (`hold_reason = 'cancelled'`) — the ladder dies on the
  reminder row while a rung the gate is holding for the night stays
  deliverable, which makes "ביטלתי" a lie for hours.
- **The turn opens itself, from the gateway's own hook, before the model's
  first call.** `gateway-hooks/olma-turn-open` (synced by `deploy.sh` to
  `/root/.openclaw/hooks/`, enabled by `hooks.internal.entries`, loaded at
  gateway STARTUP) sends brokerd `turn_open` on every accepted inbound
  message — on the `message:preprocessed` event: **on OpenClaw 2026.8.1 a
  WhatsApp DM never fires `message:received`**, and the hook sat loaded and
  silent for a night listening to it. A hook that loads is not a hook that
  runs; prove it with a line it wrote on a real message. **Its deadline runs
  from CONNECT, not from start** — the gateway's own pre-model bookkeeping
  blocks its loop for seconds on a heavy user, a timer that fires late runs
  before the queued connect callback, and one clock from the start killed
  eleven opens that had never reached brokerd while brokerd was blamed for a
  day (`incidents.md`, "The hook's timer fired late"). `ms` minus `connectMs`
  on the trace line is the gateway's stall; the rest is brokerd's.
  brokerd counts the message, wakes the person, puts the 👀 on, and
  holds the open for the shim connection to adopt on its first tool call —
  nothing counted twice, every mark on the real message id (`incidents.md`,
  "The reply's first six seconds were bookkeeping"). `turn_start` still works
  and is now a no-op on the record when the gateway got there first.
  **Phase B (2026-09-06, per-person):** for the phones in the
  `turn_context_phones` flag, what `turn_start` would RETURN is prepended to
  the prompt by the gateway plugin `gateway-plugin/olma-turn`
  (`before_prompt_build` → brokerd `turn_context`, link-installed from
  `/opt/olma2`, `plugins.entries.olma-turn` with
  `hooks.allowConversationAccess: true`, agent list in its `config.agents`),
  and their AGENTS.md is the `{{#turn:context}}` variant of the template
  (`renderAgentsMd(token, {turnContext})`; the resync script picks per
  person). The plugin fails open and the variant doctrine falls back to
  calling `turn_start` when no `Turn context` block is there, so a dead
  plugin costs a tool call, never a count. Trace:
  `/opt/olma2/run/turn-context-plugin.log`. Turning it on for someone means
  ALL THREE: the flag, the plugin's agent list, and a resync of their
  AGENTS.md — the flag alone changes only what brokerd answers.
  **The prompt that `before_prompt_build` sees is the bare text.** The
  Conversation info block (`reply_to_id`) and the reply-target block are
  attached AFTER that hook, so the plugin cannot see a reply; the turn-open
  hook can (the WhatsApp quote marker is in the event body) and sends
  `replyToId` with `turn_open`. brokerd keeps one pending open PER MESSAGE
  (a queue per person, oldest first), not one per person: two messages a few
  seconds apart each keep their own count, opening and reply target
  (`incidents.md`, "Two messages three seconds apart").
  **Widened to everybody on 2026-09-09** (`scripts/enable-turn-context.js
  --apply`, then a gateway restart and a resync) — it was four steps, and the
  first one was not optional:
  (1) the evals. The eval user (`users.is_eval`, u-15) becomes a covered user
  the moment the flag says `all`, and the failure is SILENT rather than red:
  the CLI fires the plugin but not the turn-open hook, so brokerd answers
  `context: null`, the doctrine falls back to `turn_start`, and the suite
  goes on measuring the fallback path while every real user is on the context
  one (plus a `turn.context_without_open` audit row per turn). Fixed: the
  harness opens each turn through brokerd itself (`openTurnForEval`), and the
  opening check follows the flag — `turnStartFirst` while uncovered,
  `turnStartNotSpent` once covered (`scenarios.turnOpening`).
  (2) flag `turn_context_phones` = `all`. (3) EMPTY the plugin's
  `config.agents` rather than listing everyone — empty means every `u-N`
  agent, so a user who joins next week is covered without anyone
  remembering, and the flag stays the only gate. (4) restart the gateway
  (`config.agents` is read once, at register) and resync every AGENTS.md.
  **Every half-state is the OLD behaviour, not a broken one** — the doctrine
  falls back to `turn_start` when no Turn context block is there — which is
  why `config_guard.checkTurnContextCoverage` goes red when the flag and
  the plugin list disagree: a fallback nobody notices is a model round-trip
  on every message for ever. It was 922 of 2,482 tool calls in the fourteen
  days before (`incidents.md`, "The conversation that never ended").
- **`messages.queue.mode` stays `followup`.** The gateway default, `steer`,
  pushes a message that arrives mid-turn INTO the running turn and cancels
  the tool calls the model just made ("Skipped due to queued user message").
  `followup` gives it a turn of its own. `config_guard` goes red otherwise;
  `scripts/set-queue-mode.js --apply` sets it.
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
  **The morning digest obeys the same rule and had to be told so separately**:
  `sweepDigests` puts `mayAsk` on the payload — false when nothing was
  received since the last digest that really went out (`sent_at` set,
  `hold_reason` null, so a cancelled row is not counted as silence) — and
  `channels/openclaw.js` swaps in an ending with no question mark anywhere.
  A backoff, not a mute: one message from them re-opens it. It asked Sarah the
  same question on four mornings first (`incidents.md`, "The morning digest
  asked the same question four mornings running").
- **A day-one step that has not gone out is REPLACED by the NEXT CHECK-IN of
  any kind, never joined by it.** `checkin.run` withdraws the person's still-unsent
  `onboarding:*` rows (`hold_reason = 'superseded'`) when it enqueues the
  next check-in; the expiry numbers alone never did this and two steps went
  out at 08:00 to two people (`incidents.md`, "Two good mornings at once").
  Keyed on `onboarding:%` it covered step-replaces-step and nothing else, so a
  day-one step that DECLINED and fell through to an ordinary rung put the two
  side by side again — which is what the closed Google door produced the same
  night. The ladder has ONE live rung at a time.
- **Somebody who has stopped answering hears nothing Olma decided to say, and
  nothing on their record is cancelled.** The check-in ladder's one miss
  (`checkin_misses >= 1`) is the signal and the delivery gate is where it
  acts: every row is dropped as `hold_reason = 'quiet'` — reminder rungs,
  digests, another user's fan-out — except the ladder's own check-in (the
  three-day and the weekly "מה איתך") and rung 1 of a reminder they asked for
  IN WORDS (`payload.auto === false`, which `sweepReminders` puts on every
  rung). The reminder and the task stay exactly as they were: the owner's
  rule is "stop it arriving, cancel nothing", and a rung the gate dropped is
  never chased. `pickRung` puts the quiet one-liner ABOVE overload and a
  stalled goal (Olma's opinions) and BELOW a stuck meeting and a deadline
  (theirs). **The third miss is a pause, not a silence** — `pause.quietPause`
  sets `paused_at` with `paused_reason = 'quiet_ladder'` (migration 049) and
  takes nothing down, and `openRecord({ wake: true })` ends it on the first
  message they send; a pause THEY asked for (`paused_reason` NULL) is ended
  only by them or by the admin. **A "like" never reaches us** — on OpenClaw
  2026.8.1 there is no reaction event, so the only sign of interest we have
  is a message; a person who only likes looks silent. Vered got eighteen
  messages on her second day and answered none (`incidents.md`, "Eighteen
  messages, no answer").
- **Moving a task's date answers every rung that was chasing the old one.**
  `snoozeTask` → `reminders.retireForMovedTask`: a one-off reminder already
  climbing (`attempts >= 1`) is RETIRED (`sent_at`, never cancelled — they
  answered it by moving the thing), every queued outbox rung of every one-off
  reminder on the task is withdrawn as `hold_reason = 'moved'` — including one
  whose ladder had already ended, which has nothing left to retire and a final
  message still held for the night — a pending AUTOMATIC reminder for the old date is
  cancelled and re-armed for the new one (an explicit reminder on the task
  blocks the re-arm, as on `add_task`), a repeating one is left alone. It
  did neither for a day: Vered moved five tasks to 09:00 and the ladders of
  their old date still had "זו התזכורת האחרונה" ×7 due at 08:00 (same entry).
- **A task chases through ONE ladder — the one behind the LATEST reminder
  they asked for.** Two explicit reminders on one task are two moments THEY
  chose, and both first rungs go out; but each used to climb on its own, so
  Maya, who asked for 16:00 and 16:15 for one call, got "בוצע?" twice that
  evening and "זו התזכורת האחרונה" twice the next afternoon. When rung 1 of a
  one-off reminder goes out, `sweepReminders` → `reminders.retireSiblingLadders`
  RETIRES every other one-off reminder on the task already climbing (`sent_at`,
  never cancelled) and withdraws their queued follow-up rungs as `hold_reason
  = 'superseded'`; a sibling's rung 1 is never touched. Same-moment siblings
  are ordered by id so the later one does the retiring (`incidents.md`, "Two
  ladders for one phone call").
- **A "once ever" question is stamped on the PERSON, never deduped on the
  route that asks it.** Two routes each honouring "at most once" is twice.
  The city is `users.timezone_asked_at` (migration 045), written by whichever
  route asks and read by both (`incidents.md`, "The city was asked four
  times"). And the first message **states** the zone guessed from the dialling
  code rather than asking for it, spending its one question on the name on
  file — `firstContactInstruction`, built per person.
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
- **Deleting a user is not deleting a person until the GATEWAY's intake
  session goes too.** `deprovisionUser` removes everything olma2 owns — row,
  agent, binding, workspace — and `sweepIntakeSessions` rebuilds them from the
  gateway's session store, which it reads with no age bound: any peer that ever
  reached the greeter and has no active user row is provisioned on the next
  five-minute tick. A deleted account silently undid itself inside five
  minutes, looking exactly like someone coming back on their own.
  `forgetIntakeSession` (default true) is now the difference between deleting
  an account and resetting one; the testbed rehearsal opts out because its
  transaction is rolled back and a ROLLBACK cannot restore a deleted session
  (`incidents.md`, "The user who would not stay deleted").
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
- **An explicit reminder replaces the automatic one only on the SAME local
  day; on another day it stands beside it.** Both are otherwise about catching
  one thing at its due date, and two messages for that is the bug the
  supersede exists to stop — but Vered asked for one "בעוד דקה" (the word was
  נוספת) and lost the 08:00 she had for the next morning. **A past `remind_at`
  is refused at the TOOL boundary** (`adapters/mcp/tools/reminders.js`, on
  `reminders.momentIsPast`), never inside `setReminder`: our own sweeps,
  repairs and most of the suite arm past moments on purpose, and only a model
  asking for one is a mistake. Refused before the write, so a moment we will
  not honour cannot withdraw one we would have.
- **An event is SAID, never only guessed, and it is never told back as a
  task.** `tasks.kind` ('event' | 'todo', migration 036) was decided by the
  words in the title and read by exactly one thing, the archive sweep — so
  ג.ב asked to put a meeting in, the row came out right, and he read "הנה,
  רשמתי" plus a reminder he had not asked for (`incidents.md`, "הנה, רשמתי,
  about a meeting"). Now `add_task`/`add_tasks_bulk`/`edit_task` take `kind`
  (the model has the conversation; `task-kind.decideKind` falls back to the
  words only when nothing was said, and an unknown word is "not said"), an
  event has a `location` (migration 052, out of the title, out to Google
  with the event), and every reader separates the two: `taskHints.event`
  says what to call it, `list_my_tasks` carries `hints.kinds`, the digest
  returns `events` beside `tasks` and counts them apart, the personal
  dashboard lists "ביומן" before "לעשות" inside a day. A reminder still
  hangs on a task — "להוציא את העוגה בעוד 20 דקות" is still a to-do with a
  reminder, by choice, for now.
- **A task already OPEN on somebody's list is never saved a second time.**
  Four writers — the live `add_task`, a brain dump, a breakdown's subtasks and
  the nightly extraction pass — each relied on the model not repeating itself,
  and the box held 21 pairs of open tasks sharing a title across three of
  twenty users. Sixteen came from `jobs/fact-extraction.js`, which reads a
  conversation 7–83 minutes after the live tool already captured the same
  sentence out of it; 37% of every task that job has written is a duplicate.
  The dedupe was a line in the prompt with the open list handed over
  underneath, and Maya had 13 open tasks against a cap of 40 — the row was in
  front of the model. The guard is in `domain/tasks.js` (`normaliseTitle`,
  `openTitles`): same owner, same title after case and inner spacing, **still
  open and unarchived** — never a time window (all 21 firsts were open; a
  window would have to guess at ביטוח נסיעות, ticked off in the morning and set
  again that evening) and never also the due date (11 of 21 duplicates carry a
  different one, nearly always none). It **refuses** rather than returning the
  existing row, because `TOOL_MARKS` puts 👍 on the message for any `add_task`
  that returns ok and a failed call earns no mark — an ok would thumbs-up a
  task that was never saved. `add_tasks_bulk` skips duplicates, grows its map
  as it goes so a dump repeating itself is caught too, reports them in
  `duplicatesSkipped`, and refuses outright when nothing was left to save.
  A test that gives one person two open tasks with the same title now fails;
  twenty-three did (`incidents.md`, "The same thing, saved twice").
- **A model asked to date something must first be told what time it is.** Every
  one of the 27 `extracted` tasks on the box had a NULL `due_at` and three
  carried the hour inside the title as words — "לאכול צהריים ב12", "לעזור לשרה
  במעבר דירה ביום רביעי בשעה 17:00" — so the moment was said out loud and no
  reminder could ever fire for it. Not a bad prompt: `renderTranscript` threw
  away every `m.at`, the instruction stated neither "now" nor the person's
  zone, and the schema had no date field at all, so "מחר בשעה 18:00" was not
  resolvable and "never invent a date" was the only safe rule available. Each
  line now carries the wall clock it was WRITTEN at, in their zone (off the
  stored message, never off the sweep's own clock — the gap between the two is
  the point), and the prompt states the same clock for now. **A line with no
  timestamp renders bare rather than borrowing `now()`** — a voice call arrives
  with no per-message clock at all, and a made-up stamp would hide that.
  What comes back is validated hard and, on anything doubtful, **the DATE is
  dropped and the TASK is kept** (`usableDue`, counted as `datesDropped`),
  exactly as the facts half has always handled `expires_at`: the commitment is
  what they said, the moment is what the model resolved, and only one of those
  two is theirs. Four refusals — unparseable, no explicit offset (`hasOffset`;
  refused here rather than at `addTask`, which would lose the task as well),
  already past, or past a one-year horizon, which is the shape a wrong YEAR
  takes (`incidents.md`, "A time in the title and no reminder").
- **A title need not restate the hour the row now carries, but only the SERVER
  may take it out.** The same model, given a clock, sets `due_at` AND leaves the
  words in the title — new behaviour, because before the field existed the words
  were the only copy. `titleWithoutStatedTime` removes a TRAILING time
  expression, and only when the hour it names is the hour being stored. **The
  cross-check is the design**: measured against all 253 titles on the box it
  matched 8, stripped 2, and refused "Brunch with a friend — Tuesday Sep 1 at
  10:00", whose `due_at` is 07:00 — the two disagree, and stripping would have
  deleted the only record of it. Deliberately NOT a prompt line: the model
  cannot know whether `usableDue` will accept its date, so a clean title written
  up front loses the moment entirely on every date the server drops.
- **A day named with ל־ in a title dates the THING, not the task.** "לארגן
  אימון לרביעי" is arranged BEFORE Wednesday; filed ON Wednesday it is useless.
  `datetime.datesTheObject` reports that shape on the result and lets the model
  resolve it — it has the conversation, the function has a string.
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

- **A DECISION to stay quiet is not a reply that got lost.** `NO_REPLY` is the
  silence sentinel and, since the reaction doctrine, it is the CORRECT answer to
  a growing class of messages — brokerd puts a 👍 on, `markPlaced` says the mark
  carries the whole fact, the model rightly says nothing. Every one of those
  lands in the transcript as an assistant turn after a user turn with no send
  event behind it, which was `unanswered.undeliveredReply`'s entire definition
  of a lost reply. Yahav's "בוצע הפקדת צק" was answered perfectly — task
  completed, 👍 placed — and three minutes later a repair turn told him "No
  conversation history is accessible to me in this session", in English
  (2026-09-09). **The sentinel is checked in the DETECTOR, not in the shared
  reader**: a deliberate silence is real history, and the admin conversation
  view and the metrics rollup each decide what it means to them. Exact match
  after a trim — the doctrine says anything in FRONT of the sentinel is
  delivered, so "בוצע NO_REPLY" is a real reply and stays repairable. Second
  time the transcript's shape has failed to carry a turn's meaning for this same
  function: `channels/sessions.js` drops `FAILED_TURN_MARKER` because a dead
  turn was indistinguishable from a reply and blinded it the OTHER way
  (`incidents.md`, "A silence read as a delivery fault").
- **A repair job fires precisely when the system's belief about itself is
  already wrong, so it must be the most sceptical thing in the codebase.** Every
  other sweep acts on a state it observed; this one acts on a belief that
  something failed, and a wrong belief manufactures the very disturbance it
  exists to prevent. And **its instruction anticipating a failure buys nothing**
  — the repair prompt said "if you CANNOT see the conversation, reply with
  exactly NO_REPLY, do not mention a technical problem" and the model did the
  opposite, in the wrong language. A safety property written as a sentence in a
  prompt is a request, not a guarantee: wherever a model's raw output reaches a
  person with no server-side gate, the prompt is the only thing standing there
  and it can simply be ignored.

### Writing detectors and alarms

- **`BREAKS_USERS` means exactly "their tool calls fail right now."** Anything
  else is a dashboard row. Widening it makes the alert list mean two things,
  which is how an alert list dies.
- **A hint that fires on ordinary input is worse than no hint** — it costs
  tokens on every turn it does not apply to and teaches the model to skim past
  hints, including the ones that matter. Measure a new pattern against real
  data before shipping it, and keep the readings you REJECTED in the test with
  the real rows that killed them (`tasks.joinsTwoAsks`, checked against all
  202 production titles; `incidents.md`, "Two asks, one task").
- **Her voice is checked by code, not by the judge.** `domain/hebrew-quality.
  flawsIn` is the one list of what a slip is — a masculine self-reference
  ("אני מבין", "מצטער, יובל"), the model's own markup or a token in a
  sentence — read by the eval check `scenarios.herOwnVoice` (red on every
  scenario) and by the daily count on the dashboard. Measured on 383 real
  messages before shipping: 10 hits, 10 real. Extend the list there and
  re-measure; `רואה` is what a false positive looks like (same in both
  genders), and the forms that do not change are left out on purpose.
- **An issue title must be deterministic** — it is the dedup key. A title built
  from unordered query results makes the guard file and close the same
  condition on alternating ticks.
- **A ratio's numerator and its denominator must describe the SAME people, and
  the eval user is in neither.** `users.is_eval` traffic is a benchmark whose
  cost per message is a property of whatever model is on trial, so it enters
  and leaves every metric TOGETHER — dropping it from one side alone builds the
  mirror-image fault. `efficiency-watch` had it in both halves and read
  2026-09-08 as $0.0411/message against a $0.0155 baseline, when real users
  were 52 messages at $0.0179 — 1.13x their own baseline — and the advice that
  came back was to trim the conversation history real users get, to pay for a
  pilot. **Its EVIDENCE query has to move with it**: a model list drawn from a
  population no ratio covers is what ranked deepseek-v4-flash third and got it
  blamed. And the excluded spend still has to be printed somewhere unratio'd
  (`evalCost`), or the fix is the other failure — $4 a day that no number can
  see (`incidents.md`, "The pilot that read as an expensive day"). Nothing else
  on the cost path filters `is_eval`, and for the dashboard's cost pages that
  is arguably right: they answer "what did we spend", not "how efficient are
  we". Know which question the number you are writing answers.
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
- **Every check that starts from `users` is blind to the person the gateway
  dropped**, because they never became a row.
  `config_guard.checkUnansweredStrangers` starts from the gateway's ingress
  queue instead (`sessions.listInboundPeers`) and reports a lane with neither
  a session nor a user row after 30 minutes. **The discriminator is the
  SESSION** — a stranger the intake greeter answered has one and no user row
  by design, and counting them would make the check red whenever registration
  is closed. Dashboard row; no upper window (it closes when they get a user
  row, not when we get bored). **The ingress queue is not a message log** —
  Olma's own replies are queued on the same lane and a completed row keeps
  nothing that tells them apart, so it answers "has this lane ever been heard
  from" and nothing quantitative (`incidents.md`, "A message reached the box
  and stopped there").
- **`liveness_watch` repairs before it reports.** Every five minutes: gateway
  probe and delivery queue; two bad ticks before a word; a gateway down for
  two ticks is restarted (`intake/gateway-restart.js`, once per half hour) and
  probed again; the news goes over WhatsApp — healed, stuck deliveries, or
  recovered — and a message that could not go out is `alertFailed` on the
  heartbeat. State in the `liveness_state` flag so a restart mid-outage does
  not re-alert. It speaks over the gateway's own pipe (owner's choice, no
  SMS), so a gateway that stays dead is repaired from here but reported only
  by the external monitor.
- **A new person's first hours are read back by code TWICE — three hours in,
  and again after their first day** (`jobs/onboarding-review.js`, `STAGES`; the
  checks are pure, in `domain/onboarding-review.js`). It never messages them —
  it files one row per person per stage, clean ones included, because a review
  that only appears when something is wrong cannot tell you the rate. A `bad`
  verdict means somebody was told something untrue or got no answer: a
  dashboard row and an alerts pill until acknowledged, never `BREAKS_USERS`.
  **Both stages start at their first message and only the END moves** — several
  checks hold something said late against a reminder armed early — so the day
  read sees everything the early one saw and files only what is NEW. There are
  two stages because four checks written from Yahav's second day fire at 3.7 to
  13 hours in and, at three hours, not one of them could ever have fired.
  **Adding a check means adding its failing case to
  `tests/onboarding-review.test.js`** — the founding case is Yahav's real
  evening, replayed end to end, and a check whose failure cannot be written
  down is one nobody will trust in six weeks.
- **The onboarding review only ever watches the FRONT DOOR; `promise_watch`
  watches everyone.** A new person's first hours are read back twice (above);
  every ACTIVE person is asked once a day whether the moment they named is the
  moment that got armed (`jobs/promise-watch.js`, the pure half in
  `domain/reminder-promise.js`). Miron hit the promised-hour fault weeks into
  his life here and nothing saw it for six hours. **It reads THEIR message, not
  Olma's** — "the meeting is at 19:00, I'll remind you" is ambiguous prose no
  regex should judge, "תזכיר לי ב-19:00" has one correct outcome — and it
  judges only when BOTH halves are visible: a moment they named, and a reminder
  armed within five minutes in response. Nothing armed at all is three
  different stories and is never reported. It files an `issues` row keyed on a
  deterministic title carrying the message timestamp, so re-reading the
  overlapping window cannot file twice.
- **The suite runs again on a schedule, at four hours of the day**
  (`.github/workflows/olma2-clock-drift.yml`) — no deploy job, its own
  concurrency group so it can never displace a merge's queued deploy. A red
  there means a test means something different at that hour: broken, not
  flaky, and never to be re-run until green. **Do not replace this with a
  clock-shifting preload or a scan for near-today date literals** — both were
  built and thrown away on 2026-09-06, because the first invents a JS/Postgres
  skew production never has (29 false failures) and the second flags the very
  pattern the rule recommends (180 literals, most of them correct).
- **`/health` sees the DB, every `job_heartbeats` row, and the gateway — and
  nothing else.** A component that writes no heartbeat is invisible to it, and
  says so by staying green. That is how the gateway went unwatched for months
  while sixteen sweeps beside it were checked every minute.

### Two hostnames: allma.world is public, duckdns is admin

- **`allma.world` serves an ALLOWLIST, not the admin dashboard.** Caddy passes
  a named set of routes to `:8788` — `/pick/<48 hex>`, `/d/<64 hex>`, `/me`,
  `/me/data`, `/me/events`, `/me/act`, `/me/out`, `/oauth/google/callback`,
  `/health`, `/ready`, and the three stranger-readable pages `/`, `/privacy`
  and `/terms` — plus `/voice-bridge*` to `:8791`. Everything else 404s
  in Caddy and never reaches the app. **Read the Caddyfile for the current
  set** rather than this line: it said "exactly four" for a day and was wrong
  the moment the personal dashboard shipped. What does not change is the
  invariant — the list is exactly the routes the app serves ahead of its Basic
  Auth check, and **adding a public route to the app does not make it reachable
  — the Caddyfile has to say so too.** That cost the user dashboard its launch:
  the code deployed green, `/me` answered on `127.0.0.1:8788`, and every link
  sent to a person 404'd in Caddy (2026-09-04) — and it cost `/terms` the same
  way on 2026-09-06: PR #239 deployed green and the page 404'd until the
  Caddyfile learned about it.
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
- **A message that is only thanks is answered by a 🙏 and by nothing else.**
  Sixth reaction state; the hint (`turnHints.thanksOnly`) asks for `NO_REPLY`
  on the same argument as `markPlaced`. **The classification runs in the
  turn-open hook and only the boolean reaches brokerd** — the text still never
  leaves the gateway. Strict on purpose: a miss costs one "בשמחה", a false
  positive means Olma ignores a real request, so an explicit thanks is
  required, a question mark disqualifies, and every other word must be on a
  short filler list. **Needs a gateway restart to take effect** — the hook is
  read at startup, and until then the code is live and inert
  (`incidents.md`, "בשמחה יהב, שיהיה ערב טוב").
- **`markPlaced` is CONDITIONAL, so nothing else on the same result may be an
  unconditional instruction to write.** It lost to one for two days: the tool
  result said "say when you will remind them" beside it, and Miron got
  "הוספתי ✅ … לתזכורת עוד שעתיים" under a live 👍 (2026-09-06). The hint was
  neither missing nor ignored — it was outvoted. **Every hint and every line of
  doctrine about what to SAY must answer the same question `markPlaced` asks:
  is there anything here the mark cannot carry.** For a reminder, the hour Olma
  CHOSE is; the hour they NAMED is not, and the save never is.
- **One in-flight reaction per message.** A mark is a whole `openclaw` CLI
  start-up (15s wall on the box, measured again at 14.5s on two cores), so a
  short turn has the 👀 and the 👍 alive at once and the LAST to finish wins.
  `placeMark` kills an older child still starting up when a newer mark arrives
  for the same message; one that already exited is simply replaced on the phone.
- **The shim's connection outlives the turn, so nothing per-turn may be latched
  to it.** `bin/olma-mcp.js` caches ONE socket for the life of its process and
  that process runs for hours, so the same `turn` object serves every turn it
  handles. Adoption of a gateway open was behind a `!turn.opened` latch that
  clears only on a change of user — never — and the first message the process
  ever saw froze into `turn.messageId`: Miron got an ⏰ on a message from five
  minutes earlier, and once the id aged out nothing was marked at all for six
  hours (`incidents.md`, "The mark that never moved"). `takePending` now runs
  on EVERY call and removes what it takes, which is what keeps a count spent
  once; only the implicit recovery stays latched, because with no opening on
  file nothing can tell one turn from the next on that socket. **A test that
  passes a fresh `newTurn()` per turn is not testing the connection we have.**
- **A model with nothing to relay passes something, not nothing.** `turn_start`
  takes `message_id` from the model, and on turns Olma started — where there is
  no inbound message — it sent `manual` and `auto-3` to WhatsApp, overwriting
  the real id the gateway had put on the turn (`incidents.md`, "The message id
  the model made up"). `cleanMessageId` bounds the SHAPE and an invented id is
  well-formed, so **no regex can settle this** — provenance can: never take it
  on `ourTurn`, never over an id the gateway already supplied.
- **The 👀 on a person's message is the GATEWAY's** (`ackReaction` in
  `openclaw.json`), placed on receipt from its own config, and ours is a second
  one behind it. So a working 👀 is no evidence that `placeMark` works at all —
  read the gateway journal for what it actually SENT, per emoji, before
  concluding the mark path is alive.
- **`placeMark` claims nothing and therefore must SAY something.** It is
  fire-and-forget by design — no exit code may reach the caller, and nothing
  user-visible may depend on a mark landing — but it logs the attempt and logs a
  non-zero exit, because without that "the reaction failed" and "no reaction was
  ever attempted" are the same observation from the box.
- **Olma never offers a capability without asking the thing that owns it.**
  Phone calls live behind the bridge's own allowlist, in another process on
  another deploy workflow; `domain/voice.callAvailable` asks `POST /probe`
  (which rings nothing) and the card states the answer. **Three values, never
  two** — `null` is "could not ask" and prints no line at all. **The probe is
  a PATH and not a flag on `/dial`**: the two ship separately, so a probe can
  reach a bridge that predates it, and a field an old `/dial` ignores would
  ring somebody's phone to render a card. Its 404 is the harmless answer, and
  `voice-bridge/deploy.sh` asserts `/probe` still exists, because
  `null` is silent by design (`incidents.md`, "An offer to call a number the
  bridge has never served").
- **A carryover leak is repaired on a schedule, because nothing can name the
  writer.** Another user's intake text appeared in u-17's card twice in four
  days; the agent turned the second one into a task with a reminder. The
  `carryover_repair` job applies `repairCarryovers` every ten minutes and
  refreshes the cards it touched. `admin.carryover_leak_repaired` is in
  `PERMANENT_PREFIXES` — a self-healing exposure with a prunable audit trail
  is one nobody can ever count (`incidents.md`, "The carryover leak came
  back").
- **An instruction handed to the model may assert what its own columns hold,
  and not one word more.** A sweep sees `users.first_name`; it does not see
  where that name came from, and it has never read the person's message. The
  60-second name rung said "they have not replied" (the state it fires on is
  reached BY their writing) and "most likely from their WhatsApp profile"
  (עידן's came from someone else's Google contacts), so Olma asked him to
  confirm the name he had typed ninety seconds earlier. What the code cannot
  know, it sends the model to READ — the transcript is right there and the
  sweep is not (`incidents.md`, "קוראים לי עידן").
- **Telling the model to call a tool is not telling it what the reader of that
  tool's write actually checks.** The model DID call `set_my_name` for עידן —
  with `confirmed` omitted, so it landed as an observation and the rung, which
  keys on `name_confirmed`, fired anyway. Name the FLAG, not just the tool.
- **A fixture that writes the state by hand cannot notice the state is only
  ever reached the other way.** Ten passing tests described a nudge for
  someone who had gone silent; production only ever fires it at someone who
  wrote once. Hold the founding case open where the state is PRODUCED.
- **The owner's opening copy is said ONCE, by whichever voice reaches the
  person first.** An organic joiner meets the intake greeter, so the greeter
  sends it verbatim and provisioning stamps `users.opening_sent_at`;
  `turn_start` reads that column and, on the same `firstTurn`, tells the model
  the introduction is done instead of handing out `sendVerbatim`. A NULL means
  nobody has greeted them (testbed reset, hand-provisioned) and their own agent
  still opens. **A prompt that DESCRIBES brand copy instead of quoting it is a
  second copy of it** — the greeter was told to "say who you are and name one
  or two things you help with", so it wrote its own version and עידן read two
  introductions ninety seconds apart (`incidents.md`, "Two introductions").
  **`greetedByIntake` is READ off the greeter's actual reply, never assumed
  from the session list.** The sweep ticks every five seconds and the greeter
  answers in twenty to forty, so for one evening it stamped everybody as
  greeted before the greeter had said a word — 32 seconds early for u-29, 19
  for u-28 — and `turn_start` then told both agents the introduction was done.
  Two people met Olma with nobody ever saying what she was. Waiting is also
  what makes the CARRYOVER readable: provisioning 0.36s after the message read
  a store the gateway had not finished writing, so בר's first words reached
  nobody while the greeter told him they had been noted. The wait is bounded —
  past `GREETER_GRACE_MS` a silent greeter provisions anyway, unstamped, and
  their own agent opens (`incidents.md`, "Two people, no introduction").
- **A first message is not a hello, and the newest arrivals prove it.** People
  now reach Olma from a WhatsApp group she already sits in: they are asked when
  they are free and they DM the ANSWER — בר's first ever word to her was "אני
  יכול מחר". The greeter is told to open with the copy and does not, because a
  real question in front of it gets a real answer. Any code that treats the
  first inbound as a greeting to be replaced, deduped or discarded is throwing
  away the only thing the person came to say.
- **`gmail.readonly` is a RESTRICTED scope and everything else Olma asks for
  is merely SENSITIVE — the two words are different verification tracks, and
  one restricted scope prices the whole app onto the paid one** (an annual
  third-party CASA assessment, on top of the free demo-video/privacy-policy
  track calendar and contacts need). Mail is closed for that reason
  (2026-09-07): `tools/email.js` is deleted, `start_google_connection` has no
  `mail` parameter, and `tests/mail.test.js` fails if either returns.
  `domain/mail.js` and its 32 tests are untouched — reopening is one small
  file plus a re-verification. **Never add a scope without checking which list
  it is on**; an unverified app asking for a restricted one is blocked
  outright rather than warned, which is what עידן's "This app is blocked" was.
  **The track follows what the app DECLARES, and the declaration lives in
  three places, only one of them in this repo**: the consent screen's scope
  list (Google Auth Platform, project `692111599145`), `/privacy` and `/terms`
  (`adapters/http/public-pages.js` — the pages the reviewer actually reads),
  and the code that mints the consent URL. Deleting the tools moved only the
  third: the pages went on offering Gmail for a day afterwards, and עידן's own
  request was `calendar: read_only, mail: false` — his block came from the
  app's configuration, never from his URL. `tests/public-pages.test.js` fails
  on any restricted scope named on any public page.
- **Every NEW Google consent link goes through one door, and it is CLOSED**
  (`domain/google-connect-gate.js`, flag `google_connect_phones`: '' = nobody
  but an admin, 'all' = everybody, or an E.164 list). While the app is
  unverified its link lands on Google's "not verified" screen, and the owner's
  rule is that nobody meets that screen (2026-09-08). One flag for calendar
  AND contacts because `start_google_connection` mints ONE link covering both
  — gating only the calendar would send the same person to the same screen
  through the contacts half. It gates MINTING: an existing connection keeps
  syncing, nothing is disconnected, and mail keeps its own separate gate for
  the narrower restricted-scope reason above. **A closed door also silences
  the OFFER** — the day-one 8h step and both `calendar:*` check-in rungs
  decline while it is shut, because an offer the tool then refuses is the
  worst kind: they say yes first. The proactive rungs were never the main
  path anyway — u-30 started a calendar auth two minutes after joining, from
  the conversation, and has no connection to show for it.
- **A display name is not a word to be translated.** It arrives in whatever
  script its owner chose; `Idan T` became "היי אידן!" in the first sentence
  that person ever read, while the right spelling sat in a database the
  greeter cannot see. Use it only when it is already in the language they
  wrote in, exactly as spelled — otherwise greet them with no name.
- **Olma never claims a lookup it did not perform.** No price, no stock level,
  no "מצאתי לך", no link to a RESULT — all of it asserts a fetch that never
  happened. `search_link` is the one exception and only because a link to a
  *search* claims nothing: the model supplies WORDS, `domain/search-link.js`
  builds the URL. A model that writes URLs eventually writes a fabricated one.
- **A `url` in a tool result is delivered by the MODEL or not at all** — no
  outbox row, no template, no follow-up sweep sends it. So every result that
  mints one carries `sendLinkVerbatim` (`domain/action-link.js`), which says
  the characters must be in THIS reply and names the sentence that broke it:
  Olma wrote "שלחתי לך קישור 🫡" with no link under it and עידן answered "איפה
  שלחת לי את הקישור?" (2026-09-07). Same class as claiming a lookup — an
  action asserted that nothing performed. `tests/consent-link-reaches-the-
  person.test.js` scans `src/domain` for a seventh one; `availability.js` is
  exempt by name because `/pick/` is retired.

### In a group

The whole feature is `olma2/docs/group-mode.md`; these are the four rules that
have already had to be argued for.

- **Two identity doors, routed by the token PREFIX** — `users.resolveByToken`
  for a person, `groups.resolveByToken` for a room (`olma_grp_…`). brokerd
  enforces `audience: 'group'`; the MCP shim serves the union and cannot know
  which agent is calling, so a user tool called with a group token is refused
  at the server and nowhere else.
- **Nothing a group tool returns may carry the room's own row or anybody's
  reasons.** `chat_groups` holds `identity_token`, and
  `meeting_participants.constraints` is why one person said no — the room is
  told "Tuesday does not work for Dana", never why. A behavioural test asserts
  no group tool ever returns that row.
- **NULL is the honest third state and a guess never acts.** `chat_groups.kind`
  (migration 051) is asked ONCE, in the room — the gateway never tells us who
  added her, and `registered_by_user_id` is merely the lowest-id member — and
  until it is answered she has nothing to say about "enough people": not
  "one more" and not "we have enough". `quorum_min/max` are about the PLAN and
  are unrelated to the `group_max_members` flag, which is about the room.
- **Everything a room hears unasked is fixed text on the raw pipe**, because
  the group agent is MUTED at the gateway while the group is locked — there is
  no model output to use. Defaults in `domain/message-templates.js`, reworded
  by the owner from the admin page. Five lines per coordination (base, chase,
  done, the morning of, an hour before), each stamped on `meetings` so it is
  said once per coordination and again next week for the next one, at most one
  line per room per pass, and every one of them held to the group's own
  daytime — a line held at 02:00 stamps nothing and goes out in the morning.
  **What opens that window early is a MEMBER writing, never her own voice or a
  session's activity.** `mayAnnounce` took its grace from
  `chat_groups.last_mention_at`, and a room was told about a coordination at
  01:12 (`incidents.md`, "The room was told about a meeting at 01:12"): the
  sweep stamps that column when a group SESSION looks newer than
  `chat_groups.last_seen_at`, a room has several sessions against one
  watermark column, so the stamp is rewritten every pass and the fifteen
  minutes never elapse — and `main`'s session, which the raw pipe sends as, is
  stamped by Olma's own sends, so any line re-opened the window for the next
  one. It reads the newest `chat_group_members.last_wrote_at` now. A row
  without that column gets NO grace and falls to the hours.
- **A sweep DECIDES and the `group_outbox` job SAYS** (migration 055). The row
  and the stamp are written in one transaction, the UNIQUE `idempotency_key`
  is what actually stops a sentence twice, and a claim is never handed back —
  a sender that died mid-send leaves a row closed as `unconfirmed`, because a
  room that misses a line is better off than a room told the same thing twice.
  It is deliberately not the `outbox` table and has no column that can name a
  user: one queue per audience, so the user gate stays the only door to a
  person. **The cost is that a pass cannot see what it just said** —
  `groupOutbox.pending` is how the gate sweep still knows not to nudge a room
  it has only this second greeted (`incidents.md`, "The room was told twice").

- **TWO columns say somebody has written to Olma, because two voices can hear
  their first message.** `isConnected` (the group gate) asks
  `last_inbound_at OR opening_sent_at`: their own agent stamps the first
  (`openRecord`, `turn_start`), the intake GREETER stamps the second — and the
  greeter is who an organic joiner meets, so their own agent may have heard
  nothing for minutes. `opening_sent_at` is proof and not a guess (stamped only
  for `greetedByIntake`, read off the greeter's actual reply); a silent greeter
  leaves it NULL and falls back to the first, so nothing lets a phone number
  that never wrote open a room. Guy wrote at 19:01, his own agent saw him at
  19:04:28, and at 19:02:06 the room queued "עוד מחכה ל: גיא" about him —
  a member replied "היא שבורה" (`incidents.md`, "היא שבורה"). **Do NOT fix this
  by stamping `last_inbound_at` at provisioning**: that column being NULL is the
  once-per-life first-turn signal in `openRecord`, and `last_inbound_at =
  first_turn_at` is the silence test behind the name rung.

- **Being in the room IS the introduction, and it is not the inferred closeness
  the old rule forbids.** Everybody in a group with Olma who is ALREADY a user
  becomes connected to everybody else there, every feature on, nobody asked
  (`domain/group-connections.js`, on every sweep pass). The reversed rule
  refused connections guessed from data; this is a fact both people can see,
  and they already have each other's number in that room. Three lines it does
  not cross: a member who has never met Olma is **not invited** (that path
  messages a stranger), a `declined`/`revoked` pair is **never re-created**
  (revoking is the only way out, and a revoke a room can undo is not one), and
  nothing here moves anybody's data — every grant only means they MAY be asked,
  and a share still waits for the viewer, a relayed message still passes the
  recipient's gate. **Its own event, `connection.auto_connected`, one row per
  side** — `jobs/metrics.js` counts `connection.approved` as a friction signal,
  and a per-person audit view asks `WHERE actor_id = $1`. **Ask about the PAIR,
  never the direction**: `connections_live_pair` is UNIQUE on
  `(requester_id, target_phone)`, so the mirror row of an existing invite
  passes the constraint and leaves two live connections for one pair. The
  whole room's state is read in ONE query, not three per pair — a room of
  twenty-five is three hundred pairs inside the sweep's transaction, which is
  the lock shape of "The room was told twice".
- **The room reaches each member's OWN page as a group already made** — its
  WhatsApp name, its people, read-only (`user-dashboard.loadGroups`). The
  groups design was hidden whole on a served page because nothing kept a
  group; now the halves part company, the list showing and the "new group"
  button still hidden, because a WhatsApp room is not something that page can
  create. **No phone numbers and no `identity_token`** — the room's row is its
  door and this payload goes to a browser; non-users are drawn by the display
  name the room already shows, because a room missing half its people reads as
  the wrong room. The list is hidden in CSS until `hydrate` marks it live, not
  from script after the fetch: the seeded design groups are in the markup and
  would be somebody else's example lists on a real person's screen until the
  server answered.

- **A member's message in the room opens the gate's fifteen-minute window for
  that room's coordination — and, since 2026-09-09, the room's own announcement
  window; nothing else** (migration 056, `chat_group_members.last_wrote_at`).
  It releases `night` and the `quiet`
  drop on the same argument the DM window already makes — somebody who just
  spoke is awake — and the SCOPE is the worker's query, not the gate: only a
  row naming a meeting whose group they wrote in after that coordination
  started. `jobs/groups.mayAnnounce` is the second reader, for the reason in
  the daytime rule above: it is the only signal of presence in a room that
  Olma's own sends cannot move. A pause is still read first and absolutely. **The column is blind
  to anything that did not name her** (a registered room is
  `requireMention: true`), so its silence is never evidence that somebody said
  nothing.

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
- **Every sentence Olma sends VERBATIM — reminders and their rungs, the first
  contact to a stranger, everything said in a group — has its default in
  `domain/message-templates.js` and is reworded from the admin page
  ("ניסוחים", the `message_templates` flag), never by editing the literal in
  code on the owner's behalf.** Senders pass the loaded overrides as the last
  argument of `proactive-text.render*` / `intake/messages.*`; an override
  that drops a required placeholder is refused by name on the page and
  ignored at render, so a hand-edited flag row cannot ship a nudge with no
  tags in it. **And a verbatim sentence has no model to read "their language"
  off USER.md, so the language is a TEMPLATE choice made at delivery** —
  `localizedKey` picks the `_en` twin of a rung for an `en` recipient, off the
  users row the worker joins, never off the payload. Sarah got a month of
  Hebrew reminders under an English conversation (`incidents.md`, "Her
  reminders arrived in Hebrew").
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
