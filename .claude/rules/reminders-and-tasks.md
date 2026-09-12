---
paths:
  - "olma2/src/domain/reminders.js"
  - "olma2/src/domain/tasks.js"
  - "olma2/src/domain/auto-reminder.js"
  - "olma2/src/domain/task-kind.js"
  - "olma2/src/domain/datetime.js"
  - "olma2/src/domain/meeting-options.js"
  - "olma2/src/domain/meeting-option-moment.js"
  - "olma2/src/domain/meetings.js"
  - "olma2/src/adapters/mcp/tools/reminders.js"
  - "olma2/src/adapters/mcp/tools/tasks.js"
  - "olma2/src/adapters/mcp/tools/meetings.js"
  - "olma2/src/jobs/fact-extraction.js"
  - "olma2/src/jobs/sweeps.js"
---

# Reminders, tasks and dates

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Data you must not get wrong" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

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

- **A meeting negotiates several options (`domain/meeting-options.js`, up to
  five, and everybody in the coordination may add one or take one off). The
  single-slot columns `meetings.proposed_slot/proposed_start_at` and
  `meeting_participants.state` are MIRRORS of the newest active option** —
  read them if you like, but write only through the options module
  (`add/answer/remove/swap`), which re-mirrors after every change.
  A yes must name one of the options on the table; the meeting confirms the
  moment one option is unanimous among the people still in it.
  **A sixth option is refused to EVERYBODY, the initiator included, and the
  refusal carries the five** — the answer to a full table is a question ("which
  of these goes?"), which `swap` answers in one transaction. What this replaced
  on 2026-09-09: a fifth from a non-initiator waited as `pending` for the
  initiator to `approve` (naming what it replaced) or `reject`. That mechanism
  is deleted, and it had never run for a real person — 8 option rows in the
  whole history of the feature, every one `active`, and no `meeting.option_
  approved` or `option_rejected` row in the audit log (measured on the box).

- **A time taken OFF that table is never a message of its own** (owner,
  2026-09-09) — the commonest removal is somebody taking back a time they typed
  a minute ago. It rides the next thing each person hears about that
  coordination (`meeting-fanout.withRemovals` → `options.unheardRemovals`, per
  recipient at enqueue, appended once in `channels/openclaw.removedClause`
  rather than written into eight templates), and `getStatus` carries it for
  anybody who ASKS. **The baseline is the last message about that coordination
  that actually REACHED them** (`sent_at` set, `hold_reason` null) — a row the
  gate held reached nobody, so the next one that lands says it again — and
  nobody is told about their own removal. `meeting_options.removed_by`
  (migration 063) exists so the name is in the same query as the slot.

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
