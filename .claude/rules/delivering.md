---
paths:
  - "olma2/src/outbox/**"
  - "olma2/src/domain/message-format.js"
  - "olma2/src/domain/message-merge.js"
  - "olma2/src/domain/message-templates.js"
  - "olma2/src/domain/digest-block.js"
  - "olma2/src/domain/list-block.js"
  - "olma2/src/domain/proactive-text.js"
  - "olma2/src/domain/pause.js"
  - "olma2/src/channels/openclaw.js"
  - "olma2/src/channels/gateway-rpc.js"
  - "olma2/src/jobs/sweeps.js"
  - "olma2/src/outbox/gate.js"
---

# Delivering a message

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Delivering a message" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

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
  right way round. The OTHER half of that is `stripUserMarkup`, which removes
  emphasis such a value would render on its own, on the three verbatim paths
  where no model retypes the words (a reminder title and its batch lines, a
  room's slot text, the name and reason a stranger first reads). It is narrow
  on purpose — a pair goes only when both markers sit at a word boundary, so
  `report_final_v2` and `7~8` survive — because deleting a character out of
  somebody's words is a thing you get to be wrong about once. **Olma does not
  use italic, monospace or inline code at all** (owner, 2026-09-09, decided by
  looking at them on a phone), and links go bare.
  The module BUILDS markup and does not parse it, so
  owner-typed markup in `message_templates` would reach a second channel raw;
  that gap is named in the doc rather than closed by a parser nothing can
  check.

- **On the MODEL path a style is granted by a RESULT, never by a description**
  — `message-format.HINTS` (list, numbered choice, struck out, quote their
  words), riding the tool result or the outbox instruction, so it costs tokens
  only on the turns it applies to and five tools cannot drift into five
  phrasings. Each fires only where it has work: two items before a list is
  worth laying out, two options before numbering means anything. **The
  doctrine line had to change with it** — `agents-template.md` said "No
  markdown bold", and a hint contradicting an unconditional line of doctrine
  is OUTVOTED, not ignored, which is the `markPlaced` fault exactly. It now
  reads "*Bold* one thing at most, never a sentence; other styling only where
  a result asks" (84 chars for the 18 it replaced, 38 left of 39,250). Every
  hint is a CEILING as much as a permission, because the failure mode is not
  the model ignoring this — it is the model enjoying it, and a digest that
  reads like a newsletter is worse than the paragraph it replaced. Nothing
  here is enforced by code: eval `list-reads-as-a-list` is the only thing that
  looks at a real reply, and it checks both directions.

- **What is the same every time is DRAWN, and only the sentence about it is a
  model's** (`domain/digest-block.js`, the morning digest, 2026-09-09). The
  block is rendered in code — the calendar first, the to-dos after, the moment
  in the shortest honest form in THEIR zone, the styling off their channel and
  the words off their locale — handed over finished on `get_my_digest`'s
  result, and relayed verbatim; the model adds one sentence and nothing else.
  It buys a layout that cannot drift, a list that cannot lose a task, a suite
  check instead of an eval, and no cost. It costs what every deterministic
  sentence here costs: **no grammatical gender**, so nothing in a drawn block
  may be a verb addressed to anybody, and one set of words per language. A
  schedule CARD replaces the block above `digest_card_min_items` — never both.
  **`null` (nothing due) and an empty block are different answers**: a morning
  with nothing on it is a real morning and the sentence about it is the
  model's, never an empty heading.

- **…and since 2026-09-10 the lists and choices a person ASKS for are drawn
  the same way** (`domain/list-block.js`: `list_my_tasks`, `list_my_reminders`,
  `my_calendar_events`, `get_meeting_status`). The first three share the
  digest's line renderer — `digest-block.contextFor/line/whenLabel/dayLabel`,
  exported for exactly that — so a day is named the same way in every message
  Olma sends and there is one answer to "what is today". Two things in them
  are not layout: the calendar/plate split was a paragraph asking the model to
  do what `tasks.kind` exists to enforce, and `listReminders` returned rows
  with **no title**, so saying what a reminder was about meant re-fetching the
  tasks (the hour now renders in THEIR zone beside the instant, as `listTasks`
  already did). **`chasing` is never drawn** — the rule that it is not an hour
  anybody may say out loud becomes a shape instead of a sentence.
  **`my_calendar_events` gets its OWN line builder, never `digest-block.line`**
  — Google's `start`/`end` are a DATE for an all-day event and an INSTANT for
  a timed one, and reading a date like an instant puts it at UTC midnight,
  which in a zone behind UTC is the day before (the exact fault
  `user-dashboard-events.js`'s `dayGap` already guards under the same name).
  `dayLabel` (split out of `whenLabel`) is called on the event's own
  `{y,m,d}` directly, with no zone conversion at all — there is nothing to
  convert. **`get_meeting_status` numbers only `active` options** — a
  `pending` fifth is not yet open for anyone to vote on, so numbering it would
  tell a participant they can "answer with the number" on a choice that is not
  actually theirs — in the proposer's own words (`slotText`), never a time
  re-derived from `startsAt` that could disagree with what they said. Below
  each one's own floor (`MIN_LINES` = 2 active items/options) there is no
  block and the old instruction hints stand, and a block NEVER travels beside
  `HINTS.list`/`numberedChoice` or the `kinds` paragraph: an unconditional
  "lay these out" on a result that arrives laid out is the `markPlaced`
  fault, asking for work already done. `HINTS.relayBlock` states the relay
  contract once for all five tools that hand a block over; each appends only
  its own sentence. **What "gone" still is not drawn**: `meeting-options.list`
  only ever returns `active`/`pending` rows, so a declined or replaced option
  is not in the result at all — there is no line for a strike-through to land
  on, and saying one left the table stays a model's sentence
  (`HINTS.struckOut`, unchanged).

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

- **On the model path a retry is not a retry — it is a NEW message, composed
  against a world the failed sends themselves created.** `--deliver` runs a
  whole turn before the channel is asked to carry anything, and the outbox row
  holds an instruction, not a message, so nothing of a failed attempt survives
  it. While WhatsApp was disconnected on 2026-09-11 Yehav's digest was written
  five times between 08:26 and 09:08 — five turns, four cards drawn and thrown
  away — and the draft the returning channel finally carried was the one that
  had spent forty minutes watching him not answer: "ואתה לא עונה". He had
  answered everything he was shown; the silence was ours
  (`incidents.md`, "The fifth draft was the rude one"). So the worker asks
  `gateway-health.checkChannels` once per tick, behind the gate, and an
  explicit `down` skips the send while booking exactly what the failed send
  would have booked — `attempts + 1`, the reason in `last_error`, the same
  backoff — so the stuck-row alarm, the reminder-redo discriminator and the
  dashboard all read what they read today. **`unknown` SENDS**: the probe is
  an optimisation that skips work known to be wasted, never the authority on
  whether Olma may speak, and a detector that goes quiet must not be what
  silences the queue. `channelDown` is counted apart from `failed` on the
  heartbeat, because "attempted and lost" and "nobody attempted" are different
  facts. Failures for any OTHER reason still recompose — closing that needs
  the composed text to outlive the failure, and it carries a `MEDIA:` line,
  which is the wall `undeliveredReply` already chose to stop at.

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
