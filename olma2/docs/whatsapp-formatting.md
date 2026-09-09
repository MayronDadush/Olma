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

## Where styling is and is not used today

- **Reminders and their rungs** (the raw pipe): the list form is a native
  WhatsApp list, and a `•` character on anything else. The sentences
  themselves are the owner's, from the admin page — markup he types there goes
  out as typed, which is how emphasis on a verbatim message is his to decide
  without a deploy.
- **Everything in a group**: fixed text, always WhatsApp by definition.
- **Everything a model writes**: unstyled. `agents-template.md` says "No
  markdown bold", which is a deliberate voice decision, not an oversight — and
  reversing it belongs in that file, where the doctrine is at 39,229 of the
  39,250 characters the gateway will inject, so a sentence added there has to
  be paid for by deleting one.
