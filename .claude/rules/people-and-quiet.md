---
paths:
  - "olma2/src/jobs/checkin.js"
  - "olma2/src/jobs/onboarding-review.js"
  - "olma2/src/domain/users.js"
  - "olma2/src/domain/pause.js"
  - "olma2/src/domain/preferences.js"
  - "olma2/src/domain/onboarding.js"
  - "olma2/src/intake/**"
  - "olma2/src/jobs/sweeps.js"
---

# People, silence and data you must not get wrong

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Data you must not get wrong" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **`users.timezone` must never be NULL** — NULL falls back to UTC in both the
  delivery gate and the digest sweep, running an Israeli user's quiet hours
  three hours off.

- **Every time crossing a tool boundary needs an explicit offset.** A bare
  local time is read as UTC. A phone number's country is not a location, and a
  well-formed-but-wrong time still needs a semantic cross-check.

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
  only by them or by the admin. **Except by their first message after their
  one room coordination invite, whenever it comes**
  (`pause.resumeAfterRoomInvite`, 2026-09-13/14). That ends ANY pause, theirs
  included. `pauseUser` carries `room_invite_sent_at` and
  `room_invite_answered_at` forward, so "leave me paused" does not buy them a
  second invite, and the message after it does not end the pause again. **A "like" never reaches us** — on OpenClaw
  2026.8.1 there is no reaction event, so the only sign of interest we have
  is a message; a person who only likes looks silent. Vered got eighteen
  messages on her second day and answered none (`incidents.md`, "Eighteen
  messages, no answer").
  **A write from their own page IS the person answering** (2026-09-20).
  `user-dashboard-write.perform` stamps `users.last_dashboard_at` (migration
  075) and resets `checkin_misses` on every successful write — the same line
  `turn.openRecord` writes on a real inbound — and the gate reads the stamp
  as `dashboardWroteAt`: inside `CONVERSATION_GRACE_MS` it passes the quiet
  drop and counts as mid-conversation for the night window, exactly as a
  message would, and not one step further (the quiet DAY stays; a DM does not
  reach it either). `checkin.eligibleUsers` needed nothing: the audit row the
  write already records is its idle clock. **Never `last_inbound_at`** — that
  is the first-turn signal and the name ladder's silence test, and a tap is
  not a message with words in it. Kapish answered a whole coordination from
  the page, never wrote in the chat, and was `quiet` to everything
  (`incidents.md`, "The man who only ever answered from the page").
  **And a coordination they have ANSWERED is not Olma's idea either**
  (2026-09-23). `outbox/worker` reads one fact per row —
  `answeredCoordination`, a `meeting_option_answers` row of theirs on any
  option of THIS row's meeting, live or deleted — and the gate lets that row
  past the quiet drop. The owner chose the narrow line: an answer earns it,
  never membership, so a first invite to somebody who has engaged with nothing
  still drops and `pausedRoomInvite` stays the only way one gets through. It
  changes nothing else — the night still holds it, the quiet DAY still holds
  it, and Vered's rule above is untouched. `pickRung` had drawn this exact line
  two weeks earlier one layer up ("theirs, not ours"); the gate could not, so
  the ladder's own check-in passed and the confirmation of the coordination did
  not (`incidents.md`, "The room named him and nobody told him").

- **A stop is acted on the moment it is HEARD, not when it is confirmed.** גל
  wrote "dont send me messages bye", was asked "בטוח?", and never answered —
  so nothing on his record said he had asked, four urgent coordination rows
  were dispatched over the next eighteen minutes and three of them reached
  him (`incidents.md`, "The stop that waited for a yes"). The order is
  inverted now: `pause_olma` THAT turn with `confirmed=false`, before a word
  goes back, then the one question, then a SECOND call with `confirmed=true`
  on their yes — a second call and not a no-op, because that is what clears
  the provisional reason. An unconfirmed stop is a FULL pause under
  `paused_reason = 'said_stop'` — the gate is the chokepoint, the queued rows
  are cancelled, the reminders come down — and differs in exactly one way:
  **their next message about anything else ends it** (`pause.stopResume`,
  from `openRecord`'s `wake`, so it runs ahead of the model instead of
  waiting for one to decide Olma may speak again). It goes through
  `pause.resumeUser` rather than the ladder's column-clearing
  `pause.quietResume`, because this pause took reminders down and each has to
  come back at its own next real occurrence. `confirmed` defaults to the
  LASTING pause (`a.confirmed !== false`): an omitted flag leaving somebody
  paused who meant to be is one sentence from undone, and the other way round
  lifts a stop that was confirmed. The owner's rule (2026-09-22) is that a
  model reading the conversation and refusing turn by turn is not the
  mechanism — "אין צורך שהמודל יצטרך לקרוא את השיחה ולסרב לפי השיקול דעת
  שלו" — a column the gate reads before a turn is ever spawned is.

- **A "once ever" question is stamped on the PERSON, never deduped on the
  route that asks it.** Two routes each honouring "at most once" is twice.
  The city is `users.timezone_asked_at` (migration 045), written by whichever
  route asks and read by both (`incidents.md`, "The city was asked four
  times"). And the first message **states** the zone guessed from the dialling
  code rather than asking for it, spending its one question on the name on
  file — `firstContactInstruction`, built per person.
  **`users.holiday_quiet_asked_at` (migration 062) is the second column of
  that shape**, and it was built with two routes from the start: the discovery
  ladder offers quiet chagim when one is within seven days, and `turn.advise`
  offers the same thing on the erev or the day itself if a conversation gets
  there first. Whichever arrives stamps, and the other reads the stamp — a
  topic string in the outbox would have let each of them be right about "at
  most once" and asked twice between them. **It is spent on the HAND-OUT, not
  on their answer**: a question the model then did not fit into the reply still
  used up the one turn this person's patience had, which is the same reasoning
  as the timezone rung's stamp on enqueue.
  **The offer and the mention are different promises.** Naming the day is
  conversation context only (owner, 2026-09-11: "רק בהקשר השיחה") — it rides
  `today.holiday`, never a message of its own, and a day marked `solemn` (a
  fast, Yom HaShoah, Yom HaZikaron, Yom Kippur) is never congratulated.
  **`users.more_groups_offered_at` (migration 086) is the third column of that
  shape**: the offer to add Olma to more groups (owner, 2026-09-23). It is the
  `more_groups` rung of `checkin.pickRung`, earned by a YES on the exact option
  a ROOM's coordination locked on (`starts_at` = `confirmed_start_at`) in the
  last fourteen days. Everybody who said yes gets it, not only whoever asked.
  A private coordination does not earn it, by the owner's choice. It sits
  below `stuck_meeting`/`deadline_risk` and above Olma's own opinions, and it
  never reaches somebody at `misses >= 1`. It is spent on the enqueue in
  `checkin.run`, and the copy is quoted, not described, and asks nothing.
  **`users.room_zone_asked_at` (migration 090) is the fourth**: the one time
  somebody whose zone was never confirmed (`timezone_confirmed = false`) is
  asked whether it is right, because a room they are in spans several clocks
  and every time said there is converted from it (owner, 2026-09-25, פנתרה).
  It is a NEW occasion, not a second go at `timezone_asked_at`: "nobody is
  asked twice" still holds for the check-in rung, and this one is bounded the
  same way. It never gets its own send. It rides the room coordination's
  private invite (`roomZones` on the payload, from
  `group-meetings.roomZonesFlag`), is decided at delivery by the worker
  (`zoneAsk`, a row going out alone, never inside a merge), and is stamped
  only once that send confirmed, like `room_invite_sent_at` beside it. The
  city comes from the server (`meeting-time.zoneLabel`), and an answer goes
  through `set_my_timezone confirmed:true`, which runs `timezone-repair`.

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

- **The assistant is עולמה / Allma; the system is still olma2.** The rename
  (2026-09-04) covers user- and operator-facing text only — repo, `/opt/olma2`,
  the services, the MCP tool prefix and `olma_identity` keep the old name.
  `docs/incidents.md` keeps the old spelling too: it quotes real messages, and
  correcting them would falsify the record. Two readers must answer to BOTH
  spellings and say so — `facts.SYSTEM_NOUN_RE` (old facts are still in the
  table) and the voice bridge's name check and Deepgram keyterms.
