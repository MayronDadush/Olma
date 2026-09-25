---
paths:
  - "olma2/src/domain/reminders.js"
  - "olma2/src/domain/tasks.js"
  - "olma2/src/domain/auto-reminder.js"
  - "olma2/src/domain/task-kind.js"
  - "olma2/src/domain/datetime.js"
  - "olma2/src/domain/meeting-options.js"
  - "olma2/src/domain/meeting-option-moment.js"
  - "olma2/src/domain/meeting-fanout.js"
  - "olma2/src/domain/meetings.js"
  - "olma2/src/adapters/mcp/tools/reminders.js"
  - "olma2/src/adapters/mcp/tools/tasks.js"
  - "olma2/src/adapters/mcp/tools/meetings.js"
  - "olma2/src/jobs/fact-extraction.js"
  - "olma2/src/jobs/sweeps.js"
  - "olma2/src/domain/quiet-facts.js"
  - "olma2/src/domain/chase-deadline.js"
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

- **A ladder is something they ASK for, and the question is who chose the
  HOUR.** Measured on the box across 45 days before it changed
  (`incidents.md`, "התיק לבית חולים"): a follow-up rung ends in "done" 22% of
  the time and in the person CANCELLING the reminder 35% of the time, and the
  next-day rung converted for one user in sixteen. So `reminders.RUNGS` is
  `{explicit: 1, auto: 2, nudging: 3}` — an hour they NAMED is said once, an
  hour Olma INFERRED from a due date gets one follow-up the same day (nobody
  was promised 08:00), and the full three rungs belong to whoever asks for
  them: `users.reminder_nudge` (the switch on their own page) or
  `task_reminders.nudge` (`set_task_reminder(nudge:true)`, migration 072).
  **The cap is computed in `dueForSending` and returned on the row as
  `rung_cap`** — the sweep says "זו התזכורת האחרונה" off the same number the
  WHERE clause stopped on, because a cap the caller re-derives is the second
  copy that drifts. `reminder_escalation_max` still bounds all three from
  above. **And never a rung once the local day of `due_at` has ended**:
  "הספקת לארוז?" the morning after the hospital is a message about nothing,
  and an overdue task is in the digest either way.

- **"להפסיק להזכיר" is a WRITE, not a question.** מאיה asked twice over — once
  for one reminder at 09:00, and once for it to stop — and got six messages and
  a multiple-choice question ("מה להפסיק? 1. … 2. … 3. …") with nothing
  cancelled. Two ladders were chasing her, which is why the model asked; the
  asymmetry it could not see is that stopping one reminder too many costs a
  sentence to set again, while asking costs the thing they asked for. The
  gateway hook classifies the message (`stopRemindersOnly`, the verdict
  travels and the words do not, exactly like `thanksOnly`), brokerd calls
  `reminders.stopRecentLadders` before the model reads the turn, and the mark
  becomes 👍 instead of the 👀 that promises a reply. **What it touches is
  what has REACHED them** — a one-off ladder with a delivered rung inside 24h,
  retired with `sent_at` because they answered it, plus the rung already queued,
  withdrawn as `hold_reason = 'stopped'`. Never a reminder that has not fired
  (they have never heard it, and it is an hour they may still be promised),
  never a repeating one, never the task. **A stop carrying a NEW time is a
  reschedule and stays the model's** — "תפסיק עם התזכורות … הבאה רק ביום שני"
  must keep taking the ordinary path. `\b` is dead against Hebrew, so די is
  anchored on spaces.

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
  **A whole day or a part of one keeps its PRECISION all the way onto the
  settled meeting** (owner, 2026-09-24; migration 087,
  `meetings.confirmed_all_day/confirmed_daypart`, written by
  `meeting-options.confirmOn` and nothing else). Its `starts_at` is a stand-in
  hour — 09:00 for a whole day, `PART_HOURS` for a part — put there by
  `meeting-option-moment.standInFor` whichever door the time came in by, so the
  same day named twice is still one option. Everything that reads the settled
  moment has to ask the precision first: the calendar makes a whole day a
  `{date}` event (`calendar.createEvent`, `allDay`), and the room gets the
  day-of line and never an hour-before one off a stand-in hour
  (`group-voice.decideGroupLine`).
  **A sixth option is refused to EVERYBODY, the initiator included, and the
  refusal carries the five** — the answer to a full table is a question ("which
  of these goes?"), which `swap` answers in one transaction. What this replaced
  on 2026-09-09: a fifth from a non-initiator waited as `pending` for the
  initiator to `approve` (naming what it replaced) or `reject`. That mechanism
  is deleted, and it had never run for a real person — 8 option rows in the
  whole history of the feature, every one `active`, and no `meeting.option_
  approved` or `option_rejected` row in the audit log (measured on the box).
  **…and the mirror is a CONVENIENCE, never a clock.** `meeting-options.
  mirrorCurrent` picks `ORDER BY id DESC` — the most recently ADDED option,
  which is not the latest one in time and has never claimed to be. Asking
  `meetings.proposed_start_at` whether a coordination is over therefore gave
  the opposite answer depending on the order two times were put on the table:
  a coordination offering Tuesday and, added after it, next month was closed
  on Tuesday night with next month still live, and the other order left
  Tuesday on the table long after Tuesday (`incidents.md`, "The coordination
  that expired on the wrong Tuesday"). Since 2026-09-23 the question is asked
  of the table itself — `meetings.dropPassedOptions` takes every option whose
  moment has passed off it, and only a coordination this pass has just taken a
  time away from is asked whether it is empty. **Running out of times is not
  the same thing as having none**: a table somebody emptied by hand a minute
  ago, and one nobody has put a time on yet, both sit at zero and neither is
  over.
  **A whole day is the one option whose moment is not six hours after its
  instant.** `meeting-option-moment.momentFor` stamps an all-day option at
  09:00 of the day it means, so the grace a clock time gets would take
  "Sunday, all day" off the table at 15:00 on Sunday. It gets a full day on
  top (`meetings.ALL_DAY_EXTRA_MS`), and every line here errs late on purpose
  — a time removed an hour early is a time somebody could still have agreed
  to.
  **The status says which of the two ways a time left**: `deleted` is a person
  taking it off, which is carried to everybody else the next time they hear
  about the coordination (`meeting-options.removed`, `meeting-options.
  unheardRemovals`); `expired` (migration 085) is nobody's doing and is said to
  no one, because "Tuesday came off the table" about a Tuesday that has been
  and gone is noise.

- **A constraint that rules out a time ON the table is an ANSWER, and the tool
  that records it is the one that declines it** (2026-09-20). Maya wrote "לא
  יכולה ביום שני" with Monday on the table; the model called
  `record_meeting_constraint`, never `respond_to_meeting_slot accept=false`,
  and to the drawn table and the initiator's ✓ she had not answered — while
  the 👍 told her it had registered (`incidents.md`, "The constraint that was
  an answer"). So `record_meeting_constraint` takes `declines_option_ids`,
  checks every id against the live table BEFORE writing anything, then records
  the constraint and puts an `n` on each option through
  `meeting-options.answer` and `meeting-fanout.afterSlotResponse` — the same
  road a decline takes, so the initiator hears it with the reasons. Omitted
  with a non-empty table, the result carries the table by id and says the
  constraint answered nothing. **And it is out of `reactions.TOOL_MARKS`**: it
  can only ever be called while a meeting is negotiating, which makes it a
  negotiation step, and the negotiation family has no 👍 by rule
  (`rules/doctrine.md`) — a 👍 there says "done" about something that is not.

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

- **A negotiation message WAITS a quarter of an hour behind the last one that
  reached that person, and everything that happens meanwhile folds into it**
  (`meeting-fanout.PACE_MS`, owner 2026-09-22). מירון opened a padel
  coordination and read five messages in twelve minutes — the invite, a time
  added, two people declining the same Wednesday sixty-three seconds apart,
  another time added (`incidents.md`, "Five messages in twelve minutes, about
  one coordination"). The fold that says several things once already existed
  and never got to run: every negotiation row is `urgent`, so it left inside a
  minute and there was nothing unsent left to fold into — Kapish's four rows
  only ever folded because the NIGHT was holding them. Measured before the
  number was picked: 46 of the 68 consecutive coordination messages ever
  delivered landed inside fifteen minutes of the one before, 31 inside five,
  and half an hour would have caught two more. It is `release_after`, not a
  gate hold — the row is SCHEDULED, never looked at, and the worker's picker
  already honours the column — and the baseline is what was DELIVERED, so a
  row the gate dropped buys no quiet. **The paced set and the foldable set are
  ONE list** (`FOLDABLE_KINDS`): a kind that waits but cannot be folded into
  is a second message sitting beside the one the pacing just created.
  **A RESULT never waits** — confirmed, cancelled, nobody matched, expired is
  the message they are actually waiting for.

- **Opening a coordination is not a subscription to every answer in it**
  (owner, 2026-09-22: "אין צורך שמי שפתח את התיאום יקבל הודעות מיוחדות"). A
  plain decline and somebody stepping OUT of a coordination that carries on
  went to the initiator and to nobody else, and two of מירון's five messages
  were exactly that. Neither is a message now. Nothing he could act on is
  lost: the drawn table says how many people are on each time, and
  `meetings.getStatus` still carries every participant's shareable constraints
  by name — the REASON moved from a push to a pull, readable the moment he or
  the next thing this coordination asks him goes out. `meeting_no_match` stayed
  for one more day and went on 2026-09-23 with the rule below. `afterSlotResponse`
  keeps an unread `accept` on purpose: a yes and a no produce the same fan-out
  now, and the parameter says that reading it again is a decision.

- **Nobody MANAGES a coordination** (owner, 2026-09-23: "אין יותר מנהל של
  התיאום — כולם מנהלים של התיאום"). `meetings.initiator_id` is who OPENED it —
  a fact the invite and the room still say, and the organiser Google prefers
  (`calendar.meetingCalendarRoles`) — and grants nothing. Anybody still in it
  (a participant not `opted_out`; `IN_IT` in `meetings.js`) may settle it by
  hand (`options.settleNow`), rename it, cancel it for everybody, or LEAVE it,
  the opener included; somebody who has left may do none of those. Three
  things follow. **Cancelling for everybody is the chat's alone** — the page
  offers leaving, and deleting only between two people (either of them), where
  leaving would end it anyway. **The ending is never a message of its own**:
  `meeting_expired` and `meeting_no_match` went to the opener alone and are
  now enqueued by nothing; whoever was still in it reads the ending in their
  next digest (`digest.assemble` → `crossUser.closedMeetings`, since their
  last digest that really went out, three days at most), which is the owner's
  choice between "everybody" and "nobody". **Revoking a connection is an exit**
  whoever opened the pair's coordination, so it closes `no_match`, never
  `cancelled`. The chat tools' descriptions and the doctrine's "תבטל את
  הפגישה" line say "anyone in it"; a test still asserting "initiator only" is
  asserting the old product.

- **A time ADDED to it rides the same thing, as long as that thing has not gone
  out yet** (2026-09-20). `meeting-fanout.js`'s `fanout` folds a new
  `meeting_slot_proposed` into whichever `meeting_invite` /
  `meeting_slot_proposed` row for that person and that coordination is still
  unsent, stamping `tableChanged` on it instead of writing a second row —
  never at delivery, where the reminder batch and `message-merge` do their
  coalescing, because the point is precisely the row that has not been sent.
  **The OLDEST row survives**, so an invite's framing ("the group is arranging
  X, Y asked for it there") is never replaced by a bare slot question. **No
  time is copied onto it**: the table can move again before it goes out, so
  `get_meeting_status` at delivery is the only honest source, and
  `channels/openclaw.js`'s `TABLE_CLAUSE` is what turns the stamp into ONE
  question about the whole table instead of one message per option. Removals
  are recomputed onto the surviving row, or the news above would ride a row
  nothing will ever send. A question that already REACHED somebody folds
  nothing — the next time is its own message, as it was. קאפיש read four
  messages in sixty-two seconds when his invite and three additions, all held
  for the night, released together on his first word in the room
  (`incidents.md`, "Four messages in sixty-two seconds").
  **Two things its first live day corrected.** "Not gone out yet" is what the
  WORKER holds, not what `sent_at` says: the worker locks a row for the whole
  of its delivery and stamps only after the send confirms, so a fold that
  found `sent_at IS NULL` waited on that lock and then wrote `tableChanged`
  onto a message already out — Yuval's invite — and the time it carried
  reached nobody. The fold's SELECT is `FOR UPDATE SKIP LOCKED` and its UPDATE
  re-asks `sent_at IS NULL`; a row in flight is skipped and the addition gets
  its own row. And a question for somebody whose invite never REACHED them is
  the invite, asked late: the gate dropped Kapish's (`quiet`) and the first
  thing he read about the coordination was a bare "two times on the table".
  `meeting-fanout.unheardInvite` sees a DROPPED invite — `sent_at` stamped with
  a `hold_reason`, every one of them — and the next addition goes out as a
  `meeting_invite` carrying that framing plus `tableChanged`. Only dropped:
  a pending one is the fold's, and one in flight is about to reach them.

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
  the fact-extraction pass — each relied on the model not repeating itself, and
  the box held 21 pairs of open tasks sharing a title across three of
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

- **…and the same thing in OTHER words is a judgement, so it was measured
  before it was written.** `domain/task-similarity.js` holds it, and every
  number in it came off 86 real pairs the owner labelled one at a time
  (2026-09-18). Three things the labelling overturned, all of them things a
  reasonable person would have shipped: **a shared due moment is not
  evidence** — 17 pairs were lifted by a same-hour bonus and 15 of those were
  rejected, because two tasks set for one moment are two things said in one
  breath; **both titles naming a weekday or a clock is a refusal**, since six
  משמרת pairs overlap on 0.56 of their words and the unshared part is the
  whole content; and **two titles each carrying a word the other lacks are
  disagreeing** (`disagrees`), which is what stops "לקחת כדור ריבון" merging
  into "לקחת כדור לבלוטה" while "ריבון"/"ריבה" still matches as one word
  misspelt. What is left is word overlap at `MERGE_AT` = 0.50: 69 of the 80
  pairwise labels, and not one merge of a pair marked "don't touch". It cannot
  reach a rewording ("לסחוב לברכה" against "לכתוב ברכה"), and the eight it
  misses are named in the test so that fixing one is deliberate.
  **The two writers then take OPPOSITE answers from it, and that asymmetry is
  the rule.** `jobs/fact-extraction.js` refuses — that job has no channel to
  ask on (it writes through the domain functions and sends nothing, ever; it is
  also not nightly, `expectations.fact_extraction` is 600 seconds) and the
  live tool has already captured the sentence, so every tier
  collapses to `refused.similar_open`, and it alone also refuses a twin
  COMPLETED inside 24h (this job cannot mean "again": "להעיר את מאיה" was
  ticked off two minutes after it was created and written back forty-two
  minutes later). `tasks.addTask` **saves and asks**: refusing there was tried
  and broke 57 tests on "סופר" beside "סופר השבוע", because one title
  extending another lands on 0.50–0.67 and is a real second task about as
  often as it is one. The row is written, `similarTo` rides the result into
  `hints.similar`, and one sentence settles what no threshold can — which is
  also what keeps the 👍 honest. Neither path ever compares a checklist item.
  The "list inside one task" tier is NOT here: four of the six pairs marked
  that way share one word out of eight, so it belongs to a grouping pass over
  a whole open list, never to a check at the moment of writing.

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
  added): the half thought to be right — a calendar ask is one thing, not a
  task and a reminder as well — moved to `create_calendar_event`'s own
  description, where the model reads it at the moment it would make that
  mistake. **That half was REVERSED in its turn on 2026-09-22, and the
  mechanism is why it cost eighteen days**: the sentence justified itself with
  "an event that already alerts", which was a guess nobody checked.
  `calendar.createEvent` sends Google no reminders override, so the event
  alerts on that person's own Google default and Olma sends nothing for it at
  all — and the description, being what the model reads at the moment of the
  call, outranked the doctrine's "Their calendar", which says the opposite.
  See the next rule.
  **Every statement of this rule used to teach it with the IMPERATIVE example,
  and the noun form went through all three** — the doctrine, `add_task`'s
  description, and `reminder-promise.js`'s `ASK_RE`. "תוסיף תזכורת ליום שלישי
  ב-9 וחצי" filed 9:30 as `due_at`, armed the hour-before at 08:30, and then
  SPOKE, because `taskHints.reminders` reads an hour Olma chose as news
  (2026-09-17; `incidents.md`, "The same rule, in the noun form nobody had
  written down"). The first two now name both forms and the eval
  `named-reminder-hour` holds the armed hour. `ASK_RE` still wants a digit
  straight after the ל, so `promise_watch` cannot see this phrasing at all —
  **open, and to be widened only against real messages off the box**, because
  a pattern that fires on ordinary input is worse than none
  (`rules/detectors.md`).

- **A task with no date can still nudge, and a nudge must NEVER date it**
  (owner, 2026-09-19). Four of his own tasks were this shape — "לקבוע עם
  מיכאל", "ריצות בים" — something with no moment that should come back every
  week until it is done. `reminders.setReminder` always allowed it: it takes a
  `remind_at` and a `repeat_rule` and writes no `due_at`. What refused was the
  PAGE, where a reminder was derived from the task's due date, so the switch on
  a dateless task built nothing and dropped the call — no error, no toast, a
  switch left on and a reminder that never existed. The dateless kind now
  carries an hour of its own (`remAt`, the next time that hour comes round in
  their zone) and the sheet asks for it where the "how long before" chips sit,
  because an offset has nothing to be offset from. **Giving such a task a
  `due_at` to make the machinery work is the one thing that must not happen** —
  it turns a standing job into a deadline that is wrong by tomorrow, and it is
  the whole reason the shape exists. `tests/user-dashboard-write.test.js` pins
  both halves: the row is written with `repeat_rule` and the task's `due_at`
  stays NULL, and the page's own `nextIsoAt` is RUN, in four zones, and has to
  land on the hour asked for and always ahead of now.

- **…and the hour it defaults to is the hour they ALREADY hear from Olma, so
  the nudge rides the morning picture instead of interrupting twice** (owner,
  2026-09-20). The page takes their earliest morning `digest_times` entry,
  failing that the start of their availability window, and never a bare
  constant; somebody whose only digest is in the evening falls through to the
  window, because the question being answered is "when do you read your
  updates in the morning". At that hour the reminder sweep does not enqueue a
  message at all — `reminders.ridesDigest` (dateless AND repeating AND exactly
  one of their digest hours, read in THEIR zone) hands the occurrence to the
  waiting digest row, and `digest-block` DRAWS it under its own heading.
  **Drawn, never woven**: `message-merge.js` refuses to fold a reminder into a
  composed turn because a model may reword or drop the one sentence somebody
  asked for while the row still reads delivered, and that reason does not stop
  applying just because the owner wants one message instead of two.
  Three things hold it together and each closes a way it could go silent.
  **The sweeps run digests-FIRST** (`jobs/registry.js`), so `sweepReminders`
  can require a digest row that is really there and really still unsent before
  handing anything over — the other order leaves only a hope, and a nudge given
  to a digest already delivered reaches nobody. **The link is the ROW**
  (`task_reminders.carried_outbox_id`, migration 078), not a time window: the
  nudge is drawn for exactly as long as that digest is waiting and stops the
  moment it lands, which is a clock fewer to get wrong. And **a card never
  replaces a block that is carrying one** — a card draws a DAY and has no row
  for a job with no date, so `drawInsteadOfBlock` refuses outright rather than
  letting the nudge vanish into a picture on a row already stamped as the
  message that carried it. It survives `summary` scope for the same reason a
  nudge is not a count: four of the six people with a digest are on it.

- **A calendar event reminds NOBODY, and `create_calendar_event`'s result says
  so rather than leaving it to be guessed.** `calendar.createEvent` sends
  Google no reminders override, and nothing on our side speaks for a calendar
  event: a reminder hangs on a TASK (`task_reminders.task_id` is NOT NULL), so
  an event that exists only on Google has nowhere to hang one. עמית asked for a
  Friday 12:00 viewing, then asked "תזכיר לי מראש?", and was told an automatic
  reminder was set for 11:00 — the hour `auto-reminder.autoReminderAt` would
  in fact have picked, which is why it read as true. No row existed and Friday
  passed in silence (`incidents.md`, "The reminder that was only a sentence").
  The result now carries `hints.reminders`, which **forbids a sentence rather
  than asking for one** — an unconditional instruction to write beside
  `markPlaced` is the thing that outvotes it (`rules/doctrine.md`) — and names
  `add_task kind:'event'` as the only thing that arms one. **The same moment
  can therefore now be saved twice, and `calendar.eventIdFor` is what stops it
  becoming two entries**: it hashes the INSTANT, not the spelling, because
  `createEvent` is handed the model's offset string while
  `task-calendar.windowFor` produces UTC ISO. The second write becomes a 409,
  which `createEvent` already treats as success, so the task binds to the event
  already there. Every id the sweep has written came from a UTC ISO string,
  which normalises to itself — nothing live moves. **Open**: nothing reconciles
  the event against the task shadowing it, so an event deleted by hand still
  reminds.

- **Everyone on a shared task is equal, and a write on it is made AS its
  owner** (owner, 2026-09-19). There is one kind of share: `shares.role` is
  still a column and is read by nothing. `shares.actingOwner` answers whom a
  write is performed as — the person themselves on their own task, the OWNER
  on one shared with them — and every dashboard task action goes through it
  (`user-dashboard-write.js`, `asOwner`), so `tasks.js` stays owner-scoped and
  single. Somebody on neither side gets `not_found`, never `forbidden`. Three
  things follow. **"Delete" on a task others are on is LEAVING**
  (`shares.leaveTask`): a participant's own share is revoked; the one who
  opened it hands the task — items included — to whoever accepted first, taking
  only THEIR OWN pending reminders with them; only the
  last person left can archive it (`archiveTask` refuses with
  `reason: 'shared'`). **A task of mine dropped onto a list somebody shared
  with me changes hands** (`shares.adoptIntoList`): an item is a line on the
  list-owner's list, and one owned by somebody else would be the one line they
  could not tick. A pending reminder no longer refuses the move — it is
  stamped with its person before the row changes hands. **The GUEST LIST is
  everybody's too**: any participant offers a share or ends one
  (`offerShare` takes an `inviterId` and checks
  `grants.requireFeatureBetween` between THAT person and the invitee —
  asking the task's owner for a connection they may not have is the wrong
  question). The row still carries the task owner as `owner_id`, because that
  is whom writes are made as; `requested_by` is who actually invited, and
  `connection_id` names the inviter's connection. Nothing on a shared task is
  one person's alone any more.

- **A reminder belongs to the PERSON, not to the task** (migration 073,
  `task_reminders.user_id`, 2026-09-19). On a shared task each participant
  sets their own hour and neither switch touches the other. The column is
  NULLABLE on purpose — rows written before it mean "the task's owner", which
  is the answer every reader assumed until then — so **every query that asks
  whose a reminder is asks `COALESCE(r.user_id, t.owner_id)`**, never
  `t.owner_id`, and that is the one-line review for any new reader
  (`reminders.RECIPIENT`). `reminders.setReminder` accepts a task its caller
  OWNS or is SHARED on, takes the hour in the SETTER's zone, and supersedes
  only that person's auto row; `dueForSending` returns the recipient as
  `user_id` and `sweeps` enqueues and re-arms against it.
  **Coming off a shared task takes your reminders with you and nobody
  else's** (`shares.cancelTheirReminders`, through `reminders.cancelReminder`
  so queued rungs are withdrawn too), and when SOMEBODY ELSE took you off you
  are told — one `share_reminder_dropped` row, sent only when a reminder
  actually went down, never when you left of your own accord (owner's
  decision: "מתבטלת ואומרים לו").

- **A repeating reminder arrives on a quiet day unless its rule pins NOTHING —
  and the only rule that pins nothing is a bare `weekly`**
  (`reminders.movesOffQuietDay`). The owner's rule took two passes, and the
  second is the one in force. The first was "a repeat that is not specifically
  for Saturday should not arrive on one"; he then read it against his own list
  and carved out both shapes that were in it — "כל יום ב7 צריך להיות כולל שבת
  (כי זה יכול להיות תרופה או משהו חשוב)" and "כנ״ל כל ה16 בחודש שאם זה נופל על
  שבת שיהיה על שבת". His two live `daily` rows are a thyroid pill and a refund
  run, and his `monthly:16` is another pill: **a routine set for every day, or
  for a date, is a commitment, and a quiet day is not a reason to break it.**
  So `daily`, `weekly:SA`, `monthly:16` and `monthly:last` all arrive where
  they land; only "כל שבוע", whose day is a coincidence of when it was said,
  moves. **There is no column that separates a pill from a nag** — `nudge` is
  false on every live repeating row and `due_at` is null on six of the seven —
  so the shape of the rule is the only honest signal and this is where it
  stops. That is also why the tool schema tells the model to put a weekday
  they NAMED into the rule and not only into `remind_at`: naming Saturday is
  the only way to keep it. **The decision is made at SPAWN, never at the gate**
  (`quiet-facts.keptMomentFor`, from `sweeps.sweepReminders` and from
  `reminders.setReminder` for the first occurrence) — the gate's order is
  paused → eval → EXPIRY → … → quiet day, and a repeating reminder is always
  rung 1, whose row expires at `remind_at + 2h`: a hold over Shabbat comes back
  on Sunday morning, meets the expiry check first and DELETES the message. It
  is a shift and never a skip, it keeps the same LOCAL hour, and it walks a day
  at a time so a run of two or eight is crossed whole. **A ONE-OFF is never
  moved**: "תזכירי לי בשבת ב-10" is a single moment they chose with that day in
  front of them, and the gate's standing exemption for rung 1 of an asked-for
  reminder (`gate.askedForInWords`) is narrowed by exactly one rule shape.
  A bare `weekly` MIGRATES when it moves, because its successor is seven days
  after the stored moment; that was put to the owner against pinning the day
  and against skipping, and chosen. In the sweep the branch is reached only
  when the world changed under a standing reminder — they added a quiet day, or
  a yom tov landed on their weekday — because a weekly returns to the same
  weekday for ever. The predicate is `gate.quietDayReason` itself, which moved
  to `domain/quiet-facts.js` so the schedule and the gate cannot hold two
  opinions; for an Israeli zone that means the edge is candle-lighting to
  havdalah, so a Saturday evening past havdalah is an ordinary evening to both.

- **A repeating reminder with an END is a CHASE, and every reader that took
  "repeating" to mean "a rhythm" had to be told the difference** (migration
  081, `reminders.isChase`). חיים asked to be helped until a camera was at the
  repair shop "עד שבוע הבא"; he got one reminder the evening before the
  deadline and, because the hour on it was one the model had invented, a 👍 and
  no words (`incidents.md`, "A week of help, delivered as one reminder the
  night before"). No correct expression of his ask existed: `repeat_rule:
  'daily'` never ends, `tasks.completeTask` refuses to close a task carrying a
  repeating reminder so "עשיתי" would have left it running, and `nudge:true`
  is three rungs in one evening. `task_reminders.repeat_until` is the
  discriminator and `repeat_seq` says which occurrence a row is — NULL is the
  cadence every existing rule describes (a pill at seven, the 16th of the
  month), set is a chase that ends at the deadline and ends on "done".
  **The end is EXPLICIT and never inferred from `due_at`**: user 16's monthly
  pill carries a vestigial one, and inferring would have silently ended a
  medication reminder. Four readers now ask for `repeat_until IS NULL` before
  treating a repeat as standing — `completeTask`, the overdue detector in
  `task-suggestions.js`, the expired-events sweep, and `reminders.ridesDigest`,
  which hands a dateless nudge to the morning digest and must not hand over a
  chase that has a deadline of its own.

- **The owner decided the four things about a chase that no reading of the code
  could settle** (2026-09-22), and each is one line in
  `reminders.startChase`. **The day they ASK counts**: if the morning hour has
  gone, the first one goes that evening (`reminders.CHASE_EVENING_AT`, inside
  their window), as `repeat_seq = 0` — "day zero" — and the series re-anchors
  to the morning hour the next day, because a chase that inherited 19:00 from
  the exception would be a different promise from the one it made; day zero's
  successor is numbered 2, since day zero and occurrence 1 are both "the first
  message". **The hour is the one they ALREADY hear from Olma**
  (`reminders.chaseHour`): the earliest morning digest, failing that the start
  of their availability window, failing both 09:00 — the same question the
  dateless nudge on their own page answers the same way, and never a constant
  we picked. **A quiet day is SKIPPED**, which is what `movesOffQuietDay`
  returning true means for a daily rule — nobody takes a camera to a repair
  shop on Saturday, and the series comes back on Sunday without making the day
  up. **And "עד ש…" plus a request for help is what arms one**, not an explicit
  "כל יום": his sentence has no "כל יום" in it anywhere.

- **A chase is the one arming whose SHAPE is news, whoever picked the hour.**
  A 👍 cannot carry a cadence, so `hints.reminders` takes a third branch asking
  for one short line — the first hour, the last day, and nothing in between,
  because the days between are what the messages themselves will say — and
  `list-block` renders "כל יום עד 28.9" rather than a bare "כל יום", since a
  line saying only "every day" about something with an end is a promise to
  keep going for ever. **`hints.chaseAvailable` is the question nobody asked
  him**: on a turn that arms exactly one reminder for a deadline more than two
  days out, the result asks whether their words wanted help until it is done.
  Measured on the box before it was written — 24 of 227 live tasks carry a
  deadline that far ahead, so "לאסוף את הילדים מחר" never sees it. It is a
  QUESTION about their words and never an instruction to write, because the
  whole answer may be a second tool call and then silence.

- **The second call echoes the moment already armed, and that is not an hour
  anybody named** (2026-09-23, the eval's first real night). Asked by
  `chaseAvailable` for `set_task_reminder(task_id, remind_at, nudge:true)`, the
  model passes back the automatic reminder's own moment — on the deadline day —
  and `startChase` took it as the first occurrence, found no room for a second,
  and fell through to a one-off while the reply promised "every day"
  (`incidents.md`, "A week of help, delivered as one reminder the night
  before"). So `at` within a minute of this person's pending AUTOMATIC reminder
  on the task means no hour was named; **a chase cancels every pending automatic
  row inside its span**, not only one on the same local day, because it already
  speaks on the due day; and **`set_task_reminder(nudge)` says on its result
  which branch it took** (`hints.chase`) — a result silent about the shape leaves
  the hint that described the OTHER branch as the model's only account of it.

- **Whether a message ASKED for a chase is read by code, and the model is only
  told what the server will do** (2026-09-24, the owner's call after six red
  samples in a row). The model read חיים's sentence two ways — it dated "take
  the camera in" for tomorrow and armed one reminder — and no hint could settle
  which reading was right, because both were reasonable. So the gateway hook
  (`olma-turn-open`, `chaseDeadline`) reads a request for help plus "עד" plus a
  horizon, and sends a KIND (`next_week`, `weekday`, `date`, …) and whether a
  clock hour was said, never the words; `domain/chase-deadline` resolves it
  against THEIR clock at the moment the message arrived (an Israeli week starts
  on Sunday, so "שבוע הבא" said on a Tuesday is the coming Sunday); and
  `add_task` on that turn is due THAT day with `nudge` on, whatever date the
  model gave it, while an hour survives only if they named one. A task already
  on their list is chased the same way through `set_task_reminder` (`startChase`'s
  `until`). **Measured before it was written**: of 861 real inbound messages,
  112 ask for something, 10 say "עד", and ONE does both — his. The nine others
  are hour ranges, trips and shifts, and they are the test's negatives. **Three
  shapes are refused on purpose**: a bare number after "עד" (an hour range), a
  dotted date with no year ("עד 8.10" is a time), and a message naming a
  DIFFERENT day for the reminder ("תזכיר לי מחר להגיש עד סוף השבוע" is one
  reminder with a deadline) unless it also says "כל יום". **The verdict is
  spent once and dies after fifteen minutes** (`chaseDeadline.pending`): the
  shim keeps one turn object for hours, and a chase nobody used must not wait
  there for the next task somebody saves about something else. **The hook is
  read at gateway STARTUP** — until a restart this is live code and inert, like
  `thanksOnly`. The eval harness reads the same three verdicts with the same
  functions and sends them, because the CLI fires no hook and the eval was
  otherwise measuring a reading production no longer asks the model for.
