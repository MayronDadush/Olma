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
  gateway writes one the moment it first resolves a LID), the sweep reads it ONCE
  per pass through the worker facade, and the pure
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
  nobody chose. **Two is a floor, not a taste call**: `startCoordination`
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
  started. `jobs/groups.mayAnnounce` is the second reader, for the reason in
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

- **The first thing a room hears about its own coordination is that she has
  STARTED, and it counts people rather than naming them** (owner, 2026-09-22:
  "תכתוב בקבוצה שאתה מתחיל בתיאום בפרטי עם מי שכתב לה"). `group_coord_started`,
  decided first in `group-voice.decideGroupLine`'s negotiating branch, stamped on
  `meetings.group_started_at` (migration 080) like every other line in that
  family so a line held for the night goes out in the morning and never twice.
  Before it, the room's first word was `base` — which waits for two people to
  agree on a time, hours later — so a room that had just asked her for something
  heard nothing at all. **It carries a COUNT and no tags**: `co.participants` is
  who she is actually asking, and `co.outside` is how many members of the room
  she could not sweep in, said only as "somebody here is not counted" and only
  when there is one. Who those people are is the gate notice's own sentence, and
  a room hearing the same list in two voices is what this whole family of lines
  avoids — which is also why nobody is named, in a line that would otherwise be
  the easiest place to break the tag-not-name rule below.

- **A tag is a NUMBER, and the roster hands us LIDs in the same column** (owner,
  2026-09-22). `chat_group_members.phone` holds a WhatsApp LID for members the
  gateway only ever named that way: the roster is the envelope's
  `group_members`, a list of digits with no JID on it, so nothing downstream can
  see which is which. `proactive-text.isTaggableNumber` cuts at 13 digits — the
  box's own numbers: 2,673 LID keys run 12-15 digits, 5,346 real numbers stop at
  13, so nothing 14 or longer has ever been a number here and no real member is
  silenced. `mentionToken` answers `null` and `mentionTokens` filters before
  `MAX_TAGS`, so the overflow count counts people. **It is a filter, not a
  guarantee** — 95 of those LIDs are 12-13 digits and indistinguishable, one of
  Padel Gang's three among them — so never read a rendered tag list as
  "everybody who is missing"; the airtight answer is upstream. **And a line whose
  whole content is tags is not said when it can name nobody**: the gate notice
  is skipped, uncounted and unstamped rather than going out as
  `עוד מחכה ל:  🧐`, which costs the owner's "every tag gets an answer" and is
  left as a cost, because the sentence for a room waiting on somebody we cannot
  name is his to write (`incidents.md`, "The room asked three numbers that were
  nobody").

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

- **The room is chased an HOUR after she starts, not half way to the thing**
  (`group-voice.CHASE_AFTER_MS`). Half the distance, clamped to [1h, 24h],
  put מירון's room at 05:11 the next morning with the night in front of it,
  because the earliest option was twenty-six hours out. `Math.min` keeps the
  old instinct as a ceiling rather than a formula: a game in ninety minutes is
  still chased in forty-five. Who may be NAMED is unchanged and was re-checked
  on this room — גל had been written to four times and not answered, so he is
  nameable; גיא had every message dropped at the gate as `quiet`, was never
  actually asked, and must not be.
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
  `group_calendar_at` (migration 076). **And no base line when nobody is
  missing or `settle_due_at` is armed** — "מחכה ל 🤞" went out with an
  empty list twelve seconds after Yuval's yes made it unanimous; the next
  thing that room should hear is "סגור". `TAG_RULE` also says now that the
  `@<digits>` in the message she received is the sender tagging HER — she
  echoed her own LID as if it were Yuval's (`incidents.md`, "The room waited
  for nobody").

- **A time the room was TOLD about and that has since left the table is said
  again; a time merely overtaken is not** (owner, 2026-09-22: "יש אנשים
  שסימנו אותו ועכשיו הוא לא רלוונטי"). `group_base_at` says the line was said
  and cannot say WHICH time it said, so Padel Gang held שבת 16:00 for the rest
  of its coordination — eleven minutes after Sharon deleted it and put 17:00 on
  the table, with two people's yes on the time she removed. `meetings.
  group_base_slot` (migration 082) is the slot text the room actually heard,
  and `group-voice.decideGroupLine`'s `namedGone` is the whole trigger: that
  slot is no longer among the active options AND another one leads. **Three
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

- **The room says that people have not answered only about people she has
  actually written to** (owner, 2026-09-22; `group-meetings.statusOf` puts
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
