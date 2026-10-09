---
paths:
  - "olma2/src/jobs/checkin.js"
  - "olma2/src/jobs/onboarding-review.js"
  - "olma2/src/domain/users.js"
  - "olma2/src/domain/pause.js"
  - "olma2/src/domain/silence-pause.js"
  - "olma2/src/domain/preferences.js"
  - "olma2/src/domain/facts.js"
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
  **A miss is a check-in that REACHED them** (2026-09-25): `checkin_misses`
  goes up in `outbox/worker` on a confirmed or timed-out send of a ladder
  rung, never at the enqueue. A row held for the night, superseded, failed or
  dropped asked nothing, and a day-one step never counts. Only the pause stays
  on the enqueue, and only after two real misses. Counted at the enqueue, the
  ladder paused עידן for three check-ins not one of which was delivered
  (`incidents.md`, "Paused for three questions nobody asked").
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
  **…and a step that HAS gone out spaces the next one, measured from when it
  reached them** (2026-10-03). The schedule counts from onboarding, so a hold
  on one step moves only that step. Hod got the Shabbat-held 15m step at
  19:08 and the 2h step at 19:20. Now `checkin.STEP_GAP_MS` (75 min, from
  measured pairs) separates any two delivered steps. No step after the first
  starts within `checkin.TALKING_MS` of their last message. The 15m step
  expires 75 minutes after joining, because its words say "a quarter of an hour
  ago". A waiting step `continue`s; it never falls through to an ordinary rung
  (`incidents.md`, "Two day-one steps twelve minutes apart").
  **And day one has a ceiling** (owner, 2026-10-04, new people said she
  "חופרת"): `checkin.dayOneSpent` counts what already reached them since
  `onboarded_at` — every kind but `reminder` and `digest` — and at
  `day_one_proactive_cap` (2; 0 = off) a day-one check-in is SILENT, never
  handed to the ordinary ladder. `stuck_meeting` and `deadline_risk` are
  theirs and pass. **And no day-one step goes out while their
  `welcome_followup` is still owed** (`checkin.welcomeStillOwed`): a room or
  game joiner's introduction waits for the next morning, and a "how did it
  go" ahead of the introduction is the order backwards. **The country
  question is not asked of somebody whose number already answered it**
  (`discoveryGaps`): a prefix `lookupTimezone` calls unambiguous that agrees
  with `users.timezone` is the answer; US, Canada, Russia, Australia, Brazil
  and Mexico still get asked.

- **Somebody who has stopped answering hears nothing Olma decided to say, and
  nothing on their record is cancelled.** The check-in ladder's one miss
  (`checkin_misses >= 1`) is the signal — counted only for the ladder's own rungs (`worker.countLadderAsk`); an owner's hand-sent `admin` message and a repair of our own fault (`unanswered_repair`, `missed_goal_repair`) are not a question they failed to answer and the delivery gate is where it
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
  **One more kind passes the quiet drop: `intro_video`** (owner, 2026-09-27,
  "לכולם חוץ ממי שמושהה"; `src/domain/intro-video.js`). A one-off broadcast of the
  intro clip, queued by `olma2/scripts/intro-video.js`, idempotent per person per
  clip. The pause still drops it, and the night, a quiet day, a pending
  introduction and the pending-user drop all still apply. It is NOT a
  precedent: a second broadcast kind is a second owner decision.
  **And since 2026-10-08 a new joiner gets it too** (owner: "5 / 10 דקות
  אחרי ההודעה הראשונה שלהם"): `jobs/intake.js` queues the same row and key
  (`intro-video.enqueueOne`) seven minutes after provisioning, only after the
  owner's FULL opening — a room's or a game night's short opening has its own
  door, `welcome_clip` — named by the flag `joiner_clip` (default 'v2', '' is off). No
  expiry: a night joiner gets it in their morning ("בבוקר"). It TAKES the 15m
  day-one step's place ("הסרטון במקומה", `checkin.ONBOARDING_STEPS` `silentIf`,
  silent rather than skipped), unless the gate dropped it; and it spaces the
  next step by `STEP_GAP_MS` like a step would. It counts toward
  `day_one_proactive_cap`, as the step it replaces did.
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
  **And another PERSON reaching them is not Olma's idea at all** (owner,
  2026-09-30: "זה לא הודעה יזומה מעולמה"). `gate.PEER_KINDS` —
  `connection_request`, `connection_response`, `share_offer`, `share_added`,
  `share_response`, `share_sharing_off`, `relayed_message` — passes the quiet drop, and so does a
  `meeting_invite` to a coordination somebody opened with them in PRIVATE
  (`privateInvite`, the worker's fact, `group_id IS NULL`). Miron asked to
  connect with עידן to arrange a meeting; at two misses the request was
  dropped `quiet` 22 seconds after it was queued, stamped `sent_at`, and
  Miron was told it had gone (`incidents.md`, "The request that was dropped
  as Olma's own idea"). **A room's invite is NOT on the list** — it is
  addressed to nobody in particular and keeps its one-per-silence allowance
  (`quietRoomInvite`) — and neither is what follows inside a coordination,
  which still needs an answer of theirs. The first word of each errand only.
  A pause, the night, a quiet day and the budget are all unchanged.

- **Somebody silent for DAYS is paused on a clock, not only on unanswered
  questions** (owner, 2026-10-07; `src/domain/silence-pause.js`, run from
  `minute_sweeps` as `sweeps.sweepSilencePause`). The ladder counts silence in
  check-ins that REACHED somebody, so anything that keeps check-ins from going
  out keeps the silence from being measured: Saar was on `daily_once_phones`,
  which drops every check-in, so `checkin_misses` stayed 0 and he heard an
  empty 20:00 message every evening. `silence-pause.due` reads the newest sign
  of life from the person's side only — onboarding, `last_inbound_at`,
  `last_dashboard_at`, a word to her in a room (`last_wrote_at`), an answer in
  a coordination, an `user.resumed` audit row — and pauses after
  `silence_pause_days_empty` (2) days when they hold no open task, and
  `silence_pause_days_holding` (5) when they do; 0 is off. **Never somebody
  with a reminder they asked for in words still to come** (`auto = false`,
  `attempts = 0`): a pause stops every reminder, and that one is a moment they
  chose. The pause is `pause.quietPause` with `note: 'silence_days'` on the
  audit row — the same `quiet_ladder` reason, so nothing is cancelled and their
  first message ends it. **And a quiet pause hears ONE message per
  coordination opened with them, room or private** (owner: "חוץ מהודעה אחת על
  כל תיאום שנפתח איתם"): `pause.keptOutOfRooms` is only a pause they asked for,
  so they are swept into every new room coordination; the worker's
  `pausedRoomInvite` passes an invite whose meeting has no earlier invite that
  reached them (a `tableChanged` re-invite is the same coordination and
  drops); the once-a-day hold steps aside for it, because the evening message
  never comes for a paused person; and a day after it with no answer
  `group-meetings.sweepSilentPausedMembers` takes them out of THAT one, a
  private one included (`incidents.md`, "Twenty o'clock, every evening, about
  nothing").

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
  come back at its own next real occurrence. **Since 2026-10-05 a LASTING
  pause has to be earned, not defaulted** (`pause.requestPause`): the stop
  must have been heard (a `said_stop` audit row inside
  `pause.CONFIRM_WINDOW_MS`) and the person must have written since, or have
  answered their paused room invite. Anything else is downgraded to the
  unconfirmed stop, and the result hands the model `askThem`
  (`pause.CONFIRM_QUESTION`), a drawn question that says what a pause does.
  An unconfirmed call never lands on a confirmed pause. The old default, `a.confirmed !== false`, let a model skip the
  question, and Eden was paused for good over a joke (`incidents.md`, "The
  stop nobody asked about"). The owner's rule (2026-09-22) is that a
  model reading the conversation and refusing turn by turn is not the
  mechanism — "אין צורך שהמודל יצטרך לקרוא את השיחה ולסרב לפי השיקול דעת
  שלו" — a column the gate reads before a turn is ever spawned is.
  **…and a stop nobody ANSWERED for a day is not a yes** (owner, 2026-10-09;
  `pause.STOP_UNANSWERED`, `pause.softenUnansweredStops` on the minute
  sweep). It becomes a SOFT pause, השהייה רכה: like the quiet pause (השהייה
  שקטה), each coordination opened with them is heard ONCE and a day of
  silence takes them out of it; unlike it, `gate.PEER_KINDS` always pass, no
  nudge ever reaches them, and the first message of each local day ends on
  one fixed line (`pause.SOFT_PAUSE_FOOTER`). Their next message ends it like
  a `said_stop`. Only a `said_stop` taken at or after
  `pause.SOFT_PAUSE_SINCE` softens: the three paused before it keep the full
  pause (השהייה מלאה) they were promised. `pause.CONFIRM_QUESTION` now says a
  yes stops other people's coordinations too, because only a yes does
  (`incidents.md`, "Silence after a stop was read as a yes"). The four names
  — שקטה / ממתינה (`said_stop`, first day) / רכה / מלאה — are the admin
  page's and the owner's.

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
  A private coordination did not earn it, by the owner's choice, until
  2026-09-30 (the growth plan, week 3): now one with three or more people
  still in it (`MORE_GROUPS_PRIVATE_MIN`, `opted_out` not counted) does, with
  its own sentence — next time, one group and one tag. WHEN it is said is an
  A/B test (`experiments.more_groups_timing`): a at the first check-in, b only
  once the meeting has happened; both arms are exposed at the same check-in,
  and b never offers from a meeting that closed before its person was
  exposed. It sits
  below `stuck_meeting`/`deadline_risk` and above Olma's own opinions, and it
  never reaches somebody at `misses >= 1`. It is spent on the enqueue in
  `checkin.run`, and the copy is quoted, not described, and asks nothing.
  **`users.room_zone_asked_at` (migration 092) is the fourth**: the one time
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

- **A preference the gate PARSES is refused at the write when the gate could
  not read it** — `preferences.remember` on key `availability` accepts one
  `HH:MM-HH:MM` window (spelling forgiven, stored canonical) and nothing else;
  the error names `quiet_days` and `record_meeting_constraint`, and says no
  tool sets a frequency. A refused call earns no 👍. The read side keeps its
  fallback for rows written before. `incidents.md`, "Saved, marked done, and
  read as nothing".

- **A fact is refused at the one door every writer shares, and a plan always has an end.** `facts.rememberFact` refuses an email address (`emailLike`), a reminder request (`reminderShaped`, the NOUN `תזכורת/ות` only) and "יש קשר עם X" (`connectionShaped`) — each has a home that stays true (the profile, `set_reminder`/`remember_preference`, `connections`) — and a `plans` fact with no `expires_at` and no `promptKey` is given one 45 days out (`PLAN_SHELF_LIFE_DAYS`, `expiryDefaulted` in the result). The default comes AFTER the `needs_expiry` check, never before it: a plan that names a moment is refused for want of its real date, not handed a made-up one. Migration 119 applied the same verdict once to the old rows; there is no scheduled pass and none should be added — the door keeps new rows honest. The same thing in other words stays at "a judgement": `task-similarity.compare` over the live facts caught 1 of 4 real near-duplicates (0 wrong merges), and an earlier test pins that this door does not make that call. Story: `incidents.md`, "The fact table kept what had a better home (2026-10-08)".

- **The ten card slots are for what was learned in CONVERSATION; the profile page's answers ride ONE line** (`facts.cardFacts` splits on `prompt_key`; `user-card.PROFILE_LINE_MAX` = 12, in the order `fact-prompts.PROMPTS` offers them, the rest counted in the "+N more" line). Every page answer is importance 2, so ranked together they took 9 of one person's 10 slots and 6 of another's, and what they had said, newer and importance 1, never reached the card. `topFacts` is unchanged for its other two readers (the overnight plan, the extraction pass's "already known" list), which want the profile answers in. Story: `incidents.md`, "The ten card slots went to the profile page (2026-10-08)".
