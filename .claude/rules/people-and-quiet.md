---
paths:
  - "olma2/src/jobs/checkin.js"
  - "olma2/src/jobs/onboarding.js"
  - "olma2/src/domain/users.js"
  - "olma2/src/domain/pause.js"
  - "olma2/src/domain/preferences.js"
  - "olma2/src/domain/onboarding.js"
  - "olma2/src/intake/**"
  - "olma2/src/jobs/digests.js"
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
  only by them or by the admin. **A "like" never reaches us** — on OpenClaw
  2026.8.1 there is no reaction event, so the only sign of interest we have
  is a message; a person who only likes looks silent. Vered got eighteen
  messages on her second day and answered none (`incidents.md`, "Eighteen
  messages, no answer").

- **A "once ever" question is stamped on the PERSON, never deduped on the
  route that asks it.** Two routes each honouring "at most once" is twice.
  The city is `users.timezone_asked_at` (migration 045), written by whichever
  route asks and read by both (`incidents.md`, "The city was asked four
  times"). And the first message **states** the zone guessed from the dialling
  code rather than asking for it, spending its one question on the name on
  file — `firstContactInstruction`, built per person.

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
