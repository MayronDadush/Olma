---
paths:
  - "olma2/src/jobs/**"
  - "olma2/src/domain/issues.js"
  - "olma2/src/domain/hebrew-quality.js"
  - "olma2/src/domain/onboarding-review.js"
  - "olma2/src/domain/reminder-promise.js"
  - "olma2/src/evals/**"
  - "olma2/scripts/run-evals.js"
---

# Writing detectors and alarms

Moved verbatim out of `CLAUDE.md` on 2026-09-11. The root file keeps every
rule's headline and points here for the body; the story behind each one is in
`olma2/docs/incidents.md`. **If this file and the server disagree, the server
wins.**

Was `CLAUDE.md`, "Writing detectors and alarms" — a comment anywhere in the repo citing that
title means this file. Grep the title, not the filename.

- **`BREAKS_USERS` means exactly "their tool calls fail right now."** Anything
  else is a dashboard row. Widening it makes the alert list mean two things,
  which is how an alert list dies.

- **A hint that fires on ordinary input is worse than no hint** — it costs
  tokens on every turn it does not apply to and teaches the model to skim past
  hints, including the ones that matter. Measure a new pattern against real
  data before shipping it, and keep the readings you REJECTED in the test with
  the real rows that killed them (`tasks.joinsTwoAsks`, checked against all
  202 production titles; `incidents.md`, "Two asks, one task").

- **Her voice is checked by code, not by the judge.** `domain/hebrew-quality.
  flawsIn` is the one list of what a slip is — a masculine self-reference
  ("אני מבין", "מצטער, יובל"), the model's own markup or a token in a
  sentence — read by the eval check `scenarios.herOwnVoice` (red on every
  scenario) and by the daily count on the dashboard. Measured on 383 real
  messages before shipping: 10 hits, 10 real. Extend the list there and
  re-measure; `רואה` is what a false positive looks like (same in both
  genders), and the forms that do not change are left out on purpose.

- **An issue title must be deterministic** — it is the dedup key. A title built
  from unordered query results makes the guard file and close the same
  condition on alternating ticks.

- **A ratio's numerator and its denominator must describe the SAME people, and
  the eval user is in neither.** `users.is_eval` traffic is a benchmark whose
  cost per message is a property of whatever model is on trial, so it enters
  and leaves every metric TOGETHER — dropping it from one side alone builds the
  mirror-image fault. `efficiency-watch` had it in both halves and read
  2026-09-08 as $0.0411/message against a $0.0155 baseline, when real users
  were 52 messages at $0.0179 — 1.13x their own baseline — and the advice that
  came back was to trim the conversation history real users get, to pay for a
  pilot. **Its EVIDENCE query has to move with it**: a model list drawn from a
  population no ratio covers is what ranked deepseek-v4-flash third and got it
  blamed. And the excluded spend still has to be printed somewhere unratio'd
  (`evalCost`), or the fix is the other failure — $4 a day that no number can
  see (`incidents.md`, "The pilot that read as an expensive day"). Nothing else
  on the cost path filters `is_eval`, and for the dashboard's cost pages that
  is arguably right: they answer "what did we spend", not "how efficient are
  we". Know which question the number you are writing answers.

- **A thing that could not be READ is never a thing in trouble.** An unreadable
  config, a failed billing API, a missing log: report it in the heartbeat, file
  nothing, alert nobody.

- **But a check that goes quiet is indistinguishable from one that passes** —
  so every path that declines to judge must say so somewhere.

- **Stamp "we told them" only after the send confirms.** Stamping first makes
  an outage swallow the alert for exactly the outage it exists to report.

- **A joiner nobody has reached is asked about as a PERSON, not a config.**
  `config_guard.checkUnreachableJoiners`: onboarded a day ago or more,
  nothing ever delivered to them (a `sent_at` row with no `hold_reason`) and
  nothing ever received. That catches a dead-from-birth agent, a dropped
  binding and the next silent failure of the same shape alike. Dashboard row,
  not `BREAKS_USERS`. It is the opposite of `isDeafOnDayOne`, which needs two
  onboarding messages to have LANDED and then sends less.

- **Every check that starts from `users` is blind to the person the gateway
  dropped**, because they never became a row.
  `config_guard.checkUnansweredStrangers` starts from the gateway's ingress
  queue instead (`sessions.listInboundPeers`) and reports a lane with neither
  a session nor a user row after 30 minutes. **The discriminator is the
  SESSION** — a stranger the intake greeter answered has one and no user row
  by design, and counting them would make the check red whenever registration
  is closed. Dashboard row; no upper window (it closes when they get a user
  row, not when we get bored). **The ingress queue is not a message log** —
  Olma's own replies are queued on the same lane and a completed row keeps
  nothing that tells them apart, so it answers "has this lane ever been heard
  from" and nothing quantitative (`incidents.md`, "A message reached the box
  and stopped there").

- **`liveness_watch` repairs before it reports.** Every five minutes: gateway
  probe and delivery queue; two bad ticks before a word; a gateway down for
  two ticks is restarted (`intake/gateway-restart.js`, once per half hour) and
  probed again; the news goes over WhatsApp — healed, stuck deliveries, or
  recovered — and a message that could not go out is `alertFailed` on the
  heartbeat. State in the `liveness_state` flag so a restart mid-outage does
  not re-alert. It speaks over the gateway's own pipe (owner's choice, no
  SMS), so a gateway that stays dead is repaired from here but reported only
  by the external monitor.

- **A new person's first hours are read back by code TWICE — three hours in,
  and again after their first day** (`jobs/onboarding-review.js`, `STAGES`; the
  checks are pure, in `domain/onboarding-review.js`). It never messages them —
  it files one row per person per stage, clean ones included, because a review
  that only appears when something is wrong cannot tell you the rate. A `bad`
  verdict means somebody was told something untrue or got no answer: a
  dashboard row and an alerts pill until acknowledged, never `BREAKS_USERS`.
  **Both stages start at their first message and only the END moves** — several
  checks hold something said late against a reminder armed early — so the day
  read sees everything the early one saw and files only what is NEW. There are
  two stages because four checks written from Yahav's second day fire at 3.7 to
  13 hours in and, at three hours, not one of them could ever have fired.
  **Adding a check means adding its failing case to
  `tests/onboarding-review.test.js`** — the founding case is Yahav's real
  evening, replayed end to end, and a check whose failure cannot be written
  down is one nobody will trust in six weeks.

- **The onboarding review only ever watches the FRONT DOOR; `promise_watch`
  watches everyone.** A new person's first hours are read back twice (above);
  every ACTIVE person is asked once a day whether the moment they named is the
  moment that got armed (`jobs/promise-watch.js`, the pure half in
  `domain/reminder-promise.js`). Miron hit the promised-hour fault weeks into
  his life here and nothing saw it for six hours. **It reads THEIR message, not
  Olma's** — "the meeting is at 19:00, I'll remind you" is ambiguous prose no
  regex should judge, "תזכיר לי ב-19:00" has one correct outcome — and it
  judges only when BOTH halves are visible: a moment they named, and a reminder
  armed within five minutes in response. Nothing armed at all is three
  different stories and is never reported. It files an `issues` row keyed on a
  deterministic title carrying the message timestamp, so re-reading the
  overlapping window cannot file twice.

- **The suite runs again on a schedule, at four hours of the day**
  (`.github/workflows/olma2-clock-drift.yml`) — no deploy job, its own
  concurrency group so it can never displace a merge's queued deploy. A red
  there means a test means something different at that hour: broken, not
  flaky, and never to be re-run until green. **Do not replace this with a
  clock-shifting preload or a scan for near-today date literals** — both were
  built and thrown away on 2026-09-06, because the first invents a JS/Postgres
  skew production never has (29 false failures) and the second flags the very
  pattern the rule recommends (180 literals, most of them correct).

- **`/health` sees the DB, every `job_heartbeats` row, and the gateway — and
  nothing else.** A component that writes no heartbeat is invisible to it, and
  says so by staying green. That is how the gateway went unwatched for months
  while sixteen sweeps beside it were checked every minute.
