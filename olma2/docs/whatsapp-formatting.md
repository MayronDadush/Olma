# Text styling, per platform

The reference behind `src/domain/message-format.js`. The code is the source of
truth for what Olma actually emits; this file is why it emits it.

## The eight styles WhatsApp renders

Four have existed since the beginning (bold, italic, strikethrough,
monospace); four were added in February 2024 (bulleted list, numbered list,
block quote, inline code).

| Name | Hebrew | Syntax |
|---|---|---|
| Bold | מודגש | `*text*` |
| Italic | נטוי | `_text_` |
| Strikethrough | קו חוצה | `~text~` |
| Monospace | רוחב קבוע | three backticks on each side |
| Inline code | קוד מוטבע | one backtick on each side |
| Block quote | ציטוט | `> ` at the start of a line |
| Bulleted list | רשימת תבליטים | `- ` or `* ` at the start of a line |
| Numbered list | רשימה ממוספרת | `1. ` at the start of a line |

To see them rendered on a real phone:
`node scripts/send-formatting-sampler.js --user <id> --apply`. The message is
built from `message-format.STYLES`, so it cannot fall behind the table.

**There is nothing else.** No underline, no headings, no `[label](url)`, no
tables, no colour or size. A bare URL becomes clickable on its own; `#` and
`[…](…)` arrive as the literal characters, which is worse than not trying.

A URL stays tappable **inside** inline code too — checked on a real phone
2026-09-09, after this file claimed the opposite. It was wrong. We still send
links bare, because the owner prefers how they look, not because a styled one
would break.

## The four rules that bite

- **There is no escape character.** You cannot show a literal `*` next to bold
  text and be sure which is which. So a value we did not write — a task title
  is the person's own words — is *not wrapped* when it already contains the
  marker. `formatterFor(…).bold('חלב *דל לקטוז*')` returns it unchanged: the
  sentence loses its emphasis and stays correct, which is the right way round.
- **A marker must hug its text.** `* x *` renders as three literal characters,
  so surrounding whitespace stays outside the markers.
- **Inline emphasis does not survive a newline**, and a block quote is not
  carried over one either — every quoted line needs its own `> `.
- **Monospace and inline code combine with nothing.** Everything else nests:
  `*_both_*`. Nothing is interpreted inside monospace or code, which is the
  only way to display markup on WhatsApp at all — it is how the sampler shows
  each style's syntax.

## Why the platform is read at delivery

`user_channels.channel_type` defaults to `whatsapp` and nothing else has ever
been written, so "WhatsApp markup" and "our markup" have been the same thing.
`*טקסט*` is bold on WhatsApp, two asterisks on SMS, and something else again
on Telegram.

So a style is decided at DELIVERY, off the recipient's channel — the same rule
`proactive-text.localizedKey` already applies to the *language* of a reminder
rung, for the same reason: what a person can read is a property of who they
are and how they are reached, never of what was enqueued hours earlier.

A channel the table has never heard of gets **plain**, never WhatsApp's markup
on the assumption that it probably renders it. That is the honest third state,
and it is why `formatterFor()` with no argument styles nothing: a caller that
never learned the platform must not be handed WhatsApp by default.

## What this does not do

It builds formatted text; it does not parse it. Text the owner typed into the
admin page with markup in it (`message_templates`) passes through untouched,
so a second channel would receive his asterisks raw. Stripping them means
deciding where a `*` is a marker and where it is an asterisk somebody typed —
a guess nobody can check until a real second platform exists to check it
against. Named here rather than papered over with an untestable parser.

## The house style, decided by looking (2026-09-09)

Every style below WhatsApp renders; these are the ones Olma is allowed to use.
The decisions came from sending the real messages to a phone
(`scripts/send-format-preview.js`) rather than from arguing about a table.

- **Italic is not used at all.** In Hebrew the slant is barely visible and some
  devices render it badly. Seen side by side with English italic in one
  message; the answer was immediate. The capability table still says WhatsApp
  renders it — that is a fact about the platform, and this is a fact about us.
- **Monospace and inline code are not used** — including in the alarms that
  reach the owner rather than a user, which had been the one place a
  system-looking message would have been correct. Not wanted.
- **Links go bare**, for preference rather than for breakage (see above).
- **Emphasis somebody else typed is cleaned**, not passed through. See below.

## Emphasis the person typed

A task title is their words and may carry an asterisk, so `לקנות חלב *דל
לקטוז*` used to arrive with two words in bold that nobody chose. The owner's
call is to clean those markers: `message-format.stripUserMarkup`, applied on
the three verbatim paths where no model retypes the words — a reminder title
and every line of a batch, the slot text a room hears, and the name and reason
in the first message a stranger ever reads.

It is not `wrapInline`'s rule and does not replace it: that one refuses to ADD
emphasis to a value carrying a marker, this one removes emphasis the value
would produce on its own. Both stay.

The rule is deliberately narrow, because deleting a character out of somebody's
words is a thing you get to be wrong about once. A pair goes only when BOTH
markers sit at a word boundary — the shape of emphasis a person typed on
purpose. A marker glued inside a token is part of the token:
`report_final_v2`, `7~8 בערב` and `3 * 4 שולחנות` come through untouched, and
the test keeps them as the readings that rejected the blunter rule. The cost is
that a stray slant can survive a file name, which is the right way round.

The words in the table are never touched — this is a rendering decision, and
`tasks.title` still holds what they said.

## Where styling is and is not used today

- **Reminders and their rungs** (the raw pipe): the list form is a native
  WhatsApp list, and a `•` character on anything else. The sentences
  themselves are the owner's, from the admin page — markup he types there goes
  out as typed, which is how emphasis on a verbatim message is his to decide
  without a deploy.
- **Everything in a group**: fixed text, always WhatsApp by definition.
- **The morning digest is HYBRID since 2026-09-09** — the half that is the
  same every morning is drawn by code (`domain/digest-block.js`), handed to
  the model finished on `get_my_digest`'s result, and relayed character for
  character; the half that changes is the one sentence around it, which is
  what a model is actually for. The block reads the timezone and the locale
  off the person and the styling off their channel, so the layout cannot
  drift between two mornings and a task cannot go missing on the way through.
  A schedule CARD replaces the block above `digest_card_min_items` — never
  both, which would be the same morning twice. Eval
  `digest-block-relayed-untouched` is what checks the split survives contact
  with a real reply.
- **Everything a model writes**: styled where a RESULT says so, and nowhere
  else. `message-format.HINTS` holds the four sentences — list, numbered
  choice, struck out, quote their words — in one place so five tools cannot
  drift into five phrasings. They ride the tool result or the outbox
  instruction, never a tool description: a description is injected every turn
  for every user, a result costs tokens only on the turns it applies to.
  Wired into `list_my_tasks`, `list_my_reminders`, `my_calendar_events` and
  the digest (lists); `get_meeting_status` (numbering, and what left);
  `snooze_task` and `tasks_auto_archived` (what left); `relayed_message`,
  `connection_request`, `travel`, `live_update` and both meeting reasons
  (quote). Each fires only where it has work — two items before a list is
  worth laying out, two options before numbering means anything.
- **The doctrine line changed**, and had to. `agents-template.md` said "No
  markdown bold", and a result hint that contradicts an unconditional line of
  doctrine is *outvoted*, not ignored — that is the `markPlaced` fault, which
  cost two days. It now reads "*Bold* one thing at most, never a sentence;
  other styling only where a result asks", which is 84 characters against the
  18 it replaced and leaves 38 free of the gateway's 39,250.
- **What no test can tell you**: whether the model complies. These are
  instructions. `evals/scenarios.js` → `list-reads-as-a-list` is the only
  thing that actually looks at a reply, and it checks both directions — three
  tasks come back as three list lines, and emphasis stays at one span. A hint
  the model enjoys is worse than one it ignores.

Before 2026-09-09 everything a model wrote was unstyled.
