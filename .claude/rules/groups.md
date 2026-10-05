---
paths:
  - "olma2/src/domain/group-connections.js"
  - "olma2/src/domain/group-context.js"
  - "olma2/src/domain/group-meetings.js"
  - "olma2/src/domain/group-outbox.js"
  - "olma2/src/domain/group-turn.js"
  - "olma2/src/domain/groups.js"
  - "olma2/src/jobs/groups.js"
  - "olma2/src/adapters/mcp/tools/group.js"
  - "olma2/src/domain/message-templates.js"
  - "olma2/src/adapters/http/admin/sections/groups.js"
---

# In a group

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "In a group" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

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

- **A room's first sentence waits out the channel restart its own registration
  caused.** Registering a group writes
  `channels.whatsapp.accounts.default.groups.<jid>` — the hot write that makes
  the route load — and that restarts the WhatsApp channel: ~5s by the note at
  `provision-group.admitRegisteredGroup`, 16s measured on 2026-09-11 from the
  write to the channel listening again. The sweep decides the greeting in the
  same pass and `group_outbox` drains ten seconds later, so the greeting went
  into the restart EVERY time, not on an unlucky one. **`saveConfig` stamps a
  write that changed the `channels.whatsapp` subtree** (compared against what
  is on DISK — a caller that believes it changed nothing is the caller that
  would forget to say so), and `drainOnce` says nothing for
  `CHANNEL_RESTART_GRACE_MS` (45s) after that stamp. A held row is not claimed,
  spends no attempt, and is still `pending()` for the gate sweep. **The stamp's
  worth is its precision** — an agents-only write restarts nothing and must not
  hold the room's lines — so `tests/group-config.test.js` asserts both
  directions, and the founding case in `tests/group-sweep.test.js` takes its
  stamp from the sweep's own real write, never by hand. **What is NOT fixed is
  why a refusal becomes a duplicate at all**: the gateway answered
  `PlatformMessageNotDispatched`, kept the message, and delivered it a second
  later anyway, while `channels/openclaw.js` still reads that answer as a
  definite non-delivery. The person queue has no hold of any kind
  (`incidents.md`, "The room was greeted twice, by its own registration").

- **Registering a room writes the sender list in the SAME save, and nothing
  else about the list is batched** (2026-09-30;
  `provision-group.admitRegisteredGroup({ senders })`). `groupAllowFrom` sits
  under `channels.whatsapp`, so every change to it restarts the channel
  (10-14s). Registration was two restarts eleven seconds apart, and now it is
  one. `provisionGroup` carries the list only when its own admit wrote under
  `channels.whatsapp`: added to a save that restarts nothing, the list would
  itself be the restart. **A five-minute window for additions was built and
  dropped the same day, on the owner's call.** The gateway blocks a tag from a
  number not on the list, so that tag is LOST, not delayed. A restart only
  delays sends, and the outbox waits it out (`incidents.md`, "Four channel
  restarts for one room").

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
  **Ask `isConnected`, never a second copy of it.** Two other readers had
  written the pair out by hand as `last_inbound_at` alone and were never
  revisited when the gate changed: `group-meetings.coordinatingMembers` left
  the organic joiner out of the coordination their own arrival had opened (and,
  in a room of two, answered "there is nobody else in this group to coordinate
  with" to a room with people in it), and `groups.roomStatus` handed the MODEL
  `wroteToHer: false` about somebody who had written — a false sentence about a
  named person, ready to be said in front of the room (2026-09-19,
  `incidents.md`, "The room coordinated without the person who opened it"). The
  comment above the first one asserted it was "exactly" the gate's condition.

- **The roster's digits may be a LID, and the gateway's own reverse map is the
  only way back to a number.** `chat_group_members.phone` holds whatever the
  inbound envelope's `group_members` said, with no JID on it, so a member
  addressed by LID is indistinguishable from one addressed by phone and resolves
  to no user — which is why a room could count somebody missing for ever who had
  written to Olma that morning. `channels/sessions.lidPhoneNumbers` reads
  `credentials/whatsapp/<account>/lid-mapping-<digits>_reverse.json` (the
  gateway writes one the moment it first resolves a LID), the sweep reads it
  through the worker facade, cached until a directory under
  `credentials/whatsapp/` changes or five minutes pass (2026-09-30: 2,678 files,
  83-95ms a read, every ten seconds), and the pure
  `groups.resolveLidMembers(members, map)` rewrites the roster before
  `registerGroup`/`syncRoster` see it, returning `{ members, resolved }` so the
  caller never re-derives the predicate. **Three directions are load-bearing.**
  A map of `{}` — which is also what an unreadable credentials directory
  answers — changes nothing, because a roster quietly emptied of its LID rows
  reads as every one of those members leaving the room. An unresolvable LID is
  never DROPPED: they are still somebody in the room and the gate is entitled to
  keep counting them missing. And a LID resolving onto a number already in the
  roster collapses into ONE member through `dedupe`, never a second row for one
  person. `syncRoster` then does the rest on its own: the LID row gets `left_at`,
  the phone row joins and resolves to the user, and who was here stays history.

- **The sweep judges a ROOM once per pass, off its NEWEST context, and keeps
  a watermark per SESSION** (2026-09-30, `jobs/groups.sweepGroups`). An open
  room has two gateway sessions, and the greeter's context stops moving the
  moment the room opens: hours to 18 days old on the box. Walked per session,
  that roster was synced and judged first on every pass. It can put a member
  who left back in the room for one iteration, and with
  `group_open_without_everyone` closed it re-locks the room and deletes its
  agent. So the sessions are grouped by jid and the context with the newest
  `at` wins, ties to the later session. **Do not collapse the watermarks with
  them.** `seenAt`/`noteSeen` stay keyed on each session (migration 059),
  because one column shared by several sessions is the fault that migration
  fixed. A tag is any session newer than its own mark (`incidents.md`, "Every
  open room was judged twice, once on a stale roster").

- **A room opens on TWO connected members, not on everybody — and it still
  says who is not here.** `group_open_without_everyone` (flag, open by the
  owner's choice 2026-09-22, a bool row on the admin main page) is read by
  `groups.evaluate` and passed into the pure `groups.decideState`, which opens
  a room once `groups.MIN_CONNECTED_TO_OPEN` = 2 members are connected.
  Everybody-or-nobody is what it replaces, and Padel Gang (group 9) is what
  that rule cost: four of its seven members resolved to users who have written to
  her and the other three reached us only as LIDs, which no message of theirs
  turns into a matching phone — so that room can never open, and what it got
  instead was the wait line twice in the twelve minutes after it registered. One
  of those three had in fact written and the gate could not see him, which is a
  SECOND fix and not this one (`channels/sessions.lidToPhone` already reads the
  reverse map; `incidents.md`, "The room that could never open"). **`missing` is unchanged by
  the flag**, and that is the load-bearing half — an open room is not a claim
  that everybody is in it, so `jobs/groups.js` announces `opened` only when
  `!missing.length`, because `group_opened` says "יש! כולם כאן" and that names a
  fact. A room the flag opens opens in SILENCE; the sentence that would be true
  there is the owner's copy to write, and inventing it is how a room gets a line
  nobody chose. **The one line such a room does hear** (owner, 2026-09-26): a
  greeting that goes out while the room is already `open` ends on
  `group_intro_ready` ("אפשר כבר להתחיל…"), read off `chat_groups.state` at
  DELIVERY by `group-outbox.renderRow` — a room open from its first pass heard
  nothing else that said it could begin. **Two is a floor, not a taste call**: `startCoordination`
  refuses a room where the only member it can reach is the one asking, so a room
  opened on one connected member buys an agent that can do nothing. Two things
  the flag does NOT change — `group-meetings.coordinatingMembers` still filters
  on `isConnected`, so a member who never wrote is never swept into a
  coordination and never messaged; and `group-connections.connectRoom` never
  read the state at all, so who is connected to whom is the same with the flag
  open or closed. What it does change, beyond opening: a room with an agent no
  longer RE-LOCKS when a stranger joins, so the newcomer shares a room with a
  live agent from the moment they arrive. They can already read everything said
  there, and no group tool returns anybody's private row (the rule above), which
  is why that was judged acceptable rather than papered over.

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
  started, or up to fifteen minutes BEFORE `meetings.created_at` (owner,
  2026-09-27: "מי שכן כתב בזמן הקרוב הודעות בקבוצה או בפרטי ... היא יודעת
  שהוא ער"). The asking tag is stamped seconds before the tool creates the
  meeting, so "after it started" held the asker's own invite for the night; the
  gate still measures its fifteen minutes from the word, so this is the same
  "wrote recently" a DM passes. `jobs/groups.mayAnnounce` is the second reader, for the reason in
  the daytime rule above: it is the only signal of presence in a room that
  Olma's own sends cannot move. A pause is still read first and absolutely. **The column is blind
  to anything that did not name her** (a registered room is
  `requireMention: true`), so its silence is never evidence that somebody said
  nothing.
  **And a window is only worth what the worker will re-read.** Every
  time-based hold sets `outbox.release_after`, and `worker.drainOnce` does not
  select a row before its own release time — so an exemption living inside
  `decide()` is unreachable for a held row until something clears it. That is
  why `group-context.noteMemberWrote` does BOTH halves on the one stamp: the
  column the gate reads, and a re-hearing of that member's `night` /
  `quiet_day` / `quiet_holiday` rows about a coordination THIS room is running,
  dated by when they wrote so the stamp, the re-hearing and the fifteen minutes
  cannot drift apart. For fifteen days the rule was in the gate, had a test
  file, and had never run once (2026-09-19, `incidents.md`, "The room window
  opened on a row nobody would look at"). `turn.openRecord` is the same move
  for a DM and re-hears `night` alone — a DM at 03:00 is not evidence that
  somebody's Shabbat is over.

- **The room is a second door to every action on its coordination, and it
  acts only as somebody still IN it** (owner, 2026-09-25: "אני רוצה את כל אלה
  שיהיו גם בפרטי וגם בקבוצה"). He asked the room to cancel and was told it
  could only be done privately (`incidents.md`, "The room could not cancel its
  own coordination"). Cancel, rename, take a time off, leave and answer yes/no
  are now room tools, and the chat gained the two the room had first — the
  place (`meetings.setPlace`, the ONE writer of `meetings.location` after a
  coordination opens; the room's tool calls it with `requireIn: false`,
  because any member of the room may say where) and the minimum
  (`set_meeting_minimum` over `meetings.setQuorum`). Three things hold it.
  **Each room tool calls its private twin's domain function and fan-out**,
  never a copy, so a cancel from the room tells the same people the same
  thing and removes the same calendar event. **`groupMeetings.participantFor`
  refuses anybody not still in the coordination** (`reason: 'not_in_it'`) —
  unlike `settle`, which acts through a participant, because a yes, a no and
  an exit are one person's and "anybody in it" is the private rule for the
  rest. **The results are PICKED, never passed through**: the private ones
  carry hints about the person's own calendar and dashboard, and an answer
  given in the room returns that one answer and never the table's — the room
  still hears nobody else's (`tests/group-room-actions.test.js`).
  **…and the way BACK in is the one door `participantFor` cannot guard**,
  because it refuses exactly the person it is for (owner, 2026-10-01; Eden
  left the poker room's coordination, meeting 66, and asked to come back).
  `rejoin_group_coordination` checks the room with
  `groupMeetings.roomMeetingFor`, and `rejoin_meeting` is its private twin;
  both, and the page's archive button, go through `meetings.rejoin` →
  `meetingFanout.afterRejoin`, which is QUIET like the exit it undoes —
  nobody else gets a message, the table and the counts say who is in
  (owner: "חזרה שתהיה שקטה כמו יציאה"). **Only an exit they CHOSE, or one a
  PAUSE made, is undone** (`meetings.LEFT_BY_CHOICE_SQL`: the latest
  `meeting.opted_out` with cause `user_choice`, or `meeting.withdrew`;
  `meetings.leftByPause`: `paused_by_request`/`paused_no_answer`). A pause
  exit is refused while they are still paused, and **is undone on its own
  when the pause ends**: `pause.resumeUser`, `quietResume` and
  `resumeAfterRoomInvite` call `meetings.restorePauseExits`, with the answers
  they had given. Leaving the WhatsApp group and revoking a connection are
  not undone, an `opted_out` row with no exit on record is not, and nobody
  without a participant row is ever added this way. The turn's
  `recentMeetings` says `out` about a coordination they are not in, so she
  never tells somebody they are still in one (`incidents.md`, "Eden could
  not come back", "Eden, kept out by a pause that had ended").
  **…and "away until a date" is NOT leaving** (owner, 2026-10-05).
  `leave_group_coordination` with `until` keeps them in: their words become a
  public constraint with a no-window to that moment (the private side's
  `standing-answers`), every time inside it is a no, including one they had
  said yes to, and later times inside it are answered for them. A settled time
  inside the window is still an exit (`incidents.md`, "Yossi was abroad, and
  was taken out").

- **Somebody a room sent to the greeter hears about that room in the FIRST
  reply, and its coordination follows that same night if they are awake**
  (2026-09-25). The greeter is handed the room by brokerd `intake_context`
  (the intake session key ends in the sender's number) through the plugin, and
  says one fixed line under the opening copy (`domain/intake-room.js`) — the
  "תכף אשלח" shape only where `admitLateMembers` will actually let them in (an
  open room, a coordination negotiating and not in its settle minute), the
  shape that promises nothing everywhere else. **While the room sleeps, only
  somebody who wrote in the last fifteen minutes is let in** — to their own
  agent or to the greeter — marked `quiet` on the admission's audit row, and
  the room's "joined" line about them waits for the room's morning
  (`group-meetings.quietJoinersToAnnounce`). Letting in used to wait for the
  room's hours because it and the line were one step; they are two now, and the
  line is still never said at night (`incidents.md`, "Twice 'היי' before a word
  about the room").
  **Since 2026-09-29 a room with a coordination waiting gets a SHORT opening
  INSTEAD of the owner's, not a line under it** (`intake-room.ROOM_OPENING`):
  "עוזרת AI" on the first line, "שולחת לך עכשיו את התיאום", and the privacy
  link — all a first message legally owes. What she does comes AFTER the
  coordination: their first turn adds one line about it
  (`turn.shortOpeningPending`, `room`), or the welcome follow-up says it the next
  morning (`intake.nextMorning`, `payload.roomOpening`), and the gate's
  `answered_in_turn` drop keeps it to once. `intake-room.saidRoomOpening`
  recognises it by the room line, and it stamps `opening_sent_at` like the
  owner's copy — a newcomer not stamped would have the coordination held
  behind an introduction nobody will send. A coordination that closed while
  the greeter spoke sends the follow-up at once (`incidents.md`, "Three
  messages before the one they came for").
  **"Waiting" is `admitLateMembers`' own question** — negotiating, or settled
  with its start still ahead (`intake-room.roomFor`, 2026-10-03). Reading
  negotiating alone gave הוד the long opening, the follow-up and the settled
  poker inside one minute (`incidents.md`, "Three messages in a minute, to
  somebody a settled room sent").

- **The person who asked the ROOM for a coordination is asked privately too.**
  `startMeeting` inserts every participant at `awaiting`, the initiator
  included, and for a person-to-person coordination the fan-out rightly skips
  them — they are in the conversation where they just said it. A tag in a room
  is the whole request and carries no times, so `startCoordination` sends them
  their own row with `askedItYourself: true`; `channels/openclaw.js` spends the
  flag on a branch that asks the one thing they have not said and tells them
  neither who asked nor anything about in front of everyone. Without it a
  coordination could never settle, and the other members' digests named the
  initiator as the holdup for a question nobody had put to him (2026-09-19,
  `incidents.md`, "The coordination waited on the man who started it"). **The
  test asserted the bug** — `2, 'everybody but the person who asked'` — which is
  one layer out from a wrong comment: a test can be wrong about the world.
  **…and a time said in the room is that person's proposal, put on the table in
  their name from the room** (2026-09-23). The room had no tool that could
  write a time and its doctrine said "never collect times here", so עמית's
  "שישי צהריים" and מירון's "חמישי ערב ושבת ערב" were said in front of
  everyone, the agent was refused on the person's own `propose_meeting_slot`,
  told the room the times were going out privately, and the coordination's
  page showed an empty table. `add_group_coordination_option` goes through
  the same `meetings.proposeSlot` → `meetingFanout.afterOptionAdded` path as
  the private tool, as `actingUser`: `added_by` is them, their yes is
  recorded, the rest are asked privately (folded into an invite that has not
  gone out), and the result carries nobody's answers. It is never the room's
  voice — the time belongs to whoever said it. When the requester named the
  time, `meetingFanout.noteNamedInRoom` stamps `namedInRoom` on their unsent
  invite so it asks only about OTHER times instead of "when suits you". A
  room's AGENTS.md now reaches existing rooms through
  `scripts/resync-agent-templates.js` too; before this it was written once at
  provisioning (`incidents.md`, "The times the room said went nowhere").

- **In the room a person is addressed by their TAG and never by their name; in
  a private chat, by their name** (owner, 2026-09-20). A tag notifies them and
  a name does not, and the name Olma holds is not the one that room shows them
  to each other by. So `groups.roomStatus` and `group-meetings.statusOf` draw
  the tag themselves — `proactive-text.mentionToken`, the one spelling that
  pings — beside every member and every id they name, and
  `group-turn.TAG_RULE` tells a group turn it may address somebody ONLY with a
  tag the block lists: never a name, never a tag it assembled for a person the
  block does not carry. The same rule states the opposite for a DM, because
  `@972…` in somebody's own chat is a phone number where a name belongs. It is
  DRAWN rather than asked for, on the rule one file over
  (`rules/delivering.md`): the fixed lines a room hears have tagged people
  since the start (`proactive-text.mentionTokens`, capped at `MAX_TAGS`), and
  the model's half was the last place a name could still get out.
  **And a tag COMING IN is a member to look up, not a token to discard**
  (2026-09-23). `group-turn.draw` puts `room.people` — every member's `tag`,
  plus the `lid` they are tagged by when the gateway's reverse map knows it —
  in the block on EVERY turn, negotiation or none, and `TAG_RULE` sends her to
  match an incoming `@<digits>` against it. The map is
  `channels/sessions.lidPhoneNumbers` again, read by brokerd through the worker
  facade and injectable so no test reaches the live gateway; an empty or
  unreadable one costs the `lid` fields and nothing else, the same direction
  `groups.resolveLidMembers` takes. **This rule has now been wrong in both
  directions** — it used to say every `@<digits>` in an incoming message was
  the sender tagging HER, written when she echoed her own LID as if it were
  Yuval's, and that reading made a real member's tag "nobody's": Miron tagged
  Yuval to ask him to book a court and she told the room she did not recognise
  the id, three hours after tagging that same man in her own "בפנים" line
  (`incidents.md`, "The room that did not know its own member"). A token
  matching nobody is ignored in SILENCE — her own trouble identifying one is
  not the room's business, and the owner's two acceptable answers were to stay
  out of it or to back the request, never to narrate the confusion.
  **…and since 2026-09-23 a name she KNOWS may be said, with the form of
  address they set** (owner: "אם היא יודעת את השם שלהם ואיזה לשון לדבר אליהם
  … היא כן יכולה לשלוף רק את המידע הזה"). The same afternoon she called Bar
  "את" to his face and "היא" about him, in front of the room: nothing in the
  block said how to address anybody, and the room's doctrine had no default.
  `group-turn.peopleOf` now adds two fields from the person's own record and
  no others. `name` is a first name they CONFIRMED (`users.name_confirmed`),
  because an unconfirmed one came from WhatsApp or a guess, and that is the
  "M&M" mistake this rule was written for. `address` is `users.gender` from
  their own page, failing that the `gender_forms` preference their private
  agent stored when they said it in words (`group-turn.addressOf`: both
  readings or neither is null). The tag is still how somebody is REACHED;
  the name is what a sentence may call them. **No `address` means masculine
  forms**, the private doctrine's own default, never a guess from the name,
  which is what "בר" got. `groups.listMembers` carries the three columns.
  `groups.roomStatus` and `group-meetings.statusOf` are unchanged: the turn
  block is what she speaks from (`incidents.md`, "She called Bar את").
  **…and what somebody says about THEMSELVES in the room is kept**
  (owner, 2026-09-23). Amit told her "אני גבר ואת אמורה לדעת את זה עליי". She
  apologised and nothing was written, so the next turn would have drawn him
  with no `address` again. `remember_sender_gender` (a group tool) writes
  `users.gender` through `users.setPersonal`, the same column and function
  the profile page uses. It writes only for the SENDER: `actingUser` is chosen
  by the server, so nobody can set another member's form from the room. It is
  in `user-card.CARD_TOOLS`, so their private USER.md is re-rendered after
  commit. A group call never sets brokerd's `actorId`, so it carries its own
  `groupCardUserId` for exactly this one purpose. Anything but `male`/`female`
  is refused, not interpreted.
  **…and the two records of it agree, whichever side moved** (owner, same day).
  `users.gender` (the page, the room) and the `gender_forms` preference (the
  private chat's turn_start) had drifted: Maya's said "נשי" with no column,
  and the private reader's regex did not even know that word. Both now read
  through `domain/gender-forms.genderFromWords`, and each writer moves the
  other: `users.setPersonal` rewrites a preference that contradicts the
  column (words that already agree are left as they said them; a cleared
  column deletes it), and `preferences.remember`/`forget` of `gender_forms`
  call `setPersonal` when the words are unambiguous and disagree. The second
  write finds them agreeing, so they cannot bounce.

- **The first thing a room hears about its own coordination is that she has
  STARTED, and it counts people rather than naming them** (owner, 2026-09-22:
  "תכתוב בקבוצה שאתה מתחיל בתיאום בפרטי עם מי שכתב לה"). `group_coord_started`,
  decided first in `group-voice.decideGroupLine`'s negotiating branch, stamped on
  `meetings.group_started_at` (migration 080) like every other line in that
  family so a line held for the night goes out in the morning and never twice.
  Before it, the room's first word was `base` — which waits for two people to
  agree on a time, hours later — so a room that had just asked her for something
  heard nothing at all. `co.participants` is who she is actually asking.
  **Since 2026-09-26 it is the ONLY opening the room hears, and it is true at
  the hour it is said** (owner, fix 4): the start tool's `hints.room` and the
  group doctrine tell the model NO_REPLY (her "על זה" was the same sentence
  twice), and outside the room's `GROUP_WINDOW` the line carries `later` and
  says "שואלת בפרטי את מי שער עכשיו, ואת השאר בבוקר" — at night only whoever
  wrote in the last fifteen minutes (room or DM) is asked now (owner,
  2026-09-27).
  **Since 2026-09-26 the number it SAYS is the whole room** (`co.roomTotal`,
  "לכל N חברי הקבוצה") — see "A room's coordination counts everybody in the
  room" below.
  **Since 2026-09-25 it TAGS the members she could not sweep in**
  (`co.outsidePhones`, `group_coord_outside` / `_many`; owner: "לתייג אותם
  בשורת הפתיחה"). Until then it carried only a count ("somebody here is not
  counted"), on the reasoning that who they are was the gate notice's own
  sentence, but an OPEN room says no gate notice, and in פנתרה the one member
  who had never written heard a count that pinged nobody. A LID tags nobody, so
  a room whose missing members are all LIDs still hears the count line. Tagged,
  never named: the tag-not-name rule below holds here too.
  **And the tag's promise is kept**: `group-meetings.admitLateMembers`, run by
  `sweepGroupVoice` in the room's daytime, lets anybody the gate now counts as
  connected into a negotiating coordination they have NO participant row in,
  with the same invite everybody got (as the whole table when there is one),
  keyed `minvite:<meeting>` so nobody is invited twice. The room hears
  `group_coord_joined` once per admission ("הצטרף/הצטרפה/הצטרפו", masculine when
  they set nothing), as that pass's one line, and only after the opening has
  gone out; before it, the opening simply counts them. Somebody who LEFT has an
  `opted_out` row and is never swept back in, a paused member whose room invite
  is spent is left out as `startCoordination` leaves them out, and nobody is
  let in during the settle minute. **A coordination SETTLED but still ahead
  lets them in too** (owner, same day): they get `meeting_confirmed` with
  `joinedLate` (the time in their own clock, can they make it, the calendar
  step), never a "confirmed by every participant" they were not part of; one
  that has already happened lets nobody in (`incidents.md`, "פנתרה: one time,
  four clocks").

- **A tag is a NUMBER, and the roster hands us LIDs in the same column** (owner,
  2026-09-22). `chat_group_members.phone` holds a WhatsApp LID for members the
  gateway only ever named that way: the roster is the envelope's
  `group_members`, a list of digits with no JID on it, so nothing downstream can
  see which is which. `proactive-text.isTaggableNumber` cuts at 13 digits — the
  box's own numbers: 2,673 LID keys run 12-15 digits, 5,346 real numbers stop at
  13, so nothing 14 or longer has ever been a number here and no real member is
  silenced. `mentionToken` answers `null` and `mentionTokens` filters before
  `MAX_TAGS`, so the overflow count counts people.
  **…and since 2026-09-24 the SHAPE is asked as well, which halves what the
  length alone could reach** (`phone-timezone.phoneShape`, `isRealPhone`). The
  length cut is blind inside its own window by construction, so the dialling
  code is asked too: a country the table knows, at a length that country
  issues, is a `'phone'`; one at a length it does not is `'not_phone'`; a code
  the table has never heard of is `'unknown'`, the honest third state again.
  `isTaggableNumber` consults it ONLY as a refusal — `'unknown'` keeps exactly
  the old behaviour, because refusing it would silence a member from an
  unlisted country to make a LID lose a tag. Measured on the gateway's own
  reverse map the day it was written, 2,673 real LIDs: 1,654 `'not_phone'`,
  1,013 `'unknown'`, **6 `'phone'`** (0.22%, all in the four countries whose two
  mobile lengths are both carried), and of the 95 that used to pass the length
  cut, **44 now do not**. In the other direction, the one that must never be
  wrong, all 34 real numbers on the box answered `'phone'`. The lengths live as
  a `len` field on the `PREFIXES` rows that already carry the timezone guess, so
  there is one row per country to keep right rather than a second table.
  **It is a filter, not a guarantee** — 51 LIDs still pass, 45 `'unknown'` and
  the 6 — so never read a rendered tag list as
  "everybody who is missing"; the airtight answer is upstream. **And a line whose
  whole content is tags is not said when it can name nobody**: the gate notice
  is skipped, uncounted and unstamped rather than going out as
  `עוד מחכה ל:  🧐`, which costs the owner's "every tag gets an answer" and is
  left as a cost, because the sentence for a room waiting on somebody we cannot
  name is his to write (`incidents.md`, "The room asked three numbers that were
  nobody").
  **REVERSED 2026-09-27: a LID IS a tag.** The owner went back to Padel Gang's
  own messages — 22/09 12:49, 22/09 12:57, 26/09 21:00 — and every `@+<lid>`
  in them, 13, 14 and 15 digits, had arrived as a blue name. The gateway's
  `resolveWhatsAppOutboundMentions` looks `@+digits` up by phone and then by
  LID among the room's participants, so the premise above was never true.
  `isTaggableNumber` is now digits-only, 7-15 long, with no shape refusal;
  everything above this paragraph is the history of a cut that should not have
  been made. `isRealPhone` still answers "can we WRITE to this" and is
  unchanged — a LID still never becomes a `users` row.

- **A number on the roster becomes a `users` row, and a row is not a person who
  has met her** (owner, 2026-09-25: "ליצור משתמש ממספר טלפון שראינו ברשימת חברים
  של קבוצה"). `groups.ensureRosterUsers` runs on every pass of the group sweep,
  behind `group_roster_users`, closed by default, and mints `status = 'pending'`
  with `agent_id`/`workspace_path`/`onboarded_at` NULL and a timezone off the
  dialling code — never NULL, the rule that outranks everything here. The row
  exists so a room's coordination can know somebody is there; it is not an
  introduction, and `isConnected` is untouched, so the gate, the quorum,
  `decideState.missing` and `MIN_CONNECTED_TO_OPEN` all answer exactly as before.
  **A LID never becomes one, and `'unknown'` is refused as firmly as
  `'not_phone'`** (`phone-timezone.isRealPhone`, the rule above): `users.phone` is
  `NOT NULL UNIQUE` and feeds `user_channels.channel_identifier`, 41 foreign keys
  point at `users.id` across 36 tables, **there is no merge primitive anywhere in
  this codebase** for the day a LID turns out to be a number we already hold, and
  a queued message to a non-dialable target retries every ten minutes for ever
  because `outbox/worker`'s backoff caps there. The cost of refusing is only
  delay — the gateway writes the reverse-map file the second it first resolves a
  LID, and `resolveLidMembers` runs on the pass before this one.
  **`status = 'pending'` is now a question six readers ask**, because every one of
  them used to read "there is a row" as "this is one of ours": `outbox/gate`
  drops such a row as `pending_user` save `PENDING_USER_KINDS` — the stranger
  intro and the waitlist notice, the two things addressed to exactly such a
  person, both delivered through the intake session (an explicit `true` drops,
  never `undefined`); `connections.requestConnection` reads `targetKnown` off it,
  so a stranger still gets the introduction instead of "X wants to connect with
  you" spoken by the greeter; `group-connections.connectRoom` joins `users`,
  which restores line 1 of its own header and closes the same hole for the
  invited-stranger row that predates this; `registerGroup` refuses a room whose
  only "user" is a roster row, and never registers one in its name;
  `syncRoster`'s timezone vote skips them, because the room's zone is the room's
  quiet hours and three numbers nobody has spoken to must not outvote the person
  in the room; and `config_guard.checkUnansweredStrangers` stops counting a row
  as a record, or it would go quiet for exactly the person it exists to find.
  The growth count on the admin home page asks too (measured: not one `pending`
  row existed and the figures were 3/9/21 either way). `createUser` takes an
  `audit` override for the same reason — `jobs/metrics.users_provisioned` and
  `active_users` read that row, not the table — and the summary row's actor is
  `null`, because nobody did this.

- **Every line a room hears is said once, except the TABLE moving, which is
  news every time** (migration 084, `meetings.group_table_at`; owner,
  2026-09-22). מירון's padel room was told she had started and that there was
  a direction, and then heard nothing all afternoon while שבת 16:00 came off,
  three times went on and two people turned Wednesday down. So that one line
  is a WATERMARK rather than a flag — the moment the room was last told what
  is on the table, against every change to any option (`created_at` for one
  added, `decided_at` for one removed). **The watermark is the BASE line
  and never the started line**: the first time somebody puts a time up, the
  table is being LAID, not moving, and the first cut of this said "השולחן זז —
  עכשיו מועד אחד" about it until `tests/group-voice.test.js` refused. It says
  the SHAPE only — how many times are on the table, which is furthest along —
  because whose answer is whose is still nobody else's to hear. Its
  idempotency key carries the change's own timestamp, so one line per
  movement and a re-run of the pass collapses onto it.

- **…and it waits a quarter of an hour, so a burst of changes is ONE sentence**
  (`group-voice.TABLE_SETTLE_MS`, owner 2026-09-22: the room should wait before
  it announces a change, so that changes which overlap in that time do not each
  get their own message). The same fifteen minutes as the private side's
  `meeting-fanout.PACE_MS`, off the same afternoon: מירון's table moved at
  16:14, 16:22, 16:23 and 16:25, and `group_voice` runs every sixty seconds, so
  an ungated line is the private complaint said out loud in the room. **The
  clock starts at the FIRST change the room has not heard about, never at the
  newest** — waiting for the table to go QUIET reads better and starves, since a
  room that keeps adding times would never be told anything at all. It gates
  BOTH lines about the table moving, `table` and `moved`: a time deleted and
  replaced thirty seconds later is one thing that happened, and said at once it
  is "שבת 16:00 כבר לא על השולחן" followed a minute later by the table having
  moved again. Nothing else waits — "she has started" is the line whose whole
  value is being early, and a base, a chase and a "סגור" are each said once.
  **The stamp is the clock the DECISION was made on and never SQL's `now()`**:
  two of those columns are read back as moments rather than flags, so a stamp
  from a different clock is a quarter of an hour that measures nothing.
- **A table of TWO or more times that nobody has a direction on is LAID once —
  the room hears which times are on it** (2026-09-28, `group-voice.decideGroupLine`
  kind `laid`, template `group_coord_laid`). The base line speaks only when a
  time has a direction and the table line only after a base, so coordination
  57's Monday, Tuesday and Thursday — one yes each, from whoever put it up —
  reached the room as nothing for a day and a half. Same quarter-hour settle as
  the table line, counted from the first time that went on; stamped on
  `group_table_at`, which makes it the watermark every later `table` line reads.
  Never after a reopening, which carries on from where it stopped. **One time
  is still not laid**: one person agreeing with themselves is not
  news (the owner's rule the base tests pin), and a choice nobody has made is.
  Only the shape — which times — never who said yes (`incidents.md`, "The room
  never heard the times").

- **The room is chased an HOUR after she starts, not half way to the thing**
  (`group-voice.CHASE_AFTER_MS`). Half the distance, clamped to [1h, 24h],
  put מירון's room at 05:11 the next morning with the night in front of it,
  because the earliest option was twenty-six hours out. `Math.min` keeps the
  old instinct as a ceiling rather than a formula: a game in ninety minutes is
  still chased in forty-five. Who may be NAMED is unchanged and was re-checked
  on this room — גל had been written to four times and not answered, so he is
  nameable; גיא had every message dropped at the gate as `quiet`, was never
  actually asked, and must not be.
  **…and the hour is counted from the LAST invite that reached anybody, not
  from the start** (2026-09-28, `statusOf.lastAskedAt` → `group-voice.decideGroupLine`).
  Coordination 57 opened at 21:00, every invite but the asker's waited for the
  morning, and the chase went out at 09:00:08 — two minutes before them — and
  tagged the one person it could name: the man who had asked for the game and
  answered it in the room. `lastAskedAt` is the newest FIRST arrival of a
  `meeting_*` row among the people still in it (sent, and not held); a row the
  gate dropped reached nobody and does not count. Nobody reached at all falls
  back to the start (`incidents.md`, "The chase that beat its own invites").
- **A room one yes short of its number hears it ONCE** (owner, 2026-10-02;
  `group-voice.decideGroupLine` kind `almost`, `meetings.group_almost_at`,
  migration 106, template `group_coord_almost`). The base line waits for the
  minimum itself, so four of five in the poker room was a day of silence. Only
  where the room SAID its number (NULL never acts) and only from three up (at
  two the one yes is the proposer's). It waits for the chase's hour when there is
  no chase, and an hour after the chase when there was one: both tag the same
  people. It tags who has not answered THAT time, never who said no
  (`incidents.md`, "Four out of five, and the room heard nothing").

- **The "סגור" line names who can make it, a calendar line is said only for
  a SHARED event, and a base line is never said to nobody** (owner,
  2026-09-20, off coordinations 35–37). `group-meetings.statusOf` exposes
  `confirmedOption` (the active option whose text is `confirmed_slot` —
  `options.add` refuses a duplicate text, so it is a key) plus
  `settleDueAt` and `calendarEventId`; `group-voice.whoIsIn` turns its
  `yes` into "כולם בפנים" when everybody still in said yes, or the tags of
  those who did, and the `group_coord_done` template carries it as `{{who}}`
  — a whole phrase, so a rewording can move or drop it, and null draws
  nothing rather than a guess. **`group_coord_calendar` fires once, after
  the done line, and only when `meetings.calendar_event_id` is set** —
  nothing but `calendar.createSharedMeetingEvent` writes that column, and a
  solo event on one person's calendar is not a thing the room may be told
  about; the line says who got an invitation (whoever connected a calendar),
  never "everybody", because in 35 that was one person. Stamp
  `group_calendar_at` (migration 076). **Since 2026-09-26 a close is ONE
  message when it can be** (owner, fix 7: it was heard three times — her
  reply, the done line, the calendar line): an event that already exists as
  the done line is decided rides it (`line.calendar`, both stamps), and
  `group-meetings.settle` hands the model `hints.room` saying the fixed line
  is the announcement and to answer NO_REPLY. **The event is made AFTER the
  close, by the organiser's agent, so since 2026-10-05 the done line WAITS for
  it** (`jobs/groups.calendarPending`): while `meetingCalendarRoles.shared`
  says one is coming and the close is under `group-voice.CALENDAR_WAIT_MS` old.
  Past that it goes without, and the separate line is the fallback.
  **And no base line when nobody is
  missing or `settle_due_at` is armed** — "מחכה ל 🤞" went out with an
  empty list twelve seconds after Yuval's yes made it unanimous; the next
  thing that room should hear is "סגור". `TAG_RULE` also says now that the
  `@<digits>` in the message she received is the sender tagging HER — she
  echoed her own LID as if it were Yuval's (`incidents.md`, "The room waited
  for nobody").
  **Since 2026-10-03 the place rides it too, and no reminder repeats it**
  (owner, the poker room: "כן תסגרי ותוסיפי שהמשחק אצל שמר" was heard as her
  "noted", then "סגור", then "מזכירה — היום" a minute later). The done line
  carries `place` (`co.location`, `{{place}}` in `group_coord_done`, appended
  when a rewording lacks it), and `set_group_coordination_place` answers
  NO_REPLY when the meeting is confirmed and `group_done_at` is still empty
  (`closeLineCarriesIt`). `decideLine` reads `doneSaidAtMs`: no day-of line on
  the local day the close was said, no hour-before when the close was said
  inside that hour.

- **A time the room was TOLD about and that has since left the table is said
  again; a time merely overtaken is not** (owner, 2026-09-22: "יש אנשים
  שסימנו אותו ועכשיו הוא לא רלוונטי"). `group_base_at` says the line was said
  and cannot say WHICH time it said, so Padel Gang held שבת 16:00 for the rest
  of its coordination — eleven minutes after Sharon deleted it and put 17:00 on
  the table, with two people's yes on the time she removed. `meetings.
  group_base_slot` (migration 082) is the slot text the room actually heard,
  and `group-voice.decideGroupLine`'s `namedGone` is the whole trigger: that
  slot is no longer among the active options AND another one leads. **"The
  same slot" is the same MOMENT** (`meetings.group_base_start_at`, migration
  097): a time deleted and put back in other words is still on the table, and
  the words decide only where there is no instant to compare. **Three
  things it deliberately is not.** A new leading time with the old one still on
  the table says NOTHING — the room's picture is still true, and a line per
  change of lead is how this family of lines becomes the thing the owner asked
  it never to be. Nothing is said until a replacement has `enough` — the stamp
  goes on naming the gone slot, so the line simply waits and goes out with a
  direction rather than announcing a hole. And it is not once per
  coordination: the `group_outbox` key carries the time that WENT
  (`g<gid>:m<mid>:moved:<was>`), so a second named time leaving the table is a
  second line and the same one is never said twice. `group_coord_moved` carries
  the new direction as `{{lead}}`, rendered from `group_coord_base` itself, so
  the owner rewords "יש כיוון" in one place (`incidents.md`, "The room held a
  time that no longer existed").

- **The place is the room's own words, asked for only when nobody said one,
  and it rides the confirmation onto the calendar event** (owner,
  2026-09-20; `meetings.location`, migration 077). "פוקר אצל יוסי" carries
  its place and nothing could read it back out. `start_group_coordination`
  takes `where` — ONLY when the room said one, never guessed — and
  `set_group_coordination_place` saves it later in any message; both go
  through `meetings.cleanLocation` (trimmed, 120 chars, never parsed). The
  done line carries `{{place_ask}}` when `location` is NULL and nothing
  otherwise. `meetingBrief` puts `location` on the `meeting_confirmed`
  payload and `meetingCalendarStep` passes it to
  `create_shared_meeting_event`/`create_calendar_event` fenced as data; a
  place said AFTER the event exists reaches it through `calendar.updateEvent`
  as the organiser, since the event is on their calendar. Until untagged room
  messages reach her (PR #429), the answer to "איפה נפגשים?" still needs a
  tag (`incidents.md`, "The place nobody asked for").
  **…and a name that says it happens ON Zoom has said where** (owner,
  2026-09-23: "פוקר בזום" was confirmed and the room was asked where to meet).
  `online-place.onlinePlace` reads a CLOSED list of platforms as whole words,
  with the ב/ל/ה prefix a place takes, and returns the word as written.
  `meetings.startMeeting` stores it as `location` when nobody passed one, so it
  reaches the calendar event too. `group-voice.decideGroupLine` also reads the
  title and the confirmed slot, for coordinations opened before that. It is
  code on purpose: no model decides it. "וידאו" alone, a bare "meet" and
  "teams" stay off the list, because a false hit tells a room nobody needs to
  know where they are going (`incidents.md`, "Where do we meet, on Zoom").

- **A coordination that settles with no exact hour asks for one ONCE — the
  room on its "סגור" line, a private one only ONE person — and anybody in it
  may fill it in** (owner, 2026-09-24; migrations 087/088). "No exact hour"
  is `meetings.timeIsOpen`: a whole day or a part of one, all-day included by
  the owner's choice. In a room, `decideGroupLine` puts `timeAsk` on the done
  line — ONE sentence with the place question when both are open, never two
  questions in a row — and it is once because that line is stamped once; an
  owner rewording without `{{time_ask}}` gets it appended rather than lost.
  Privately, `meeting-fanout.askedAboutTime` picks whoever settled it by
  hand, else whoever opened it, because two people asked the same question
  answer it two ways; settled from the page, that person gets the one
  `meeting_exact_time_ask` message, since there is no turn to put a hint in.
  **The answer goes through the tool that already means "this time"**:
  `propose_meeting_slot` / `add_group_coordination_option` on a settled
  meeting with an open hour call `meetings.setExactTime` — two new tools
  would have cost 1,121 of the schema's 1,074 spare characters. It is narrow:
  the same local day only (a new day goes back on the table), and only by
  somebody in it. `meeting-fanout.afterTimeSet` moves the shared event as its
  organiser (an hour long, `clearDate` because it may have been a `{date}`
  event), tells everybody else privately (`meeting_time_set`), withdraws a
  queued question, and a time set in the room stamps `group_time_at` so the
  room's `time` line is said only for a time set somewhere else.
  **…and since 2026-10-03 the same door EDITS an exact hour, and the
  coordination stays settled** (owner: "רק תערוך את השעה שלו, רק בתנאי שהוא
  כבר נקבע"). Padel Gang settled on 18:00, moved to 17:00 among themselves,
  and the only way to say so was reopening, which asked everybody again about
  a time the room had already agreed. Nothing is reopened and nobody is asked:
  `moved` rides the result and the `meeting_time_set` payload ("changed the
  time of"), the write is guarded on the moment it read, `group_time_at` and
  `group_hour_at` are cleared so a change made privately is heard in the room
  and the hour-before line follows the new hour, and an unsent earlier notice
  is superseded. The `mtime` key carries the instant, because a time can now
  move more than once per settling. A different day is still `other_day`.

- **The room CHASES only people she has actually written to** (owner,
  2026-09-22; the base line left this rule on 2026-09-26 — see the next
  bullet but one; `group-meetings.statusOf` puts
  `asked` on every person it names, `group-voice.said` is the filter).
  `silent` still means exactly "has answered nothing" — the model's `answered`
  count is `participants - silent.length` and must stay exact — and `asked` is
  the separate question of whether anything about this coordination ever
  REACHED them: an `outbox` row for this meeting with `sent_at` set and
  `hold_reason` null, the same test `meeting-options.unheardRemovals` applies
  to a removal. Both room lines filter on it (the base's `missing`, the chase's
  list) and so does the model's `waitingFor`, because the block is the only
  thing it may speak from in the room; the people it drops come back as
  `notYetAsked`, a count with no tags, so the numbers still add up. With nobody
  reached yet there is no true sentence to say and the room hears nothing at
  all. A caller that carries no `asked` is taken at its word (`!== false`), so
  a fixture or an older payload still says its line — being over-careful here
  costs a line that is true (`incidents.md`, "The room chased three people, two
  of whom had never been asked").
  **…and since 2026-10-02 a member who has never written RIDES the chase, on a
  ration** (owner, the poker room: three of thirteen never wrote and nothing
  reminded them). `cold-tags.allowed`: a tag at most once every three days
  across every room, and none after three with no word back — writing makes
  them connected and takes them out of the rule. The OPENING line of every new
  room tags them all and is never counted (owner, same day); every later line
  that tags them (base/moved, almost, chase) asks it, and the sweep records each tag
  in `room_cold_tags` (migration 107, keyed by phone because a LID has no user
  row). They never decide that a chase is said, only who it reminds, and a tag
  held back is still counted ("ועוד N"). The chase's "who was reached" filter
  above is unchanged for participants (`incidents.md`, "Four out of five, and
  the room heard nothing").

- **A room's coordination counts everybody in the room, and closes on its own
  only when all of them said yes** (owner, 2026-09-26: "שתיאום תמיד יספור את
  כלל האנשים שיש בקבוצה (כי רוב האנשים לא יודעים למה עולמה סופרת חלק וחלק לא)").
  `meeting-options.unanimousOption` also refuses while any member still in the
  room has no participant row — never wrote, a LID, a paused member left out —
  or is paused out of it (2026-09-28); only somebody who CHOSE to leave the
  coordination is not waited for. Short of
  that the room closes it with "סגור" (`settleNow` never checked agreement).
  `statusOf` carries `roomTotal` (the room less anybody who left) and `notInIt`
  (every member with no row, a LID with `phone: null`); the model gets
  `inRoom` and never the list. The base line says "X מתוך N", tags everybody
  who has not ANSWERED that time — asked or not, because the sentence is true
  of both and the room decides — counts the untaggable as "ועוד N", and ends
  on the offer to close without them (`group_coord_unanswered`, or
  `group_coord_close_hint` when the rest said no). It is said while anybody in
  the room is short of a yes, not while anybody TAGGABLE is: coordination 18
  sat silent until it expired on one participant whose invite the gate had
  dropped, because the old line had nobody it was allowed to tag and so was
  never said (`incidents.md`, "The coordination that waited for somebody it
  could not name"). The chase keeps the rule above: it asks people to answer
  her privately, which is only a fair thing to say to somebody she wrote to.

- **A group turn is told the room's coordination state before the model's first
  word, and that block is the only thing it may speak from.** The DM half of
  this has been live since 2026-09-06 (turns-and-replies.md, "The turn opens
  itself"); a group turn got none of it, because the plugin's
  `before_prompt_build` handler bailed on anything that was not `u-N`. So the
  room's agent answered questions about its own coordination out of its
  conversation history — "2 מתוך 4 חברי קבוצה ענו" to a room of three with
  nothing on the table, and "יש כבר תיאום פתוח" a minute after the only one was
  cancelled, both in front of everybody (2026-09-19, `incidents.md`, "The room
  heard its own state from memory"). `domain/group-turn.js` draws it from the
  room's own rows and brokerd `group_turn_context` hands it over: the counts,
  the times on the table, who has not answered, and `coordination: null` — which
  is a fact and not a gap — with a settled or cancelled one under
  `lastCoordination` beside it, because "one is open" and "the last was
  cancelled" are one column apart. **The doctrine already said the right thing**
  and a safety property written as a prompt line is a request, the same argument
  as the reply gate and `markPlaced`. **`llm_input` cannot carry it** — on
  OpenClaw 2026.8.1 it is a void hook, fire-and-forget with its return value
  dropped, so `before_prompt_build` is the only place a group turn can be told
  anything. It asks `group-meetings.statusOf` rather than a second copy of its
  queries, drops the phones it carries per person and keeps the labels, because a
  `waitingFor` short of `asked - answered` would be a new false sentence in place
  of the old one. Inert until the gateway is restarted, like everything else in
  that plugin.
  **…and a result the room has already HEARD is marked, so it is not said
  again** (2026-09-23). After the poker was confirmed in פחם הסעות and the
  room had its "סגור" line, she ended seven replies in a row with "the poker
  is on Friday at noon, on Zoom". Those replies were to jokes, to "I have no
  tool for that", and to being told off about her Hebrew. The block showed a
  confirmed `lastCoordination` and nothing said it was old news, so it was the
  one fact always there to fall back on. `lastCoordination.roomHeard` is `true`
  only when `meetings.group_done_at` is stamped, which is the column the
  room's own line writes. `CONTEXT_RULE` says to repeat it only when asked,
  never as the tail of a reply about something else. Confirmed-but-unannounced
  carries no flag, because that result is still news
  (`incidents.md`, "The poker, seven times").

- **A message in the room with no tag on it is ENDED, never answered — and the
  window it opens is the point.** The owner asked twice (2026-09-19) for writing
  in the room to open the fifteen minutes; a registered room is
  `requireMention: true`, so the gateway drops an un-mentioning message before
  any hook of ours runs, and turning that off made her ANSWER it, which he said
  must never happen. `before_dispatch` is the missing piece: a CLAIMING hook, so
  `{handled: true}` ends the message and no model turn is ever started — silence
  as a fact about the runtime rather than a sentence in a prompt, the reply
  gate's argument one step earlier. Its event carries `sessionKey` (the room's
  jid) and `senderId`, which is both halves `group-context.noteMemberWrote`
  needs without the `Conversation info` block only a turn produces. **The
  mention decision becomes OURS** — `was_mentioned` is born later — so
  `group-context.addressedToHer` reads it off the body and `replyToSender`, and
  errs in ONE direction: anything that might be addressed to her is let through,
  because a false "addressed" is today's behaviour and a false "not addressed" is
  her going silent on somebody who did ask her something. It is a PORT, like
  `reply-leak`'s, and one corpus holds both copies. **Three refusals**: the
  plugin never claims what it read as addressed whatever brokerd answers,
  brokerd claims nothing for a room outside the `group_untagged_rooms` flag
  (empty), and the room still requires a mention. So it is inert, and inert
  while MEASURING — one trace line per group message carries our verdict and
  whether the sender came as a phone or a LID, and the `llm_input` line after it
  carries the gateway's own `mentioned`. The flag is earned per room from those
  two agreeing on real traffic. `senderPhone` returns null for a LID rather than
  stamping the wrong member (2026-09-19, `incidents.md`, "A message in the room,
  with no tag on it").

- **A paused member is counted into a room's coordination only until their
  one invite is spent; a day of silence takes them out** (owner, 2026-09-13).
  They are left out only until they write again: that ends the pause
  (people-and-quiet.md).
  `startCoordination` filters out members where `pause.roomInviteSpent` is
  true, but only for who gets COUNTED IN. The membership check, and `settle`,
  still use the full `coordinatingMembers` list, because a pause does not
  decide who belongs to a room. `sweepSilentPausedMembers` moves a paused
  participant to `opted_out` (cause `paused_no_answer`) once the meeting is a
  day old and their invite is either a day old or never went out. It never
  does this while a row about that meeting is still queued for them, so an
  invite held for their night or quiet day cannot be overtaken by the exit.
  It sends no "X left" message, because they said nothing. `meeting_no_match`
  goes to the initiator only when the exit closes the meeting (`incidents.md`,
  "A room counted in somebody who had paused").

  **Only a pause the ladder took gets that invite** (owner, 2026-09-27).
  Somebody who paused her THEMSELVES is never swept in, and one already in is
  taken out on the next minute sweep, cause `paused_by_request`, with no day's
  wait. **Unless they had already ANSWERED a time still on the table** (owner,
  2026-10-05; `group-meetings.answeredLive`): then they stay in, their answer
  counts, `unanimousOption` waits on them, and `statusOf` draws them with no
  phone, so no line ever tags them. The pause silences her; it does not undo
  what they said (`incidents.md`, "Eden asked not to be taken out"). `statusOf` leaves them out of `participants`, `silent`, `missing` and
  `optedOut`: never asked, never tagged, never said to have left.
  **But the room's NUMBER still counts them** (owner, 2026-09-28, reversing
  that half of 2026-09-27: "משתמשים מושהים גם נכללים בספירה" — the room can
  see how many people are in it, and nobody knows whether they will come
  back). Ten in the room, two paused, five yes is "5 מתוך 10": `roomTotal`
  drops only somebody who CHOSE to leave this coordination, told apart from a
  pause by the cause on their latest `meeting.opted_out`
  (`paused_by_request`/`paused_no_answer`, `group-meetings.pausedExitsOf`),
  because the participant row says only `opted_out`. They ride `notInIt` as
  `{ phone: null, paused: true }`, so the base line counts them in "ועוד N"
  and tags nobody. **And `unanimousOption` waits on them in a room** —
  "everybody said yes" is not true without them, so the room closes it with
  "סגור" and `whoIsIn` never says "כולם בפנים" over them. A private
  coordination is unchanged. A Google invitation is still a message, so
  `calendar.meetingCalendarRoles` still drops them. **Somebody who left the WhatsApp GROUP**
  is taken out of its negotiating coordination by
  `group-meetings.sweepRoomLeavers`, but only when they have no current
  roster row there, since a re-spelled row is the same person
  (`incidents.md`, "The pause the room's invite walked through").
- **Every line a room hears unasked is Olma's own text, save exactly one: a
  sentence a MEMBER asked her to say there** (owner, 2026-09-22). Sharon told
  her in private that the group should know the time had moved from 16:00 to
  17:00; there was no shape in the system for a sentence somebody else decided
  on, so the room was never told and people kept the old hour they had marked.
  `relay_to_group` writes it and the SWEEP says it — deliberately not the tool,
  because enqueueing into `group_outbox` from a private turn would make it the
  one voice able to wake a room at 03:00 (`groups.mayAnnounce` is in the sweep,
  never in the drain) — as `group-voice`'s `relay` kind, between `started` and
  her own three lines: the room learns what is being arranged before it is
  handed somebody's sentence about it. **The guard against her becoming
  "חופרת" is arithmetic, not judgement**: ONE per person per coordination, with
  `meeting_participants.relay_text` (migration 083) as the budget itself, and
  the room has to be named in the `group_relay_rooms` flag at all — empty by
  default, flipped per room from the admin page. Nothing asks a model whether a
  sentence was worth saying. Two more things follow from it being somebody
  else's words: `group-meetings.cleanRelay` strips every `@<digits>` token
  before it is stored, because a relay is a sentence and never a way to notify
  people, and `pendingRelay` is read by the sweep and **never** by
  `group-meetings.statusOf` — that status is also the block a group turn speaks
  from, and a model that could see a sentence waiting would say it itself, in
  its own words, a pass early and outside the room's hours.


- **…and that line carries what the same person did to the TABLE, because the
  reason and the change are one piece of news** (owner's wording, 2026-09-22:
  *"ב-4 קצת חם הוספתי / החלפתי לאופציה של השעה 17 📣"*). Three shapes, chosen by
  what is true and never by a model: `group_coord_relay_swapped` when they took
  a time off and put one on, `group_coord_relay_added` when they only added, and
  `group_coord_relay` — their sentence alone — when they touched nothing.
  `pendingRelay` reads only THEIR writes, and only an addition that is still
  `active`, so a time somebody else has since removed is not reported as news
  about this table; a removal with nothing in its place draws the plain line,
  because "החלפתי" would be false and a time leaving the table has a line of its
  own. The joiner is a dash, not a comma: their sentence keeps its own
  punctuation and a comma after a full stop is what that looks like.

- **A joke in the room is answered with a joke, built only from what the room
  said** (owner, 2026-09-23). Bar tagged her in פחם הסעות, asking if she could
  tease Miron for losing yesterday. She answered with a refusal and an
  explanation ("לא נאמר לי שהוא הפסיד, ולא אמציא לו"). The owner said
  laughing with him a little is fine. `agents-group-template.md` now allows
  one short, good-natured line back. The limits are the ones the room already
  has: nothing invented, nothing from a private chat, nobody really mocked.
  A premise a member wrote in the room is the room's own words, so a joke
  about it passes on nothing. Doctrine only,
  because there is no state to draw: it is a judgement about tone, and
  `resync-agent-templates.js` carries it to every room on deploy
  (`incidents.md`, "The room's joke got a lecture").

- **A room whose people live on more than one clock hears every time in each
  of them, by city, and a room on one clock hears exactly what it did before**
  (owner, 2026-09-25, פנתרה). The zones are those of the people the
  coordination is ASKING (`statusOf`'s `zones`, off `users.timezone`), plus
  the room's own, and "more than one" is decided per moment
  (`meeting-time.spansZones`): Israel and Athens are one clock in some weeks
  and two in others. **The owner's words are separate templates**, `<key>_zones`,
  a VARIANT on the family and never a language (`message-templates.variantOf`),
  shown as a second column on the templates page. A test fails when a room
  line that carries a time has no twin. What rides the line is the instant
  behind each slot text (`at[field]`), not words: the renderer draws them at
  delivery, like every room line. **A time that names no clock is never
  converted.** "בערב" went into `starts_at` as a representative 19:00, so
  saying "12:00 ניו יורק" about it is precision nobody said; it keeps its
  author's words and city. **The model gets the drawn line, never the
  clocks**: `coordinationStatus` (the group tool and the turn block) strips
  `moments` and `zones` and hands over `roomTimes` and the cities, and
  `group-turn.CLOCK_RULE` is said only in a room that spans clocks. Each member
  there carries `clock`, so "at four" from somebody in New York is put on the
  table at New York's four (`incidents.md`, "פנתרה: one time, four clocks").
  **…and asked for hours that suit everyone, she answers from code**
  (owner, 2026-09-25). `meeting-time.commonHours` walks the coming week hour by
  hour and keeps the hours that fall inside 08:00–22:00 on every clock. A day
  with none is widened to 07:00–23:00 and says so. Answers are drawn lines,
  and days that read the same collapse into one line. **Only a CONFIRMED clock
  chooses the hour.** A guessed `users.timezone` is shown beside the answer as
  `לא מאושר`, because a wrong guess would otherwise pick the time for
  everybody. So in פנתרה, where only Israel is confirmed, the block has no
  `commonHours`, and the model calls `group_coordination_status` with the
  `places` the room named (a country with several clocks is asked about,
  never guessed). A place that is not a real zone comes back as
  `unknownPlaces` rather than vanishing.

- **The private side knows every room a person shares with Olma, off the
  ROSTER, and says the list is complete** (`groups.roomsOf`, 2026-09-25). It
  rides the turn context as `rooms` on every turn of somebody in a room, and
  `list_my_meetings` returns it too. Until then no private read touched
  `chat_group_members`: `list_my_meetings` reads `meeting_participants` and
  `recentMeetings` reads the outbox, so a member with no participant row asked
  "אני בקבוצה שאת בה?" and was told no. Keyed on the roster and never on a
  participant row, because being in the room is the fact being asked about;
  each room carries its live coordination and whether THIS person is in it,
  and nothing about anybody else. A room that is `retired`, or that they left,
  is not one they share (`incidents.md`, "She said there was no group").

- **A tag from somebody the gateway would have dropped is answered, and the
  sender list is what decides who that is** (owner, 2026-09-26). The drop is in
  the WhatsApp plugin's normalisation — `checkInboundAccessControl`, before
  mention gating and before any hook of ours — so a blocked tag leaves nothing
  behind and admitting the sender is the only way to answer it.
  `jobs/groups.syncSenderGate` therefore admits two more groups, and brokerd
  `group_room_write` is what makes each safe. **A pause their own next message
  would end** (`pause.endsOnWrite`: `said_stop`, `quiet_ladder`, or their one
  coordination invite out and unanswered): the tag runs `pause.resumeOnWrite`
  — the same function `turn.openRecord` runs, one function because two doors
  that end different pauses is the drift this repo keeps paying for — and the
  turn answers somebody who is back. A pause they confirmed stays OFF the list,
  as a message in their own chat would not end it either. **A roster row with a
  real number** (`status = 'pending'`, `phone-timezone.isRealPhone`): claimed
  with `reason: 'pending_sender'` and answered by the owner's
  `group_sender_hint` line on EVERY tag of theirs (owner, same day: "כל פעם
  שהוא יכתוב"), quoting it; the `group_outbox` key carries the message id, so
  one tag redelivered is still one line. No model turn. That
  reason is the ONLY one on which the plugin claims an ADDRESSED message — a
  bare `claim: true` is still refused for anything addressed. **Two costs are
  accepted rather than closed.** A stranger with no row and a LID-only sender
  are still dropped, because naming them takes `"*"`, and that list includes
  her own number (the loop `syncGroupAllowFrom` exists to refuse). And the
  claim fails open: with brokerd down a pending sender's tag reaches the
  model, which is the pre-2026-09-06 behaviour for exactly one class of
  sender (`incidents.md`, "The tags that vanished before any hook ran").

- **A room member who has never written to her hears about a coordination
  ONCE (per room until 2026-09-28, per person since), privately, in the owner's fixed words — and is never made a
  participant** (owner, 2026-09-26; `group-meetings.coldInvite`, flag
  `group_cold_invite`, template `group_cold_invite`). Called from the
  `group_voice` pass for every negotiating coordination; the outbox key
  `coldinvite:g<gid>:u<uid>` is the once-per-ROOM budget the owner chose,
  because a first message from an unknown number can be reported and a second
  is how that happens. **Proposed 2026-09-28 (compliance review, finding 4;
  owner to approve): once per PERSON across every room** — the copy now ends
  "ולא אכתוב לך שוב", and a second room writing would make that false. The
  query skips anybody with a `room_cold_invite` that reached them or is still
  queued; one the gate held until it expired asked nothing and does not count. It goes on the raw pipe (`proactive-text.rawPipeTextFor`,
  rendered at delivery) because the title is another member's text and no model
  may speak it, and the gate lets it through as the third `PENDING_USER_KINDS`
  entry — everything else the gate does (their night, off a zone guessed from
  the dialling code) still applies. **Not a participant, on purpose**: a person
  counted in and never reached is the stall `statusOf`'s `asked` already has to
  explain away. Their reply reaches the greeter, which already says the room's
  line (`domain/intake-room.js`), and `admitLateMembers` lets them in once they
  are connected — so silence costs the coordination nothing. Only a pending row
  with a real number (a LID has nothing to write to), and never while
  `registration_open` is false, because the message promises to add them and
  their reply would be waitlisted. PR #448 (`group_invite_unconnected`) is the
  approach this replaces: it widened `coordinatingMembers` to every roster row,
  which with pending rows live counts people who can never be reached
  (`incidents.md`, "The invite that would have counted people it could not
  reach").
  **And since 2026-10-03 the fixed line goes to EVERY tag of theirs, an answer
  included, until they write privately** (owner, the poker room: an answer in
  the room is not counted from there). What had stopped it was the addressing
  rule: a tag now arrives as `@<her LID>` with her number nowhere in the text,
  so `addressedToHer` compares her LID too — the plugin reads it off the
  channel's `creds.json` (`incidents.md`, "The fixed line that never went").

- **A room coordination that has gone quiet is offered a way out ONCE, and
  closes quietly if nobody takes it. Somebody who answered nothing is nudged
  privately ONCE, and only in rooms the flag names.**
  (`domain/coordination-policy.nextMoves`, `jobs/coordination-moves.run`,
  flag `coordination_policy` `{mode: off|shadow|live, rooms}`, owner
  2026-09-28.) The simulator chose it: PR #571, 22% confirmed today against
  35% with the offer and 44% with a nudge too.
  - **The offer** (`group_coord_drop_offer`) comes only after the chase, and
    only once `dropAfterQuietH` passes with no answer, no table change and no
    member writing, measured from both the chase and the last activity. It
    needs a leading time that is not `groupVoice.enoughOn`. It is said at most
    once (`meetings.group_drop_offer_at`, migration 098, stamped on the
    decision clock). It goes out only in a pass where the room owes no other
    line about that coordination, and only in the room's hours.
  - **The offer NAMES the moment it closes, and the close keeps it** (owner,
    2026-09-28: "לנקוב בשעה"). `coordination-policy.closeMomentFor` fixes it
    when the offer is said: `dropGraceH` on, up to the half hour, and moved
    to the room's window open when that lands in its night. It is stored
    (`meetings.group_drop_close_at`) and never recomputed. The line carries it
    as `closeAt` and is drawn at delivery in the room's clock ("מחר ב-09:00"),
    or in every clock through `group_coord_drop_offer_zones`. A row with no
    `closeAt` draws nothing rather than a promise nobody can check.
  - **Anything after the offer lapses it for good.** With nothing after it,
    at the named moment the coordination closes as `no_match` with no line of
    its own (`meeting.dropped_quiet`). Its end reaches people the way every
    close does.
  - **The nudge** (`meeting_nudge`) goes to somebody an invite or proposal
    REACHED `nudgeAfterH` ago who has answered nothing. It is sent once, never
    to somebody paused, never about a thing already started, and never in the
    same pass as the offer.
  - **An answer withdraws a queued nudge** at the answer
    (`meeting-options.answer`), and the sweep repeats that as a backstop.
  - **`shadow` writes only `coordination.policy_shadow` audit rows**, each
    carrying the decision clock in `at`, and treats its own offer as said so
    that it reaches the close.
  - **Do not flip a room to `live` until the owner has approved both texts
    word for word.**
  (`incidents.md`, "The coordinations that died in silence".)
