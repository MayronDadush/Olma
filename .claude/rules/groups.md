---
paths:
  - "olma2/src/domain/group-connections.js"
  - "olma2/src/domain/group-context.js"
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
