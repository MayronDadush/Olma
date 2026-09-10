---
paths:
  - "olma2/src/brokerd/**"
  - "olma2/src/domain/turn.js"
  - "olma2/src/domain/self-initiated.js"
  - "olma2/src/domain/reply-leak.js"
  - "olma2/src/domain/unanswered.js"
  - "olma2/gateway-hooks/**"
  - "olma2/gateway-plugin/**"
  - "olma2/bin/olma-mcp.js"
  - "olma2/bin/olma-brokerd.js"
  - "olma2/src/jobs/unanswered.js"
---

# Turns, and what reaches the person

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Data you must not get wrong" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

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

- **A reply that got lost is RE-SENT, never re-answered.** The transcript is
  holding the composed reply word for word, so handing a model the job of
  saying it again is asking a second model to reconstruct what we already have
  — and it is what put English internals on Yahav's phone. `undeliveredReply`
  carries the text and it goes out on the raw pipe with no model in the path
  (2026-09-09), for the same reason reminders were moved there. **A raw send
  does not enter the session**, which is the point and not a cost: the reply is
  already in the history, so re-sending verbatim makes the phone match it,
  where the model turn appended a SECOND assistant turn and left the
  conversation holding the answer twice. **Verbatim or nothing** — a reply
  carrying a `MEDIA:` line is a gateway convention the raw pipe cannot honour,
  so it is counted on the heartbeat and left alone rather than half-sent.

- **The model's own working-out is stopped in the GATEWAY, not by the
  doctrine.** Yahav asked for a reminder at 13:00, got the 👍 and the right
  reminder, and then read four paragraphs about himself in the third person
  naming `due_at`, `remind_at` and `2026-09-10T10:00:00Z` (2026-09-10;
  `incidents.md`, "The working-out arrived instead of the message"). Third time
  in nine days, and the doctrine had already forbidden it in three sentences —
  a safety property written as a prompt line is a request. **An outbound gate
  exists and the note saying otherwise was wrong**: OpenClaw 2026.8.1 publishes
  `reply_payload_sending` (Modify/gate, no `allowConversationAccess` needed), so
  `gateway-plugin/olma-turn` registers it and asks `domain/reply-leak
  .gateReply` — LOCALLY, no socket in the decision, brokerd told only when
  something was found. Two tiers, because dropping text is destructive and
  reporting is free: a frame marker, one of our own names off a CLOSED list, an
  ISO instant or a model-only block name drops; every other snake_case
  identifier is reported and delivered (it is also the shape of a word in
  somebody's task title). The unit is the PARAGRAPH and the cut is everything up
  to the last one that leaked — narration comes first, so notes above a Hebrew
  answer lose the notes. The sentinel alone is a decision and never a leak; with
  words it is stripped, because `unanswered` reads "בוצע NO_REPLY" as a real
  reply. `main` is never gated — that is the raw pipe carrying the owner's
  wording. **And it is inert until the gateway is restarted** (`systemctl --user
  restart openclaw-gateway`; `deploy.sh` does not), which is what
  `config_guard.checkReplyGateLive` reads off the plugin's registration stamp.
