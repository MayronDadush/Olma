# Group mode — Olma in a WhatsApp (later iMessage) group

Status: **design, nothing built**. Branch `claude/bot-group-behavior-fddc5b`,
worktree only — nothing here has been merged or deployed.

The product rule we are building to (2026-09-04, from the owner):

1. Olma sits in a group chat and is addressable **only by tag/mention**.
2. She must **see who is in the group**.
3. She answers **nobody** in that group until **every** member has sent her at
   least one private (DM) message.

Everything below is what the live gateway actually does (measured on the box,
OpenClaw 2026.8.1), and what we would have to add.

---

## What is true on the box today (measured, not assumed)

- `channels.whatsapp` exists, so the runtime group policy falls back to
  **`open`** (`resolveOpenProviderRuntimeGroupPolicy`,
  `configuredFallbackPolicy: "open"`), and `groupAllowFrom` is `["*", …]`
  anyway. There is **no `groups` map**, so *every* group is eligible.
- There is a channel-wide binding with no peer match, routing to the **`intake`**
  agent. A group message therefore lands on `intake`, in intake's workspace,
  with intake's tools.
- Mention gating is on by default, so she does not speak unprompted.

**Net: today, anyone who adds Olma's number to any WhatsApp group and tags her
gets an answer, served by the intake agent.** That is not a hypothetical future
surface; it is live, and closing it is step zero of this feature.

## What the gateway gives us for free

| Requirement | Gateway feature |
|---|---|
| Only by tag | mention gating, on by default; patterns via `agents.entries.<id>.groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns` |
| Only known groups | `channels.whatsapp.groups` — a **map keyed by group JID**; present = allowlist, absent = all groups eligible. Per-group options, e.g. `{ requireMention: true }` |
| Per-group agent + workspace | `bindings[].match.peer = { kind: "group", id: "<jid>@g.us" }`, same one-`saveConfig` rule as user provisioning |
| Per-group session | `session.groupScope: "per-group"` (default) → `agent:<agentId>:whatsapp:group:<jid>` |
| The roster | inbound envelope carries `group_members` ("Name (+phone), …") and `group_subject`; built by the WhatsApp plugin from `msg.group.participants` + its name roster |
| Backlog when she was silent | pending group history injection, `historyLimit` (default 50) |
| **Hard mute that still runs the turn** | `session.sendPolicy` rules — `match` on `channel` / `chatType` / `keyPrefix` / `rawKeyPrefix`, first deny wins. `sendPolicy: "deny"` sets `suppressDelivery` unconditionally in `resolveSourceReplyVisibilityPolicy` |

### Two sharp edges found while reading the runtime

- **`visibleReplies: "message_tool"` is not a mute.** In
  `resolveSourceReplyDeliveryMode`: if the mode resolves to
  `message_tool_only` but `messageToolAvailable === false`, it returns
  **`automatic`**. Taking the `message` tool away from an agent to silence it
  does the opposite — it re-enables auto-delivery of its text.
  `sendPolicy: deny` is the only unconditional suppression.
- **Ambient room events do not cover WhatsApp.** `unmentionedInbound:
  "room_event"` is supported for Discord, Slack and Telegram only; WhatsApp
  keeps mention gating + the pending-history buffer. So "listen quietly to
  everything" is not available on this channel — she sees unmentioned traffic
  only as injected backlog when a tag finally triggers a turn.

## What has to be built

### 1. Admission and routing

Add a `groups` map (this **blocks every group not listed** — a deliberate,
production-visible change) and provision one agent per group, `g-<id>`, with
its own workspace, exactly like `provision.js` does for a user: agent +
binding in a single `saveConfig`, never bindings alone.

The group workspace gets `GROUP.md` (subject, roster, gate state) where a user
workspace gets `USER.md`. The group agent is **not** any member's agent and
must not inherit anyone's private context.

### 2. The roster, server-side

`group_members` reaches the *model*, not our DB — so a gate computed from what
the model reports back through a tool would be a gate the model can open by
under-reporting. It must not be built that way.

~~We already read the gateway's own storage server-side:
`olma2/src/channels/sessions.js`. The group session's transcript carries the
inbound `Conversation info:` block verbatim, `group_members` included.~~
**Wrong, and measured wrong on the first live message (2026-09-06 15:09
UTC).** On OpenClaw 2026.8.1 the transcript keeps the bare text of the
message; the block is composed per turn and handed to the model, and the
only transcripts on the box that contain one were written by our own
probes. The internal `message:preprocessed` hook does not carry it either
(its mapper keeps `isGroup`/`groupId` and drops `GroupMembers`), and
`openclaw directory groups members` answers "not supported" for WhatsApp.

What does see it is the gateway's `llm_input` plugin hook, which receives
the model's input verbatim. `gateway-plugin/olma-turn` reads the block there
for every group turn (the greeter's and a group agent's), sends it to
brokerd as `group_context`, and brokerd files it in `group_inbound_context`
(one row per session, replaced on every message; `domain/group-context.js`).
The sweep reads that row. Same trust path as before — the block is the
gateway's own description of the envelope, written before the model says a
word — one hop longer. The plugin's trace (`run/turn-context-plugin.log`,
`where`) records which field of the hook payload the block was found in, so
a gateway that moves it again is caught by a line, not by a silent group.

New tables (numbering picked from `max(version)` on the box at write time,
never `ls migrations/`):

- `groups` — jid, channel, subject, agent_id, state (`locked`/`unlocked`),
  added_by_user_id, timestamps.
- `group_members` — group_id, phone, display_name, user_id (nullable),
  first_seen_at, left_at.

### 3. The gate

Unlocked ⇔ every non-left roster member resolves to a `users` row that has
actually written to Olma privately. "Has DM'd" must be a real predicate over
inbound, not `onboarded_at` alone — the exact column choice is a follow-up.

Enforcement is the config, not the prompt — and all three levers were
measured against the running gateway on 2026-09-04, because two of them do not
behave the way the docs read:

| Lever | Where it really lives | What it actually did |
|---|---|---|
| Admission | `channels.whatsapp.groups` (map keyed by JID) | hot, but **restarts the whatsapp channel** — ~9s with no inbound, measured on the live box |
| Routing | `bindings[].match.peer.kind = "group"` | as documented |
| The mute | **top-level `session.sendPolicy`** — *not* `agents.defaults.session.sendPolicy`, where the config-agents example puts it (`resolveSendPolicy` reads `cfg.session?.sendPolicy`) | `deny` suppresses delivery unconditionally; the turn still runs and still writes its transcript |

Two traps found before anything was built on them:

- **A `session.sendPolicy`-only write is silently dropped.** The gateway
  logged `config change detected; evaluating reload (session.sendPolicy)` and
  then nothing at all — the same noop-plan early-exit that swallows a
  bindings-only write. Bundled with an `agents.entries` change it applied in
  ~4s. **Every lock/unlock must ride along with an agent or binding write in
  one `saveConfig`.**
- **The mere presence of `session.sendPolicy` denies any session key the
  resolver finds ambiguous.** All 46 live session keys on the box, plus every
  other shape this gateway mints (main, cron, heartbeat, explicit model-run,
  webchat, newsletter), were run through the gateway's own resolver with and
  without a group rule. Exactly one key changed: the group's own. The check is
  worth repeating after a gateway upgrade — `/tmp/sendpolicy-probe2.mjs` on the
  box is the script.

And one that is **not** a mute, though it looks like one:
`messages.groupChat.visibleReplies: "message_tool"` falls back to `automatic`
when the agent has no `message` tool (`messageToolAvailable === false`), so
taking the tool away to silence an agent does the opposite.

Cost note: while locked, each tag still costs a model turn with no output.
Bounded by mention gating, but a repeat-tagger is a real cost vector. The
cheaper variant — capture the roster once, then drop the group from the
`groups` map entirely until unlocked — is the fallback if that shows up.

### 4. Identity

Every MCP tool takes the workspace identity token, which today maps to a
**user**. A group agent needs a **group identity kind** (token → group_id) and
a deliberately small tool surface. What a group agent may read about a member
is a grants question, not a default.

## Decided (owner, 2026-09-04)

### Locked is not silent — but the model still is

When she is tagged in a locked group she answers, and what she says is fixed:
she needs everyone in the group connected to her, one private message each,
and then the group is usable. If people keep asking her things while locked,
she **tags the members who are not registered yet** and adds something warm —
"?מה איתכם" / "אני מחכה".

That reply must **not** come from the model. A locked group is exactly where a
prompt-only rule ("do not answer their question") is one clever message away
from failing, and this project has that failure written down five times over.
So:

- the group agent stays hard-muted by config (`sendPolicy` deny on the group's
  session-key prefix) for the whole locked period;
- the gate message is composed **server-side in brokerd** and sent on the raw
  pipe (`openclaw message send --target <jid>@g.us`), which needs
  `agents.defaults.systemAgent.agentId` set — verify with
  `--dry-run --json`, never by reading the file (it is `"main"` on the box,
  checked 2026-09-04);
- mentions are real mentions: the WhatsApp plugin attaches native mention
  metadata for `@+<digits>` tokens that match current participant metadata, and
  we have those numbers from the roster;
- two shapes, escalating, not one repeated line: **first** tag in a locked
  group → the explanation; **subsequent** tags → the nudge that mentions the
  missing members by name. **Every tag is answered** — there was a 30-minute
  cooldown for a day and the owner removed it (2026-09-06: "כל תיוג עונה בלי
  צינון"). What keeps her from flooding a room is the sweep itself: it reads
  the newest tag per tick, so forty tags inside one tick are one answer;
- the answer is sent as a **reply to the message that tagged her**
  (`openclaw message send --reply-to <id>`, the id read from the transcript's
  `Conversation info` block as `message_id`) when the id is there, and as a
  plain message when it is not. The intro and the opening announcement are
  never replies — nobody asked them;
- **the wording is the owner's, and he edits it from the admin page** —
  "ניסוחים" under הגדרות, `domain/message-templates.js`, stored as the
  `message_templates` flag. The defaults in code are what a fresh install
  says; an override that drops a required placeholder (the `{{missing}}` tags
  of a nudge, her own `{{me}}` tag in the intro) is refused by name on the
  page and ignored at render if it ever reaches the flag by hand.

### No cold DMs, ever

She sees every member's phone number and knows they share a group. She does
**not** write privately to anyone who has never written to her. The only way a
missing member hears from her is being tagged inside the group they are
already in.

### A new member re-locks the group

The rule holds continuously, not just at the door. A member who joins an
unlocked group and has never DM'd puts the group back to `locked` until they
do. (Roster comparison is server-side, off the transcript — see above.)

### The group is a separate world

Nothing from a member's private chat enters the group: no facts, no tasks, no
calendar, no preferences. She knows what was said **in the group**, plus the
basics that are not private in a group context anyway — name and gender.

Concretely that means the group agent gets a group identity token, its own
workspace and memory, and a tool surface that has no access to any user's
private domain objects. Not "instructed not to" — not wired to.

### Being in the room is the introduction (decided, owner, 2026-09-09)

The owner's rule: everybody in a WhatsApp group with Olma automatically becomes
connected to everybody else there, and each of them opens their personal page
to find that room already there as a group — the same people, under the name it
has in WhatsApp.

The connection layer is a clean fit — it already is the base layer every
cross-user feature sits on, and this is not the inferred closeness that stays
forbidden ("these two talk about each other, they must be close"). Being in the
room is a fact both people can see: they already have each other's number
there, and the errand that brought them in is a shared one. The room is the
consent moment the approval flow was standing in for.

`domain/group-connections.js`, called by the group sweep on every pass. Three
lines it does not cross, each of which would turn a convenience into something
nobody agreed to:

1. **Only people who are already users.** A member who has never met Olma is
   not invited by this. `requestConnection`'s invite path sends a stranger a
   message, and a room of twelve would become twelve introductions nobody
   asked for.
2. **A `declined` or `revoked` pair is never re-created.** Revoking is the only
   way out of a connection, and a revoke that walking into a room undoes is not
   a way out at all. Those two stay unconnected while sharing the room.
3. **Nothing here reads or moves anybody's data.** Every feature is granted on
   both sides, which means each of them MAY be asked — a share still waits for
   the viewer to accept it, a relayed message still passes the recipient's own
   delivery gate.

**The earlier narrower option was rejected deliberately.** It was to create the
connection and leave the per-feature grants at their defaults, on the argument
that a 20-person work group mints 190 pairs with everything open. What decided
it the other way is that since 2026-08-27 activating a connection already
auto-grants all three features on both sides — approving the friendship IS the
consent moment — so leaving the grants off here would have made a room-made
connection the one kind that is connected and unusable.

**Its own audit event, never `connection.approved`.** `jobs/metrics.js` counts
approvals as a friction signal, and a number that silently absorbs a second
meaning is a number nobody can read six weeks later. One
`connection.auto_connected` row PER SIDE, because a per-person audit view asks
`WHERE actor_id = $1` and a single row would leave one of the two with nothing
on their record.

**It runs on every pass and is idempotent by construction**, which is what
makes a member who signs up next week connected by the pass that notices,
without anybody remembering to run anything. The whole room's state is read in
ONE query rather than three per pair: a room of twenty-five is three hundred
pairs, and asking about each of them inside the sweep's transaction is exactly
the shape that held a lock on `chat_groups` for twenty seconds ("The room was
told twice"). Steady state is two queries and no writes.

### The room arrives on the personal page as a group already made

The other half of the same rule, on the surface the owner chose — each person's
own page, not the admin one. `docs/design/user-dashboard.html` has carried a
complete groups design since it was built, hidden whole on a served page
because nothing on the server kept a group and one made there was forgotten on
reload. The rooms are the missing server half: `user-dashboard.loadGroups`
returns each room the viewer is in, by its WhatsApp subject, with its members.

What that changes about the hiding is that the two halves part company. The
**list** shows, because there is now something real in it. The **button that
makes one** stays hidden, because a WhatsApp room is not something this page can
create — and a room renders as a read-only fold: no rename, no delete, chips
that do not toggle. The name and who is in it are decided in WhatsApp, and a
control here that looked like it could change either would be lying.

**No phone numbers and no `identity_token`.** The room's row is its door
(rule: nothing a group tool returns may carry it), and this payload goes to a
browser. Members who are not users are drawn by the display name the room
already shows, because a room drawn with half its people missing reads as the
wrong room — a name, and no way to reach them from here.

The list stays hidden in CSS until `hydrate` puts `.live` on it, rather than
being hidden from script after the fetch: the seeded design groups are in the
markup, so hiding them only once the answer arrives shows a real person
somebody else's example lists for as long as the server takes.

### A group only exists if Olma already knows somebody in it

Being added to a group is not enough to create anything. A group registers —
agent, workspace, row — only when **at least one member is an existing Olma
user**. Otherwise she does not react at all: no agent is provisioned, no reply,
nothing. Without that rule, anyone in the world mints an agent and a workspace
on our box by adding a number to a group.

### Only a real mention wakes her

A genuine WhatsApp @-mention of her number, or a reply to one of her messages.
The word "אולמה" in free text does **not** count, so `mentionPatterns` stays
empty rather than being seeded with her name.

### Groups have quiet hours too

Same shape as a person's, and through the **same gate**: `outbox/gate.js`
already takes `{ window, tz, lastInboundAt }` and already implements the
15-minute `CONVERSATION_GRACE_MS` rule. A group reuses it rather than growing a
second quiet-hours implementation.

- window `09:00`–`21:00`;
- `tz` = the timezone **most** members are in (every member is a user by the
  time a group can be spoken to, and `users.timezone` is never NULL);
- a tag opens the group for 15 minutes exactly like a DM, so an answer to
  somebody standing right there is never held;
- the unlock announcement goes out in the group, held to the window like any
  other proactive message;
- she may also start group conversations on her own for things the members
  asked for — a meeting to coordinate, a shared task — never in quiet hours.

**Open:** a member who paused Olma. Pause means "never initiate to me" and has
no exceptions, but a proactive group message reaches everyone at once, so there
is no way to honour one member's pause and still speak. Proposed default: a
paused member holds the group's proactive traffic (answers to a tag are still
answers, not initiations).

### Cap: 25 members

Above that she says once that the group is too large and stops responding
there. Bigger groups never realistically unlock, and each tag costs a model
turn. The number is a dashboard flag, not a constant.

## The greeter, and why an unknown group needs one

The owner's rule (2026-09-05): **she introduces herself on the first message in
the group, whoever sends it** — a fixed template, not a model turn: who she is,
what she does in one line, and that you reach her by tagging her.

Being added to a group produces no event we can act on. The WhatsApp plugin
does listen to `group-participants.update` and `groups.upsert`, but only to
invalidate its metadata cache — nothing becomes a turn. And
`pluginHooks.messageReceived` does not help either: it fires deep inside the
turn-preparation path, after sender policy, after mention gating, immediately
before dispatch. It means "a turn is about to run", not "a message arrived".

So the first message in a group has to actually wake something. Three verified
facts make that affordable:

- `groups["*"]` admits every group, so the map can carry per-group settings
  without blocking a group we have never seen.
- an exact JID entry **outranks** the wildcard
  (`resolveChannelGroupRequireMention`: group entry -> `"*"` entry -> `true`).
- `sendPolicy` matches `rawKeyPrefix`, so a whole AGENT can be muted, not just
  one group.

The shape:

```json5
groups: {
  "*":     { requireMention: false },  // a group we have never seen: anything wakes her
  "<jid>": { requireMention: true  },  // a registered group: a real tag only
}
bindings: [ { agentId: "ggreet", match: { peer: { kind: "group", id: "*" } } } ]
session: { sendPolicy: { rules: [ { action: "deny", match: { rawKeyPrefix: "agent:ggreet:" } } ] } }
```

An unknown group therefore lands on **`ggreet`, an agent that is permanently
muted at the gateway** and exists for one reason: to make a turn happen so the
group, its subject and its roster reach brokerd (through the plugin's
`llm_input` hook — see "Not the model", above).
brokerd then registers the group, sends the canned introduction on the raw pipe,
and writes the group's own entry (`requireMention: true`), its own agent and its
own binding — one `saveConfig`, so it hot-applies.

The cost is one cheap model turn per message in an unregistered group, for the
seconds until that write lands. It is bounded by how fast the sweep runs, and
`ggreet` should point at the cheapest model on the roster.

**`sendPolicy` cannot express "deny all groups except these".** The resolver
returns on the first matching deny regardless of an earlier allow, so a blanket
`chatType: "group"` deny could never be lifted per group. Muting by agent is
what makes the greeter safe.

## The lock is structural: a locked group has no agent

The first design here toggled a per-group `sendPolicy` deny rule on and off.
That works, but it rests on remembering to bundle every toggle with an
`agents.entries` change, for ever, or the write is silently dropped. A rule
that is only true while everybody remembers it is not a lock.

What actually locks a group is that **it has no agent of its own**. With no
exact binding it falls to the greeter's wildcard, and the greeter is muted
permanently, by an agent-wide rule written once. So:

| | binding | agent | can speak |
|---|---|---|---|
| unknown group | greeter wildcard | `ggreet` | no — muted for ever |
| registered, locked | greeter wildcard | `ggreet` | no |
| open | its own, exact | `g-<id>` | yes |

Every lock and unlock is therefore an `agents.entries` change by construction —
the one key measured to give the reload planner a hot reason — so the config
write always lands. The per-group deny rule stays as a second belt, added at
**registration** rather than at lock time, so the invariant is simply "a group
without its own agent also carries a deny rule": there is no window, not at
registration and not after a rolled-back opening, where the only thing between
a room and a stray reply is a binding that happens not to exist yet.

A third measurement made this affordable: **a `channels.whatsapp.*.groups`
write hot-applies on its own** (2026-09-05, `config hot reload applied
(…groups)`), at the cost of a ~5s whatsapp channel restart. That is what lets
registration admit a group by itself, and it is why admission is a
registration-time lever and never a per-message one.

Re-locking takes the agent and the route away but **never the workspace**. A
group's memory, its patterns and its card outlive a lock; a group that re-opens
because somebody finally signed up should not have forgotten itself.

## Coordination: the group is a trigger and a status channel, not a new engine

`domain/meetings.js` already holds the whole negotiation — `startMeeting`,
`proposeSlot`, `respondToSlot`, `tryConfirm`, private vs shareable constraints,
opt-out, expiry. Group mode adds a trigger (a tag that asks for a meeting), a
participant set (the group's members), and a status channel (the group itself).
It does not add a second scheduler.

Owner's decisions on the flow (2026-09-05):

- **Scope: coordination only, for now.** Tagged and asked something unrelated,
  she says that belongs in the private chat. What people actually ask for in
  groups goes on the dashboard, and the scope widens from evidence.
- **The awake window is the existing 15 minutes**, reused from
  `outbox/gate.js` — whoever tagged her, and whoever wrote after them, is
  demonstrably awake, so a private message may go out in their quiet hours.
  **Strictly bounded to an open coordination belonging to that group**: seeing
  that somebody is awake is never a licence to raise anything else with them.
- **Every tag in a locked group is answered, but the answer shortens** — the
  full explanation once, then the missing people's tags and one line.

### The coordination flow, decided (owner, 2026-09-05)

- **Somebody stops answering in private: she carries on and reports.** After a
  reasonable wait she drops them from the round, closes with the rest, and says
  in the group what happened. Nobody in the room has to adjudicate it.
  *Open:* what "reasonable" is. `meetings.js` already carries
  `LEGACY_STALE_DAYS = 3` and `EXPIRE_AFTER_START_MS = 6h`; a group round
  plainly needs something shorter, and the right number is probably a flag.
- **What crosses from the group into a private chat: the group's name and what
  is being coordinated. Nothing else.** Not who else is taking part, not the
  requester's exact words. So a private DM reads "לתאם פאדל לקבוצה 'פאדל
  שלישי' — מתי אתה פנוי השבוע?" and stops there. This is the group/private
  boundary in its narrowest useful form, and it is the line to defend when a
  later feature wants "just one more field".
- **A confirmed meeting lands in each person's own world like any other** —
  the existing calendar path, with a date and a time. Group mode does not
  invent a second kind of meeting.
- **Group memory holds patterns of the GROUP only** — "they play padel, usually
  Tuesday evening, usually four of them". Never a fact about a person. Each
  person's own Olma separately learns their own patterns and adapts; that is
  the private brain's job, and the two never merge.

### Chasing somebody who went quiet, decided (owner, 2026-09-05)

- **The cadence is cut from how far away the meeting is, not from a constant.**
  Coordinating for tomorrow: a reminder after an hour, dropped after three.
  Coordinating for next week: a reminder after a day, dropped after two.
- **A reminder that lands in that person's quiet hours waits for morning, and
  the clock stops with it.** Somebody asleep has not "failed to answer", and a
  round must never time out through their night. The one exception is the awake
  window: if they wrote in the GROUP, she may reach them privately about that
  group's open coordination — and about nothing else.
- **"אבדוק ואחזור אלייך" does not stop the clock** — only real availability (or
  an explicit no) does. But if that reply arrives on what would have been the
  last nudge, they get one more. Being busy is not the same as ignoring her.
- **Whether the group hears about it first depends on whether that person is
  critical to the plan**: four people needed for padel and only four in the
  room means she tags them in the group before giving up; a nice-to-have gets
  dropped quietly and reported afterwards with the result.

That last one needs something we do not have: **how many people the thing
actually needs**. It is a property of the plan, not of the group — "padel,
four" — and the natural sources are the person who asked ("צריך מינימום כמה?",
asked once) and the group's own remembered patterns ("usually four of them").
Not designed yet; recorded so it is not discovered halfway through the
coordination layer.

### What she says, word for word

The wording is the owner's, approved 2026-09-05, and lives in
`domain/proactive-text.js` beside the reminder text — deterministic, no model,
raw pipe. It has to live there rather than in a prompt because a locked group's
agent is muted at the gateway: there is no model output to use.

One trap that reads correctly in the source and fails in the group: **a tag
pings only when the token is a phone number.** The gateway attaches native
mention metadata for `@+<digits>` matching a current participant, and WhatsApp
renders each viewer's own saved name for it. `@דני` arrives as dead text.

## The sweep

`jobs/groups.js`, armed in the registry at 10s and **inert until
`scripts/install-group-greeter.js` has been run by hand** — with no greeter
agent it returns immediately, which is what makes it safe to arm before the
feature is switched on. Nothing about it writes production config on a timer.

One pass, per group session:

1. read what the plugin filed for the group (`group-context.read`) for the
   subject, the roster and the tag's message id, and the session listing for
   whether anything is newer than our watermark;
2. never seen it → register (which refuses unless a member is already an Olma
   user), admit it tag-only, and say the introduction;
3. seen it → reconcile the roster, evaluate the gate, and act on the
   transition: open → its own agent; no longer open → the agent comes away;
4. say the one thing that is due — the introduction, a gate notice, or the
   opening announcement.

Scoped to the greeter plus whichever agents own an open group, never a full
session scan: `listSessions()` opens every agent's sqlite store, and a
ten-second sweep doing that is the polling cost this project already paid once
(`openclaw sessions list`, 2.9s of CPU per call).

**Every uncertain case falls silent.** An unparseable roster entry, a
session with no filed row yet, a member who resolves to nobody — each leaves the group
exactly where it was. A group that stays quiet when it should have spoken is a
bug; a group that speaks when somebody has not signed up is the feature
failing.

Two things the tests caught rather than the design:

- The pass that registers a group must **not** also send the gate notice. The
  message that woke her there was very likely not a tag (before registration
  the greeter wakes on anything), and "nice to meet you" followed immediately
  by "some of you have not signed up" is not how anyone introduces themselves.
  The nudge belongs to the next time somebody actually asks her for something.
- Opening and announcing are two moments, so they are two columns. A group that
  opens at 00:30 really is open; it just does not say so until the morning.

## The sender gate: `groupAllowFrom` (measured 2026-09-06)

Everything above decides which *rooms* she is in. This is the other half —
which *people* in them the gateway will wake her for at all — and until now it
was open.

Enabling group mode means `groupPolicy: "allowlist"`. The obvious reading of
that word is wrong. What the WhatsApp plugin actually does
(`resolveWhatsAppInboundPolicy`, `monitor-CySzv38g.js`) is:

```js
const groupAllowFrom =
  (account.groupAllowFrom?.length ? account.groupAllowFrom : undefined)
  ?? (configuredAllowFrom.length > 0 ? configuredAllowFrom : undefined) ?? [];
```

It resolves the fallback **itself**, before handing the list to the gateway
core — which is why the core is then called with
`groupAllowFromFallbackToAllowFrom: false`, and why reading only the core is
reassuring and wrong. Ours is `allowFrom: ["*"]`.

Put to the gateway's own resolver, one group, one sender:

| `groupAllowFrom` | sender | decision |
|---|---|---|
| unset | a stranger | ALLOW `group_policy_allowed` |
| `[]` | a stranger | ALLOW `group_policy_allowed` |
| `[user]` | a stranger | BLOCK `group_policy_not_allowlisted` |
| `[user]` | that user | ALLOW `group_policy_allowed` |
| `[user]` | **her own number** | BLOCK `group_policy_not_allowlisted` |
| `["accessGroup:x"]`, x defined | a member | ALLOW |
| `["accessGroup:x"]`, x undefined | anyone | BLOCK `access_group_missing` |

Three things follow.

**An empty list is not a closed door.** `[]` and "no key" are the same
wide-open door, so `syncGroupAllowFrom` refuses to write one and leaves the
last known-good list in place. The only thing that means *nobody* is
`groupPolicy: "disabled"`.

**The list is the users, and the group sweep owns it.** `syncSenderGate` makes
it exactly `status = 'active' AND paused_at IS NULL AND NOT is_eval`, every
pass. Declarative on purpose: one rule covers a user joining, pausing, being
blocked and being deleted, instead of four mirrored call sites that drift. It
is not done at provisioning time because `channels.whatsapp.accounts.*`
restarts the WhatsApp channel, and paying that mid-onboarding is the cost
`addAllowFrom` already refuses to pay.

*A paused user is deliberately not in the list.* Her answer in a group reaches
the whole room including them, so admitting a paused member's tag walks
straight around the pause the delivery gate exists to enforce.

**Her own number must never be in it**, and `syncGroupAllowFrom` drops it
however it is spelled. Her outbound messages tag her — the introduction carries
a real self-mention — so an echo arriving past the gateway's de-duplication
window would be a sender she trusts, with her at both ends of the loop.

`accessGroups` was measured too and rejected: it works, but it buys nothing
here (both paths cost the same reload) and it fails closed on a dangling
reference, which turns one half-written config into a system that hears
nobody.

### And the map moved, because of where the reload planner looks

Found while verifying the above, not by a test. The planner takes the **first**
rule whose prefix matches (`matchRule`, `config-reload-plan.js`), and the
WhatsApp plugin declares:

```
configPrefixes: ["channels.whatsapp.enabled",
                 "channels.whatsapp.accounts",
                 "channels.whatsapp.selfChatMode"]   -> hot, restart-channel
noopPrefixes:   ["channels.whatsapp"]                -> none
```

So `channels.whatsapp.groups` — where admission was being written — matches
only the noop rule. A write that touched nothing else was **dropped in
silence**, which made `admitRegisteredGroup` (admission + the sendPolicy mute,
both noop paths) a write that did nothing at all. The map now goes under
`channels.whatsapp.accounts.default`, where it is a hot reason that applies on
its own. The gateway merges the channel-level map into the account
(`resolveChannelGroups` → `resolveMergedAccountConfig`), so the readers accept
both and only the writers changed.

`scripts/install-group-greeter.js --status` prints `senderGateOpen`. That is
the line to read before turning `groupPolicy` on — an open sender gate is
spelled as an absent key, which is the one thing reading the config file
cannot show you.

## Still open

1. Does the in-Olma group object own meetings/coordination directly, or is it
   a view over the existing pairwise connections?
2. ~~Exact "has DM'd" predicate~~ — decided: `users.last_inbound_at`, a real
   inbound message (`domain/groups.js`, `isConnected`).
3. Whether an operator can force-unlock a group from the dashboard. The
   admin page now SHOWS groups (`admin/sections/groups.js`) and deliberately
   has no button: a forced open is a second writer to the gate. What the
   operator CAN change is the wording of everything she says there
   (`admin/sections/templates.js`, since 2026-09-06).
4. **`retired` is never written.** Nothing detects her being removed from a
   group — the gateway raises no event we read — so a group she has left keeps
   its row, its agent and its admission until somebody notices. Harmless
   (nothing reaches her from a group she is not in) but it will not clean up
   after itself.
5. ~~An open group's agent has no working tools yet.~~ **Closed 2026-09-07.**
   A group token now resolves through its own door (`groups.resolveByToken`),
   never through `users.resolveByToken` — see "The group's own door" below.
6. A paused member is out of `groupAllowFrom` but still counts as *connected*
   by `isConnected` (a `user_id` and a `last_inbound_at`), so they can still be
   the reason a group opens while being unable to speak in it. Probably right,
   not decided.

## The group's own door (2026-09-07)

`users.resolveByToken` is "possession of this token IS this person", and the
one thing a group must never be is a person: a group agent that resolved to a
user would hold that user's tasks, facts, calendar and private chat inside a
room with other people in it. So there are two doors and they never meet.

- **Routing is by PREFIX, before either lookup.** `olma_grp_…` goes to
  `groups.resolveByToken`; everything else to the person's door. A truncated
  group token is therefore refused *as a group* — sent to the user door it
  would come back "unknown identity token" and send the model hunting for a
  file it does not have.
- **Only an OPEN group acts.** A locked group is muted at the gateway and has
  no agent, so this is unreachable today — which is why it is checked. The day
  the mute fails, the tools must not be what lets a room where somebody never
  signed up start reaching those people privately.
- **The acting member is chosen by the server.** `groups.actingMember` reads
  the last inbound the gateway filed for the group (`group_inbound_context`)
  and joins it to the group's own live membership. A group agent that could
  name its own actor could act as anybody in the room. Null — nothing filed,
  or the sender is not a member — is a real answer, and a caller that needs a
  person must refuse rather than pick one.
- **The audiences are disjoint and brokerd enforces it**: a group token on a
  person's tool and a person's token on a group tool are both refused at the
  call, each with an audit row (`group.tool_refused`). Every successful group
  call writes `group.tool` naming the member it acted for.

**The tool LIST is not the lock, and cannot be.** Measured on the box
2026-09-07: the gateway spawns the MCP child with `cwd=/root` and none of its
own environment (`PWD=/root` and nothing else in `/proc/<pid>/environ`), and
our agent entries carry no per-agent MCP scoping. The shim therefore cannot
know which agent it is answering, and serves every tool to everybody — so the
refusal has to live where the call runs. Group tools say `GROUP AGENTS ONLY`
in their first three words so a person's model does not reach for one, and the
group set is kept tiny because every schema is injected on every turn for
everybody (55k budget).

**The shim's identity repair is now kind-aware.** It replaces a *malformed*
token with one already proven on the same stdio connection; with two kinds of
token in the world, a connection that has proven both stops repairing
altogether. The hazard it was always guarding ("nothing here may bet on one
shim per session") stops being one person acting as another and becomes a
whole ROOM acting as one of the people in it.

## The trigger, wired (2026-09-07)

The engine was always going to be `domain/meetings.js`; this is the wiring, and
it is deliberately thin. `domain/group-meetings.js` has two functions and no
scheduling of its own.

- **A coordination belongs to the ROOM** (owner, 2026-09-07): `meetings.group_id`
  (migration 050) is the room, `initiator_id` is still the member who asked —
  somebody has to be able to settle it — and every sentence anybody is sent
  names the room, not that person. Since 2026-09-09 that is ALL it means for
  the table: any member in the coordination adds and removes candidate times,
  and nothing waits for the person who asked.
- **Inside a room the pairwise `meetings` grant is not asked for.** That is not
  a hole in the grant model, it is a different consent: everyone in an OPEN
  group has written to Olma privately, they are all in one visible room, and
  the request was made out loud in front of them. `startMeeting`'s `groupId`
  argument is the only path that skips the grant, it is reachable from no tool
  a person can call, and `group-meetings.js` builds its participant list from
  the live roster of an open group and nowhere else. Two of those members are
  still refused a private coordination with each other — proven in
  `tests/group-coordination.test.js`; the room did not become a connection.
- **One coordination per room at a time.** A second ask while one is running
  returns the running one with `created=false`. A room with two tables of times
  has no way to say which one it means.
- **A turn with no acting member starts nothing.** `groups.actingMember` is
  null when the gateway filed no sender or the sender is not a user; picking a
  member instead would put somebody's name on a decision they never made.
- **What crosses into the room and what does not.** `group_coordination_status`
  returns the options, each member's yes/no, and who has not answered at all —
  that IS the coordination, and a room that cannot see it cannot coordinate.
  It never selects `meeting_participants.constraints`: a reason is prose
  written in a private chat, and reading it out to a room is a different act
  from sharing it with one other participant.
- **The private question names the room.** `meeting_invite` gained
  `groupSubject`, and `channels/openclaw.js` says "the group X is coordinating
  Y — answers happen here, never in the group".

Two edges left open on purpose, both belonging to the cadence PR: the
downstream fan-outs (`meeting_slot_proposed` and the rest) still read as a
person-to-person meeting and lean on the TITLE to carry what it is about; and
the room hears nothing on its own — no start line, no progress, no
confirmation — until somebody tags her. Those are the five moments the owner
named, and they are built next.

## Two kinds of room, and what "enough people" means (2026-09-07)

The owner's third decision, and the one that needed a question asked out loud.
There are two kinds of group and Olma has to know which one she is in
(migration 051, `chat_groups.kind`):

- **`social`** — friends, work, family. Everyone is invited, there is no
  minimum, and the goal is a time that suits everybody. It may still happen
  with some of them if that is what they decide.
- **`game`** — padel, poker. Everyone is invited too, but the thing needs a
  MINIMUM to happen at all and may have a maximum; a room that says so can be
  closed the moment the maximum is reached (`close_at_target`).

**NULL is the third state and is never read as `social`.** A room nobody has
answered for is coordinated exactly as it was before the column existed, and
`groups.quorumFor` returns `known: false` with every other field null — not
"0 of 0", which a caller could read as a full house. There is simply no true
sentence about "enough people" available to say about that room.

**Where the question is asked, and why there.** In the ROOM, once ever, folded
into the line she already says when a coordination starts (`start_group_
coordination` → `hints.ask`, stamped by `kind_asked_at` whether or not anybody
answers). The three candidates were: privately to whoever invited her, in the
group, or something else. Privately loses on a fact: **we do not know who added
her.** `registered_by_user_id` is the lowest-id user on the roster, not the
inviter, and the gateway does not tell us. In the room wins on two more: the
answer is a fact ABOUT the room that anybody in it can correct, and at the
first coordination it is the first moment the answer changes anything, with the
room demonstrably listening. It costs one clause on a message she was sending
anyway.

**The minimum is a number they gave her, and she does not overrule it.**
`settle_group_coordination` refuses below it and says how many are short; the
room can lower the number (`set_group_kind` again) or wait. Both are decisions
for them.

**Closing from the room.** The coordination belongs to the room, so any member
may close it, in public, in front of everybody — that is the check a private
tool cannot have. Underneath, `options.settleNow` runs as the INITIATOR: the
room stands in for whoever holds that column, and the audit row
(`group.coordination_settled`) records who actually said it. The fan-out passes
`byName`/`groupSubject` and **no actor**, because the acting member is mid-turn
in the ROOM — with an actor they would be the one person never told privately,
and would be handed a calendar instruction their group agent cannot act on.

The dashboard's groups section gains exactly this one editable thing
(`POST /group-kind` → `groups.setKind`). State stays read-only there for the
reason it always has: the gate is the sweep's to decide.

## The three lines a room hears unasked (2026-09-07)

The owner named five moments a group hears from her: when she starts
coordinating, when she has a base, mid-way when she wants to speed it up, when
it succeeds, and reminders on the day. The first is her own turn — somebody
tagged her, the model answers — and the day-of reminders have a clock of their
own. The other three are `jobs/groups.sweepGroupVoice`, a MINUTE pass beside
the ten-second gate sweep, and `domain/group-voice.decideGroupLine` decides
which of them is due.

- **A base** is what she has when the leading option is a real plan: in a game,
  its own minimum; anywhere else, two people who can make the same time. One
  person agreeing with themselves is not a direction — the adder's own yes is
  recorded automatically, so `>= 1` would fire on every proposal.
- **The chase** names only people who have answered NOTHING. Somebody who said
  no has answered, and chasing them is asking them to change their mind in
  front of the room. It waits half the distance to the thing itself (clamped to
  between an hour and a day), so a game tomorrow is chased in hours and a
  dinner next month is not chased today.
- **Done** outranks both. A coordination that just settled makes "who has not
  answered" a wrong question, and the base of a plan that is already set is
  worse than silence.

Once each per COORDINATION, not per room (three columns on `meetings`,
migration 053) — a group that arranges padel every week hears all three again
next week, about the new one. Each waits for the group's own daytime through
the same `mayAnnounce` the opening announcement uses, and a line held at 02:00
stamps nothing, so it simply goes out in the morning. Every word is fixed text
on the raw pipe from `domain/message-templates.js`, rewordable by the owner
from the admin page, for the same reason the gate notices are: no model, so a
room whose members are slow costs nothing at all.

At most one line per room per pass. Two sentences in a row about the same plan
is a paragraph nobody asked for, and the second one keeps.

**The fifth moment — the two reminders (migration 054)** — rides the same pass
once the coordination is set: one on the morning of the day, one an hour
before. The nearer one wins when both are due, and the day-of line is skipped
entirely when the thing is less than three hours away, because "today" and "in
an hour" two hours apart is the room being nagged about a plan it made itself.
Neither is possible without a real `confirmed_start_at` — a slot that never
carried a moment cannot be reminded about, and inventing one would be worse
than silence. Both stop existing the moment the thing starts: a reminder that
arrives late is not a reminder. That is also what happens to an hour-before
line the group's quiet hours would hold past the event — it is never sent,
rather than sent at the wrong time.

## Everything she says to a room goes through a queue (2026-09-08)

The room read "יש! כולם כאן" twice on 2026-09-07, 28 seconds apart, because the
sweep sent first and stamped afterwards and a deploy restarted brokerd in
between (`incidents.md`, "The room was told twice"). The four unasked sentences
— introduction, opening, gate notice, coordination line — are now DECIDED and
DELIVERED by different jobs.

- `sweepGroups` / `sweepGroupVoice` enqueue a row and stamp their column **in
  one transaction**, and send nothing. `group_outbox` (migration 055) holds
  `kind` + `payload`, not text.
- `group_outbox` (the job, every 10s) renders each row from the owner's
  CURRENT wording and puts it on the raw pipe — same rule as the reminder
  rungs, so a sentence he rewords while a row is queued goes out in the new
  words.
- `idempotency_key` is UNIQUE and is the real guarantee: `g3:opened`,
  `g3:notice:2`, `g3:m18:base`. A lost stamp cannot produce the sentence twice.
- A claim is never handed back after a crash — the row is closed as
  `unconfirmed` two minutes on. A refusal the CLI actually made is retried
  once, then abandoned. `attempts` counts; `claimed_at` is the claim; they are
  two columns because one loses the count on every retry.

**A pass can no longer see what it just said**, and that is the standing cost
of the split. `groupOutbox.pending(client, groupId, 'intro')` is how the gate
sweep still knows not to nudge a room it introduced itself to on this very
pass.

The queue has no column that can name a person, and a test asserts it. That is
the whole argument for a second table rather than a `group_id` on `outbox`:
the user gate stays the only door to a human being, structurally rather than by
intention.

## The room is the conversation too (owner, 2026-09-08)

> "אם הם שלחו הודעה בקבוצה (לא משנה מה) אחרי שהתחיל התיאום זה אומר שהחלון של
> 15 דקות נפתח והיא יכולה לשלוח להם בנושא התיאום."

The first real group coordination reached nobody. מירון asked her, in the
room, to arrange something for the three of them; she said in the room that she
was asking everyone privately; עמית's invite was dropped as `quiet` and
מירון's was held as `night`. Both were writing in that room at the time.

So a member's message in the room opens the delivery gate's own fifteen-minute
window — the same one a DM opens, on the same argument: somebody who just spoke
is awake, and quiet hours are not protecting them from anything.

- The stamp is `chat_group_members.last_wrote_at` (migration 056), written by
  `groupContext.noteMemberWrote` in the same transaction as the context row.
- The worker fills `facts.groupWroteAt` **only** for a row whose payload names
  a meeting, whose meeting names a group, in which this person wrote **after
  the coordination started**. That query is the entire scope of the exception;
  the gate itself does not know what a meeting is.
- It releases `night` and it releases the `quiet` drop. It does not touch a
  pause, it does not touch `checkin_misses`, and it lets nothing else through:
  a connection request to the same person on the same tick is still dropped.

**What it cannot see.** A registered room is `requireMention: true`, so a
message that does not name her (or reply to her) is dropped by the gateway
before any hook of ours runs. Measured on the box 2026-09-08: in group 3, from
registration at 20:53 to 21:02, exactly two messages reached her — both naming
her, each one model run in `audit_events` — while the room went on talking. So
`last_wrote_at` records the messages she was ALLOWED to see, and its silence is
never evidence that somebody said nothing. Making it complete means
`requireMention: false` for the room, which is a model turn per message; the
owner has not asked for that and the token measurement argues against it.

## iMessage

Not available on this box. The official path is `@openclaw/imessage` driving
`steipete/imsg` over JSON-RPC, and `imsg` must run on a **Mac signed into
Messages.app** (Linux can only inspect a copied `chat.db` — no send, no watch).
The config keys are the same shape (`dmPolicy`, `groupPolicy`,
`groupAllowFrom`, `groups` with per-chat `requireMention`), so the design here
stays channel-agnostic — but shipping it means WhatsApp first, and a Mac (or an
SSH wrapper to one) before iMessage is anything but a plan.
