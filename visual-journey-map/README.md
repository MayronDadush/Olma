# visual-journey-map

Interactive documentation of Olma 2.0 — the WhatsApp assistant in `olma2/`.

Open it directly, no server or build step:

```bash
open visual-journey-map/index.html
```

Single self-contained file: embedded CSS, vanilla JS, no dependencies, no network calls.

## What's in it

| View | Content |
|---|---|
| Overview | Runtime architecture (clickable), the four load-bearing invariants, counts |
| Inbound turn | 13 steps, WhatsApp packet → reply, incl. the wedged-lane repair path |
| Onboarding | Stranger → silent greeter → provisioned (~1s) → welcome → day-one ladder |
| Proactive delivery | The 16 outbox kinds, the worker loop, the gate's 5 outcomes, the check-in rungs |
| State machines | connections · meetings · outbox rows · quota — the transitions enforced in code |
| Tool registry | All 43 MCP tools, filterable, with required args and handler target |
| Data model | 24 tables grouped, with the reasoning behind each |
| Jobs & health | The 12 brokerd timers, their intervals, and what "stale" vs "failing" mean |
| Design rules | Nine rules the code actually enforces, each linked to its source excerpt |

Every step, card and state machine opens a detail panel with the concrete file/line path,
the reads and writes it performs, and a real excerpt from the source.

## Keeping it accurate

The content is derived from `olma2/` at the time of writing — the `TURN`, `ONB`, `SM`, `TOOLS`,
`JOBS` and `SCHEMA` arrays near the top of the `<script>` block are the whole data model, and the
code excerpts live in the `<script id="snips" type="text/plain">` block (delimited by `::: <id>`
lines, so nothing needs escaping). Line references point at `olma2/` in this repo, not at
`/opt/olma2/` on the server.
