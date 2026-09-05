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

We already read the gateway's own storage server-side:
`olma2/src/channels/sessions.js` (dual-mode, files ≤2026.6.x / agent sqlite
≥2026.8.1). The group session's transcript carries the inbound
`Conversation info:` block verbatim, `group_members` included. brokerd parses
it there — no model in the trust path.

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
  missing members by name. Rate-limited per group, so a repeat-tagger cannot
  turn her into a spammer in someone else's group.

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

### Opening a group creates real connections (scope still open)

The owner's rule: the moment every member is connected and the group opens,
the members automatically become **connections of each other** in Olma with
full sharing, and they see a new group inside Olma for easy coordination.

The connection layer is a clean fit — it already is the base layer every
cross-user feature sits on, and joining a group plus each person DMing Olma is
an explicit act, not inferred closeness (which stays forbidden).

**Open:** auto-granting *all sharing capabilities* is the part to decide
deliberately. Grants are per-side, per-feature, by design; a 20-person work
group would mint 190 pairs with everything open, which nobody asked for
individually. Narrower default on the table: create the connection
automatically, leave per-feature grants at their normal defaults, and let the
new in-Olma group object carry the coordination powers (it is the natural
owner of "schedule something for these six people" anyway).

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
group, its subject and its roster are written to a transcript brokerd can read.
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

## Still open

1. Does the in-Olma group object own meetings/coordination directly, or is it
   a view over the existing pairwise connections?
2. Exact "has DM'd" predicate — `onboarded_at`, or a real inbound message.
3. Whether an operator can force-unlock a group from the dashboard.

## iMessage

Not available on this box. The official path is `@openclaw/imessage` driving
`steipete/imsg` over JSON-RPC, and `imsg` must run on a **Mac signed into
Messages.app** (Linux can only inspect a copied `chat.db` — no send, no watch).
The config keys are the same shape (`dmPolicy`, `groupPolicy`,
`groupAllowFrom`, `groups` with per-chat `requireMention`), so the design here
stays channel-agnostic — but shipping it means WhatsApp first, and a Mac (or an
SSH wrapper to one) before iMessage is anything but a plan.
