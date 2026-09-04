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

Enforcement is the config, not the prompt:

- **locked** → a `sendPolicy` deny rule keyed on the group's session-key
  prefix, so the turn runs, the transcript (and roster) is captured, and
  nothing is delivered.
- **unlocked** → the deny rule is removed.

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
